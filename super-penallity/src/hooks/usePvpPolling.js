import { useCallback, useEffect, useRef } from 'react';

// Интервалы polling: обычный (idle/turn_input) и быстрый (после хода/round_result/match_over).
const PVP_POLL_MS = 800;
const PVP_POLL_FAST_MS = 200;

// Хук инкапсулирует сетевой слой PvP-поллинга. Не знает ничего про игровое состояние —
// просто шлёт pvpGetRoomState и зовёт onApplyRoomState(room) на успехе. Об ошибках
// (ACCEPT_TIMEOUT, Room not found в accept-фазе) сообщает через callbacks.
//
// Содержит:
//  - stopPvpPolling, startPvpPolling, enableFastPolling — управление интервалом.
//  - pvpPollState — один сетевой запрос (с requestId-guard, abort timeout, clock offset).
//  - serverClockOffsetMsRef — для синхронизации клиентского таймера с сервером.
export function usePvpPolling({
  initDataRef,
  pvpRoomIdRef,
  matchEndedRef,
  playModeRef,
  screen,
  acceptInfo,
  onApplyRoomState,
  onAcceptTimeout,
  onRoomNotFoundAccept,
  onShowConnectionError,
}) {
  const pvpPollTimerRef = useRef(null);
  const pvpPollInFlightRef = useRef(false);
  const pvpPollFastModeRef = useRef(false);
  const pvpPollRequestIdRef = useRef(0);
  const lastSuccessfulPollRef = useRef(Date.now());
  const connectionErrorTimerRef = useRef(null);
  const serverClockOffsetMsRef = useRef(0);

  const stopPvpPolling = useCallback(() => {
    if (pvpPollTimerRef.current) {
      clearInterval(pvpPollTimerRef.current);
      pvpPollTimerRef.current = null;
    }
    pvpPollInFlightRef.current = false;
  }, []);

  const pvpPollState = useCallback(() => {
    if (!pvpRoomIdRef.current || !initDataRef.current || pvpPollInFlightRef.current) return;
    pvpPollInFlightRef.current = true;
    const requestId = ++pvpPollRequestIdRef.current;

    if (connectionErrorTimerRef.current) clearTimeout(connectionErrorTimerRef.current);
    connectionErrorTimerRef.current = setTimeout(() => {
      if (playModeRef.current === 'pvp' && screen === 'game') {
        onShowConnectionError?.(true);
      }
    }, 3000);

    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const abortTimer = setTimeout(() => {
      if (controller) {
        try { controller.abort(); } catch (e) {}
      }
    }, 10000);

    fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'pvpGetRoomState',
        initData: initDataRef.current,
        roomId: pvpRoomIdRef.current,
      }),
      signal: controller ? controller.signal : undefined,
    })
      .then((r) => r.json())
      .then((data) => {
        // Out-of-order guard.
        if (requestId !== pvpPollRequestIdRef.current) return;
        if (connectionErrorTimerRef.current) clearTimeout(connectionErrorTimerRef.current);
        onShowConnectionError?.(false);
        lastSuccessfulPollRef.current = Date.now();
        if (data && Number.isFinite(Number(data.serverNowMs))) {
          serverClockOffsetMsRef.current = Date.now() - Number(data.serverNowMs);
        }

        if (!data?.ok) {
          const err = String(data?.error || '');
          if (err === 'ACCEPT_TIMEOUT') {
            stopPvpPolling();
            pvpRoomIdRef.current = null;
            onAcceptTimeout?.();
            return;
          }
          if (err === 'Room not found') {
            // После завершения матча сервер удаляет комнату — это нормальный cleanup,
            // НЕ accept-timeout. Не показываем «не принял матч» если screen === 'result'
            // или match уже отмечен как завершённый.
            if (matchEndedRef.current || screen === 'result') {
              stopPvpPolling();
              pvpRoomIdRef.current = null;
              return;
            }
            if (acceptInfo) onRoomNotFoundAccept?.();
          }
          return;
        }
        if (data.room) onApplyRoomState?.(data.room);
      })
      .catch(() => {
        const timeSinceLastSuccess = Date.now() - lastSuccessfulPollRef.current;
        if (timeSinceLastSuccess > 3000 && playModeRef.current === 'pvp' && screen === 'game') {
          onShowConnectionError?.(true);
        }
      })
      .finally(() => {
        clearTimeout(abortTimer);
        pvpPollInFlightRef.current = false;
      });
  }, [initDataRef, pvpRoomIdRef, matchEndedRef, playModeRef, screen, acceptInfo, stopPvpPolling, onApplyRoomState, onAcceptTimeout, onRoomNotFoundAccept, onShowConnectionError]);

  const startPvpPolling = useCallback(() => {
    stopPvpPolling();
    const interval = pvpPollFastModeRef.current ? PVP_POLL_FAST_MS : PVP_POLL_MS;
    pvpPollTimerRef.current = setInterval(() => {
      pvpPollState();
    }, interval);
    pvpPollState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopPvpPolling, pvpPollState]);

  const enableFastPolling = useCallback(() => {
    if (pvpPollFastModeRef.current) return;
    pvpPollFastModeRef.current = true;
    startPvpPolling();
    setTimeout(() => {
      pvpPollFastModeRef.current = false;
      if (pvpPollTimerRef.current) startPvpPolling();
    }, 15000);
  }, [startPvpPolling]);

  // Auto-cleanup на unmount: останавливаем интервал и таймер ошибки соединения.
  useEffect(() => {
    return () => {
      stopPvpPolling();
      if (connectionErrorTimerRef.current) {
        clearTimeout(connectionErrorTimerRef.current);
        connectionErrorTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    stopPvpPolling,
    startPvpPolling,
    pvpPollState,
    enableFastPolling,
    pvpPollInFlightRef,
    pvpPollFastModeRef,
    serverClockOffsetMsRef,
    connectionErrorTimerRef,
  };
}

export { PVP_POLL_MS, PVP_POLL_FAST_MS };
