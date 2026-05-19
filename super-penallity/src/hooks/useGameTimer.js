import { useState, useRef, useCallback, useEffect } from 'react';
import { playSound } from '../lib/sound.js';

// Серверный auto-resolve срабатывает через 17с от phaseAtMs. Клиент стартует таймер
// с реального остатка минус 1с safety buffer — игрок не «оторвётся» от сервера.
const SERVER_AUTO_RESOLVE_S = 17;
const SAFETY_BUFFER_S = 1;
const DEFAULT_INITIAL_S = 11;

// Хук таймера раунда. По истечении отправляет auto-fill зону через sendMessage('choose_zone').
// Если игрок успел тапнуть в последнюю секунду (selectedZoneRef уже выставлен) — используем
// его выбор, иначе random.
//
// Внутри setInterval работаем через refs (selectedZoneRef, showingResultRef, lastSubmittedZoneRef)
// чтобы не зависеть от stale-state в замыкании. sendMessage обёрнут в ref, чтобы startTimer
// был ссылочно стабильным и не пересоздавал interval каждый рендер.
export function useGameTimer({
  lastSubmittedZoneRef,
  selectedZoneRef,
  showingResultRef,
  setSelectedZone,
  sendMessage,
}) {
  const [timer, setTimer] = useState(10);
  const timerRef = useRef(null);

  const sendMessageRef = useRef(sendMessage);
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback((initialSecondsParam) => {
    stopTimer();
    let initialSeconds = DEFAULT_INITIAL_S;
    if (Number.isFinite(initialSecondsParam) && initialSecondsParam > 0) {
      initialSeconds = Math.max(
        2,
        Math.min(SERVER_AUTO_RESOLVE_S - SAFETY_BUFFER_S, Math.ceil(initialSecondsParam)),
      );
    }
    setTimer(initialSeconds);
    timerRef.current = setInterval(() => {
      setTimer((prev) => {
        const next = prev - 1;
        if (prev <= 1) {
          stopTimer();
          const alreadySubmitted = (lastSubmittedZoneRef.current !== null && lastSubmittedZoneRef.current !== undefined);
          if (!alreadySubmitted && !showingResultRef.current) {
            const pending = selectedZoneRef.current;
            const autoZone = (pending !== null && pending !== undefined && [0, 1, 2, 3].includes(Number(pending)))
              ? Number(pending)
              : Math.floor(Math.random() * 4);
            if (selectedZoneRef.current === null || selectedZoneRef.current === undefined) {
              selectedZoneRef.current = autoZone;
              setSelectedZone(autoZone);
            }
            sendMessageRef.current?.('choose_zone', { zone: autoZone });
          }
          return 0;
        }
        if (
          next > 0
          && next <= 3
          && (lastSubmittedZoneRef.current === null || lastSubmittedZoneRef.current === undefined)
          && !showingResultRef.current
        ) {
          playSound('tick');
        }
        return next;
      });
    }, 1000);
  }, [stopTimer, lastSubmittedZoneRef, selectedZoneRef, showingResultRef, setSelectedZone]);

  // Auto-cleanup interval'а при размонтировании.
  useEffect(() => () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return { timer, startTimer, stopTimer };
}
