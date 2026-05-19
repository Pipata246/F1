import { useCallback } from 'react';

// Преобразует room.state_json от сервера в события для handleServerMessage:
//   match_over   → match_result
//   accept_match → screen='waiting' + acceptInfo
//   waiting      → screen='waiting'
//   turn_input   → round_start (если startKey сменился)
//   lastRoundResult.marker > previous → round_result
//
// Гарантирует идемпотентность через 3 guard'а:
//   stale-guard:    updated_at не меньше последнего применённого
//   marker-guard:   lastRoundResult.marker строго больше предыдущего
//   startKey-guard: round:role:sudden — уникальный ключ начала раунда
//
// Возвращает applyPvpRoomState — стабильный useCallback. handleServerMessage и stopPvpPolling
// должны быть стабильны у вызывающего, иначе callback пересоздаётся.
export function useApplyRoomState({
  // refs
  matchEndedRef,
  lastAppliedUpdatedAtRef,
  pvpRoomIdRef,
  pvpOpponentTgIdRef,
  pvpOpponentIsBotRef,
  pvpLastRoundMarkerRef,
  pvpLastStartKeyRef,
  pvpMoveCommittedRef,
  selectedZoneRef,
  lastSubmittedZoneRef,
  turnIdRef,
  showingResultRef,
  playerIndexRef,
  // setters UI
  setAcceptInfo,
  setScreen,
  setPlayerIndex,
  setOpponent,
  setCurrentStakeTon,
  setConfirmedZone,
  setSelectedZone,
  setMatchResult,
  // callbacks
  stopPvpPolling,
  handleServerMessage,
}) {
  const applyPvpRoomState = useCallback((room) => {
    if (!room) return;
    if (matchEndedRef.current) return; // не реагируем на запоздалые ответы после окончания
    // A4: игнорируем stale ответы. Если incoming updated_at не больше последнего применённого —
    // это out-of-order или дубликат. Marker/startKey-guards защитят ниже, но stale-guard
    // предотвращает лишние setState и render'ы.
    const incomingMs = Number(new Date(room.updated_at || 0).getTime()) || 0;
    if (incomingMs > 0 && incomingMs < lastAppliedUpdatedAtRef.current) return;
    if (incomingMs > 0) lastAppliedUpdatedAtRef.current = incomingMs;
    const s = room.state_json || {};

    const matchOver = String(room.status) === 'finished'
      || String(room.status) === 'cancelled'
      || String(s.phase || '') === 'match_over';

    if (matchOver) {
      // Идемпотентность завершения матча инкапсулирована в case 'match_result'.
      // Здесь только готовим данные и единожды вызываем — без двойного cleanup'а.
      if (matchEndedRef.current) return;

      const myTg = String(window.Telegram?.WebApp?.initDataUnsafe?.user?.id || '');
      const meIsP1 = String(room.player1_tg_user_id || '') === myTg;
      const mySide = meIsP1 ? 'p1' : 'p2';
      const myIdx = meIsP1 ? 0 : 1;

      const scoresObj = s.scores || { p1: 0, p2: 0 };
      const arr = [Number(scoresObj.p1 || 0), Number(scoresObj.p2 || 0)];
      let youWon = false;
      if (s.winnerSide) youWon = s.winnerSide === mySide;
      else if (arr[0] !== arr[1]) youWon = myIdx === 0 ? arr[0] > arr[1] : arr[1] > arr[0];

      if (s.endedByLeave && s.leftBy && String(s.leftBy) !== myTg && String(s.leaveKind || '') === 'explicit') {
        // Спец-кейс: оппонент явно вышел — показываем result сразу как «оппонент вышел».
        matchEndedRef.current = true;
        stopPvpPolling();
        pvpRoomIdRef.current = null;
        try { sessionStorage.removeItem('sp_active_room'); } catch {}
        setMatchResult({ youWon: true, scores: arr, opponentLeft: true });
        setScreen('result');
        return;
      }

      handleServerMessage({ type: 'match_result', youWon, scores: arr });
      return;
    }

    if (String(room.status) === 'active' && String(s.phase || '') === 'accept_match') {
      const am = s.acceptMatch || {};
      const deadlineMs = Number(am.deadlineMs || 0);

      // Timer expired but still in accept_match — wait for backend to transition.
      if (deadlineMs > 0 && Date.now() >= deadlineMs) {
        setScreen('waiting');
        return;
      }

      setAcceptInfo({
        p1: room.player1_name || 'Игрок 1',
        p2: room.player2_name || 'Игрок 2',
        stake: room.stake_ton != null ? Number(room.stake_ton) : null,
        deadlineMs,
      });
      setScreen('waiting');
      return;
    }
    if (String(room.status) === 'waiting') {
      setAcceptInfo(null);
      setScreen('waiting');
      return;
    }
    if (String(room.status) === 'active') {
      const p2 = room.player2_tg_user_id;
      if (p2 == null || p2 === '') {
        setScreen('waiting');
        return;
      }
    }
    const myTg = String(window.Telegram?.WebApp?.initDataUnsafe?.user?.id || '');
    const meIsP1 = String(room.player1_tg_user_id || '') === myTg;
    const mySide = meIsP1 ? 'p1' : 'p2';
    const myIdx = meIsP1 ? 0 : 1;
    pvpOpponentTgIdRef.current = meIsP1 ? String(room.player2_tg_user_id || '') : String(room.player1_tg_user_id || '');
    pvpOpponentIsBotRef.current = pvpOpponentTgIdRef.current.startsWith('bot_fallback_');

    // Only transition to game screen if we're past accept phase.
    if (s.phase === 'accept_match') return;

    setScreen('game');
    setAcceptInfo(null);
    setPlayerIndex(myIdx);
    playerIndexRef.current = myIdx;
    setOpponent(meIsP1 ? (room.player2_name || 'Соперник') : (room.player1_name || 'Соперник'));
    setCurrentStakeTon(room.stake_ton != null ? Number(room.stake_ton) : null);

    // A3: синхронизируем turnId из сервера
    if (s.turnId) turnIdRef.current = String(s.turnId);

    // A1: серверно-подтверждённая зона текущего раунда (если игрок уже отправил ход).
    // КРИТИЧНО: Number(null) === 0 в JS — проверяем null/undefined ЯВНО до конверсии,
    // иначе любое отсутствующее значение даёт zone=0 (левая верхняя) и подсвечивает её.
    const choicesObj = s.choices || {};
    const myChoiceRaw = choicesObj[mySide];
    if (myChoiceRaw !== null && myChoiceRaw !== undefined) {
      const cz = Number(myChoiceRaw);
      if (Number.isInteger(cz) && cz >= 0 && cz <= 3) {
        setConfirmedZone(cz);
      }
    }

    const rr = s.lastRoundResult || {};
    const marker = Number(rr.marker || 0);
    if (marker > pvpLastRoundMarkerRef.current) {
      pvpLastRoundMarkerRef.current = marker;
      // A1: при round_result закрепляем confirmedZone на финальной зоне игрока.
      const rrKickerIdx = Number(rr.kickerIndex || 0);
      const myRaw = rrKickerIdx === myIdx ? rr.kickerZone : rr.keeperZone;
      let myZoneInResult = null;
      if (myRaw !== null && myRaw !== undefined) {
        const n = Number(myRaw);
        if (Number.isInteger(n) && n >= 0 && n <= 3) myZoneInResult = n;
      }
      if (myZoneInResult !== null) setConfirmedZone(myZoneInResult);
      const scoresObj = rr.scores || { p1: 0, p2: 0 };
      const finalScores = [Number(scoresObj.p1 || 0), Number(scoresObj.p2 || 0)];
      handleServerMessage({
        type: 'round_result',
        kickerZone: Number(rr.kickerZone || 0),
        keeperZone: Number(rr.keeperZone || 0),
        isGoal: !!rr.isGoal,
        scores: finalScores,
        round: Number(rr.round || 0),
        kickerIndex: rrKickerIdx,
        history: Array.isArray(rr.history) ? rr.history : [],
        startSuddenDeath: !!rr.startSuddenDeath,
        autoFilledSides: Array.isArray(rr.autoFilledSides) ? rr.autoFilledSides : [],
        mySide,
        // Финальный раунд — пробрасываем явный флаг и победителя для client watchdog'а
        gameOver: !!rr.gameOver,
        winnerSide: rr.winnerSide || null,
      });
      return;
    }

    if (s.phase === 'turn_input') {
      // Если в данный момент проигрывается анимация результата раунда — не начинаем новый раунд
      // до её завершения. Это предотвращает «скачок» вратаря и роли посередине удара.
      if (showingResultRef.current) return;
      const baseRound = Number(s.round || 0);
      const sudden = !!s.suddenDeath;
      const kickerIndex = sudden && Number.isInteger(Number(s.kickerOverride))
        ? Number(s.kickerOverride)
        : (baseRound % 2 === 0 ? 0 : 1);
      const roleNow = kickerIndex === myIdx ? 'kicker' : 'keeper';
      const startKey = `${baseRound}:${roleNow}:${sudden ? 1 : 0}`;
      if (startKey !== pvpLastStartKeyRef.current) {
        pvpLastStartKeyRef.current = startKey;
        pvpMoveCommittedRef.current = false;
        setSelectedZone(null);
        selectedZoneRef.current = null;
        setConfirmedZone(null);
        lastSubmittedZoneRef.current = null;
        const scoresObj = s.scores || { p1: 0, p2: 0 };
        handleServerMessage({
          type: 'round_start',
          round: baseRound + 1,
          maxRounds: Number(s.maxRounds || 10),
          role: roleNow,
          scores: [Number(scoresObj.p1 || 0), Number(scoresObj.p2 || 0)],
          suddenDeath: sudden,
          history: Array.isArray(s.history) ? s.history : [],
          // phaseAtMs (серверная отметка начала turn_input) для синхронизации таймера
          phaseAtMs: Number(s.phaseAtMs || 0),
        });
      }
    }
  }, [
    matchEndedRef, lastAppliedUpdatedAtRef, pvpRoomIdRef,
    pvpOpponentTgIdRef, pvpOpponentIsBotRef, pvpLastRoundMarkerRef,
    pvpLastStartKeyRef, pvpMoveCommittedRef, selectedZoneRef,
    lastSubmittedZoneRef, turnIdRef, showingResultRef, playerIndexRef,
    setAcceptInfo, setScreen, setPlayerIndex, setOpponent, setCurrentStakeTon,
    setConfirmedZone, setSelectedZone, setMatchResult,
    stopPvpPolling, handleServerMessage,
  ]);

  return { applyPvpRoomState };
}
