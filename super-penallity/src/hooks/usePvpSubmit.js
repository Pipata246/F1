import { useRef, useCallback, useEffect } from 'react';
import { apiPost } from '../lib/api.js';

const MAX_ATTEMPTS = 3;
// H: exponential backoff — 400, 800, 1600мс. На загруженном сервере не давим, на быстром
// почти то же. Раньше был фиксированный 400мс на каждый retry.
const RETRY_DELAYS_MS = [400, 800, 1600];
const WATCHDOG_DELAY_MS = 4000;
const WATCHDOG_NOTICE_DELAY_MS = 2000;

// PvP submit-ветка sendMessage: отправляет pvpSubmitMove с turnId-guard, retry до 3 попыток,
// watchdog который форсит дополнительные polls если сервер не отвечает за 4 сек.
//
// pvpMoveWatchdogTimerRef экспонируется наружу, чтобы handleServerMessage (round_start/
// round_result/match_result) и lifecycle reset могли его чистить.
export function usePvpSubmit({
  // refs
  pvpRoomIdRef,
  initDataRef,
  pvpMoveCommittedRef,
  lastSubmittedZoneRef,
  selectedZoneRef,
  turnIdRef,
  // setters
  setSelectedZone,
  setZoneLocked,
  setWaitingOpponent,
  // callbacks
  stopTimer,
  enableFastPolling,
  pvpPollState,
  applyPvpRoomState,
  showBottomNotice,
}) {
  const pvpMoveWatchdogTimerRef = useRef(null);

  const clearMoveWatchdog = useCallback(() => {
    if (pvpMoveWatchdogTimerRef.current) {
      clearTimeout(pvpMoveWatchdogTimerRef.current);
      pvpMoveWatchdogTimerRef.current = null;
    }
  }, []);

  // Отмена ожидания (cancel_wait) — посылает pvpLeaveRoom для текущей room и обнуляет
  // pvpRoomIdRef, чтобы дальнейшие poll'ы её не трогали.
  const cancelPvpWait = useCallback(() => {
    if (!pvpRoomIdRef.current || !initDataRef.current) return;
    const rid = pvpRoomIdRef.current;
    pvpRoomIdRef.current = null;
    apiPost({
      action: 'pvpLeaveRoom',
      initData: initDataRef.current,
      roomId: rid,
    }).catch(() => {});
  }, [pvpRoomIdRef, initDataRef]);

  const submitPvpZone = useCallback((zoneRaw) => {
    if (!pvpRoomIdRef.current || !initDataRef.current) return;
    const zone = Number(zoneRaw);
    if (![0, 1, 2, 3].includes(zone)) return;

    // Atomic anti-duplicate через ref. React state-flag zoneLocked в этой же transaction
    // может быть stale, если функция вызвана из setInterval-замыкания или batched click.
    if (lastSubmittedZoneRef.current !== null && lastSubmittedZoneRef.current !== undefined) return;
    lastSubmittedZoneRef.current = zone;
    // Синхронизируем selectedZoneRef — мишень и серверная зона должны указывать на одно
    if (selectedZoneRef.current === null || selectedZoneRef.current === undefined) {
      selectedZoneRef.current = zone;
      setSelectedZone(zone);
    }

    setZoneLocked(true);
    setWaitingOpponent(true);
    stopTimer();
    enableFastPolling(); // ускоряем polling чтобы быстрее получить round_result

    let attempts = 0;

    const submit = () => {
      if (pvpMoveCommittedRef.current) return;
      const attemptIdx = attempts;
      attempts++;
      apiPost({
        action: 'pvpSubmitMove',
        initData: initDataRef.current,
        roomId: pvpRoomIdRef.current,
        // A3: turnId связывает submit с конкретным раундом — сервер отвергнет stale
        move: { zone, turnId: turnIdRef.current || undefined },
      }).then((data2) => {
        if (pvpMoveCommittedRef.current) return;
        if (data2?.ok) {
          pvpMoveCommittedRef.current = true;
          // C: НЕ делаем дополнительный poll через 200мс — enableFastPolling уже запустил
          // interval 400мс, первый poll принесёт ход бота в обычном темпе. Старый extra-poll
          // создавал лишний запрос в первые ~400мс после submit (вместе с handleRoundResult
          // safetyTimeout, watchdog'ом и интервалом получалось 3-4 polls в первые 600мс).
          if (data2.room) applyPvpRoomState(data2.room);
          return;
        }
        const err = String(data2?.error || '');
        if (err === 'STALE_TURN') {
          // A3: submit пришёл уже после смены раунда — тихо игнорируем, poll принесёт актуальный state
          pvpMoveCommittedRef.current = true;
          pvpPollState();
          return;
        }
        if (attempts < MAX_ATTEMPTS) setTimeout(submit, RETRY_DELAYS_MS[attemptIdx] || 1600);
        else showBottomNotice('Сервер обрабатывает... Подожди соперника.');
      }).catch(() => {
        if (pvpMoveCommittedRef.current) return;
        if (attempts < MAX_ATTEMPTS) setTimeout(submit, RETRY_DELAYS_MS[attemptIdx] || 1600);
        else showBottomNotice('Сервер обрабатывает... Подожди соперника.');
      });
    };
    submit();

    // Watchdog: если за 4 сек не пришло подтверждение от сервера — форсим дополнительные polls.
    // Через 6 сек после ещё непришедшего ответа — показываем notice. UI остаётся залоченным.
    clearMoveWatchdog();
    pvpMoveWatchdogTimerRef.current = setTimeout(() => {
      if (pvpMoveCommittedRef.current || !pvpRoomIdRef.current || !initDataRef.current) return;
      pvpPollState();
      setTimeout(() => pvpPollState(), 400);
      setTimeout(() => {
        if (!pvpMoveCommittedRef.current) showBottomNotice('Сервер не отвечает... Ждём.');
      }, WATCHDOG_NOTICE_DELAY_MS);
    }, WATCHDOG_DELAY_MS);
  }, [
    pvpRoomIdRef, initDataRef, pvpMoveCommittedRef, lastSubmittedZoneRef, selectedZoneRef,
    turnIdRef, setSelectedZone, setZoneLocked, setWaitingOpponent,
    stopTimer, enableFastPolling, pvpPollState, applyPvpRoomState, showBottomNotice,
    clearMoveWatchdog,
  ]);

  // Auto-cleanup на unmount: останавливаем watchdog'а если он висит.
  useEffect(() => () => {
    if (pvpMoveWatchdogTimerRef.current) {
      clearTimeout(pvpMoveWatchdogTimerRef.current);
      pvpMoveWatchdogTimerRef.current = null;
    }
  }, []);

  return {
    submitPvpZone,
    cancelPvpWait,
    clearMoveWatchdog,
    pvpMoveWatchdogTimerRef,
  };
}
