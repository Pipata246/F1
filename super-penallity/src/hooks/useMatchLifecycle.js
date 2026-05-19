import { useCallback } from 'react';
import { apiPost } from '../lib/api.js';

// Lifecycle действия PvP-матча: вход в матчмейкинг, старт демо с ботом, отмена ожидания,
// «играть снова», выход в меню.
//
// Хук намеренно «толстый» по API: эти действия координируют 20+ refs и 15+ state setters,
// которые остаются в GamePage. Альтернатива была бы перенести всё это вместе с lifecycle —
// слишком инвазивно для одной итерации.
export function useMatchLifecycle(deps) {
  const {
    // values
    displayName,
    askStakeOptions,
    // refs из других хуков
    initDataRef,
    // PvP refs
    pvpRoomIdRef,
    matchEndedRef,
    matchSavedRef,
    matchRef,
    pvpLastRoundMarkerRef,
    pvpLastStartKeyRef,
    pvpMoveCommittedRef,
    lastSubmittedZoneRef,
    selectedZoneRef,
    lastAppliedUpdatedAtRef,
    turnIdRef,
    lastAnimSignatureRef,
    animTimersRef,
    pvpFindRetryTimerRef,
    localFindTimerRef,
    playModeRef,
    playerIndexRef,
    // setters UI
    setSelectedStakeOptions,
    setCurrentStakeTon,
    setSelectedZone,
    setConfirmedZone,
    setZoneLocked,
    setShowingResult,
    setResultMessage,
    setOpponent,
    setPlayerIndex,
    setScores,
    setRound,
    setMaxRounds,
    setSuddenDeath,
    setSuddenDeathStartRound,
    setHistory,
    setMatchResult,
    setScreen,
    // callbacks
    showBottomNotice,
    startPvpPolling,
    stopPvpPolling,
    applyPvpRoomState,
    handleServerMessage,
  } = deps;

  // Сбрасывает все state'ы и refs к чистому состоянию перед началом нового матча.
  // Дублирующая часть между startSearchOnline и startSearchBot.
  const resetMatchState = useCallback(() => {
    matchEndedRef.current = false;
    matchSavedRef.current = false;
    pvpLastRoundMarkerRef.current = 0;
    pvpLastStartKeyRef.current = '';
    pvpMoveCommittedRef.current = false;
    lastSubmittedZoneRef.current = null;
    selectedZoneRef.current = null;
    lastAppliedUpdatedAtRef.current = 0;
    lastAnimSignatureRef.current = '';
    animTimersRef.current.forEach((t) => clearTimeout(t));
    animTimersRef.current = [];
    turnIdRef.current = '';
    setSelectedZone(null);
    setConfirmedZone(null);
    setZoneLocked(false);
    setShowingResult(false);
    setResultMessage(null);
  }, [
    matchEndedRef, matchSavedRef, pvpLastRoundMarkerRef, pvpLastStartKeyRef,
    pvpMoveCommittedRef, lastSubmittedZoneRef, selectedZoneRef, lastAppliedUpdatedAtRef,
    lastAnimSignatureRef, animTimersRef, turnIdRef,
    setSelectedZone, setConfirmedZone, setZoneLocked, setShowingResult, setResultMessage,
  ]);

  const startSearchOnline = useCallback(() => {
    const name = (displayName || '').trim() || 'Player';
    const stakes = askStakeOptions();
    if (!stakes) return;
    initDataRef.current = window.Telegram?.WebApp?.initData || initDataRef.current || '';
    setSelectedStakeOptions(stakes);
    setCurrentStakeTon(null);
    resetMatchState();
    pvpRoomIdRef.current = null;
    stopPvpPolling();
    if (pvpFindRetryTimerRef.current) {
      clearTimeout(pvpFindRetryTimerRef.current);
      pvpFindRetryTimerRef.current = null;
    }
    if (localFindTimerRef.current) {
      clearTimeout(localFindTimerRef.current);
      localFindTimerRef.current = null;
    }
    matchRef.current = null;

    playModeRef.current = 'pvp';
    if (!initDataRef.current) {
      playModeRef.current = 'idle';
      showBottomNotice('Нет Telegram-сессии. Открой игру через Telegram.');
      setScreen('stake-online');
      return;
    }
    setScreen('waiting');
    apiPost({
      action: 'pvpFindMatch',
      initData: initDataRef.current || '',
      gameKey: 'super_penalty',
      playerName: name,
      stakeOptions: stakes,
    })
      .then((data) => {
        if (playModeRef.current !== 'pvp') return;
        if (!data?.ok || !data.room) throw new Error(String(data?.error || 'matchmaking'));
        pvpRoomIdRef.current = data.room.id;
        startPvpPolling();
        if (data.room) applyPvpRoomState(data.room);
      })
      .catch((err) => {
        playModeRef.current = 'idle';
        showBottomNotice(String(err?.message || '').trim() || 'Не удалось начать поиск. Попробуй снова.');
        setScreen('stake-online');
      });
  }, [
    displayName, askStakeOptions, initDataRef, pvpRoomIdRef, matchRef, playModeRef,
    pvpFindRetryTimerRef, localFindTimerRef,
    setSelectedStakeOptions, setCurrentStakeTon, setScreen,
    showBottomNotice, startPvpPolling, stopPvpPolling, applyPvpRoomState,
    resetMatchState,
  ]);

  const startSearchBot = useCallback(() => {
    // Локальная демо-игра с ботом (без ставок, без бэкенда).
    playModeRef.current = 'demo-bot';
    resetMatchState();
    setOpponent('Бот 🤖');
    setPlayerIndex(0);
    playerIndexRef.current = 0;
    setScores([0, 0]);
    setRound(0);
    setMaxRounds(5);
    setSuddenDeath(false);
    setSuddenDeathStartRound(0);
    setHistory([]);
    setScreen('game');
    setTimeout(() => {
      handleServerMessage({
        type: 'round_start',
        round: 1,
        maxRounds: 5,
        role: 'kicker',
        scores: [0, 0],
        suddenDeath: false,
        history: [],
      });
    }, 500);
  }, [
    playModeRef, playerIndexRef, resetMatchState,
    setOpponent, setPlayerIndex, setScores, setRound, setMaxRounds,
    setSuddenDeath, setSuddenDeathStartRound, setHistory, setScreen,
    handleServerMessage,
  ]);

  const handleCancelWait = useCallback(() => {
    if (pvpFindRetryTimerRef.current) {
      clearTimeout(pvpFindRetryTimerRef.current);
      pvpFindRetryTimerRef.current = null;
    }
    if (localFindTimerRef.current) {
      clearTimeout(localFindTimerRef.current);
      localFindTimerRef.current = null;
    }
    const mode = playModeRef.current;
    if (mode === 'pvp') {
      const rid = pvpRoomIdRef.current;
      pvpRoomIdRef.current = null;
      if (rid && initDataRef.current) {
        const payload = JSON.stringify({
          action: 'pvpCancelQueue',
          initData: initDataRef.current,
          roomId: rid,
        });
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon('/api/user', new Blob([payload], { type: 'application/json' }));
          }
        } catch {}
        fetch('/api/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
      stopPvpPolling();
    }
    playModeRef.current = 'idle';
    const tg = window.Telegram?.WebApp;
    if (tg) tg.disableClosingConfirmation();
    window.location.replace('/');
  }, [
    initDataRef, pvpRoomIdRef, playModeRef,
    pvpFindRetryTimerRef, localFindTimerRef,
    stopPvpPolling,
  ]);

  const handlePlayAgain = useCallback(() => {
    const wasDemo = playModeRef.current === 'demo-bot';
    setMatchResult(null);
    setHistory([]);
    if (wasDemo) startSearchBot();
    else startSearchOnline();
  }, [playModeRef, setMatchResult, setHistory, startSearchBot, startSearchOnline]);

  const handleExitToMenu = useCallback(() => {
    if (pvpFindRetryTimerRef.current) {
      clearTimeout(pvpFindRetryTimerRef.current);
      pvpFindRetryTimerRef.current = null;
    }
    if (localFindTimerRef.current) {
      clearTimeout(localFindTimerRef.current);
      localFindTimerRef.current = null;
    }
    playModeRef.current = 'idle';
    matchRef.current = null;
    setMatchResult(null);
    setHistory([]);
    stopPvpPolling();
    pvpRoomIdRef.current = null;
    const tg = window.Telegram?.WebApp;
    if (tg) tg.disableClosingConfirmation();
    window.location.replace('/');
  }, [
    playModeRef, matchRef, pvpRoomIdRef,
    pvpFindRetryTimerRef, localFindTimerRef,
    stopPvpPolling, setMatchResult, setHistory,
  ]);

  return {
    startSearchOnline,
    startSearchBot,
    handleCancelWait,
    handlePlayAgain,
    handleExitToMenu,
    resetMatchState,
  };
}
