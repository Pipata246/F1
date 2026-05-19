import { useCallback, useEffect, useRef } from 'react';

// Интервалы polling: обычный (idle/turn_input) и быстрый (после хода/round_result/match_over).
// Fast-mode: 400ms × 6s ≈ 15 polls. Хватает чтобы поймать ход бота (150-450мс) +
// round_result + start следующего раунда без перегрузки сервера. Старые значения
// 200ms × 15s давали 75 polls на ход — кратно избыточная нагрузка.
const PVP_POLL_MS = 800;
const PVP_POLL_FAST_MS = 400;
const PVP_POLL_FAST_DURATION_MS = 6000;

// Сколько ждать ответа от сервера до показа connection-error.
// 7 сек — учитывает Vercel cold-start (1-2с) + slow mobile RTT + тяжёлый pvpGetRoomState.
// Раньше было 3000мс что давало много ложных тревог при норме «всё хорошо, просто медленно».
const CONNECTION_ERROR_TIMEOUT_MS = 7000;

// Сколько таймстампов хранить для median-фильтрации serverClockOffset. Сглаживает шум RTT —
// без этого offset скакал на ±200-500мс между poll'ами на мобильной сети.
const CLOCK_OFFSET_WINDOW = 5;
// Порог в мс, ниже которого offset не обновляем — игнорируем jitter.
const CLOCK_OFFSET_UPDATE_THRESHOLD_MS = 500;

// Хук инкапсулирует сетевой слой PvP-поллинга. Не знает ничего про игровое состояние —
// просто шлёт pvpGetRoomState и зовёт onApplyRoomState(room) на успехе. Об ошибках
// (ACCEPT_TIMEOUT, Room not found в accept-фазе) сообщает через callbacks.
//
// Содержит:
//  - stopPvpPolling, startPvpPolling, enableFastPolling — управление интервалом.
//  - pvpPollState — один сетевой запрос (с requestId-guard, abort timeout, clock offset).
//  - serverClockOffsetMsRef — для синхронизации клиентского таймера с сервером (median).
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
  // F: median-фильтрация clock offset — сглаживает RTT-jitter.
  const clockOffsetSamplesRef = useRef([]);

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
    }, CONNECTION_ERROR_TIMEOUT_MS);

    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const abortTimer = setTimeout(() => {
      if (controller) {
        try { controller.abort(); } catch (e) {}
      }
    }, 10000);

    // Засекаем время отправки для RTT-half оценки serverNowMs.
    const sentAtMs = Date.now();

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

        // F: clock offset с RTT-half компенсацией + median. Без этого offset смещался
        // на ~RTT/2 в каждом сэмпле — таймер раунда мог стартовать с погрешностью 200-500мс.
        if (data && Number.isFinite(Number(data.serverNowMs))) {
          const receivedAtMs = Date.now();
          const rttHalf = Math.max(0, (receivedAtMs - sentAtMs) / 2);
          // Server stamped serverNowMs примерно при receivedAt - rttHalf на клиенте.
          const sample = receivedAtMs - rttHalf - Number(data.serverNowMs);
          const samples = clockOffsetSamplesRef.current;
          samples.push(sample);
          if (samples.length > CLOCK_OFFSET_WINDOW) samples.shift();
          // Median по копии (sort на месте не ломаем порядок реальной выборки).
          const sorted = [...samples].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          if (Math.abs(median - serverClockOffsetMsRef.current) > CLOCK_OFFSET_UPDATE_THRESHOLD_MS
              || serverClockOffsetMsRef.current === 0) {
            serverClockOffsetMsRef.current = median;
          }
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
        // A: окно тишины — если последний успешный poll был давно, показываем error.
        // Согласуем порог с CONNECTION_ERROR_TIMEOUT_MS чтобы catch не срабатывал раньше времени.
        const timeSinceLastSuccess = Date.now() - lastSuccessfulPollRef.current;
        if (timeSinceLastSuccess > CONNECTION_ERROR_TIMEOUT_MS && playModeRef.current === 'pvp' && screen === 'game') {
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
    }, PVP_POLL_FAST_DURATION_MS);
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
    lastSuccessfulPollRef,
  };
}

export { PVP_POLL_MS, PVP_POLL_FAST_MS, CONNECTION_ERROR_TIMEOUT_MS };
