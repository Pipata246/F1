import { useState, useRef, useCallback, useEffect } from 'react';
import confetti from 'canvas-confetti';
import { targetPositions, keeperZonePos } from '../lib/zonePositions.js';
import { appSettings, playSound } from '../lib/sound.js';

// Анимация раунда (полёт мяча + прыжок вратаря + GOAL/SAVED + overtime overlay).
// Владеет всем animation state + animation timer'ами. Внешние зависимости — game state
// setters (scores/history/sudden death) и callbacks (stopTimer, enableFastPolling,
// pvpPollState, showBottomNotice, onMatchResultFallback).
//
// handleRoundResult защищён signature-guard'ом против дублей (важно для demo-bot, где
// нет marker-guard'а из applyPvpRoomState).
export function useGameAnimation({
  // refs из других хуков / GamePage
  pvpRoomIdRef,
  matchEndedRef,
  playerIndexRef,
  playModeRef,
  pvpPollInFlightRef,
  // setters внешнего game state
  setWaitingOpponent,
  setInputBlocked,
  setScores,
  setHistory,
  setSuddenDeath,
  setSuddenDeathStartRound,
  // callbacks
  stopTimer,
  enableFastPolling,
  pvpPollState,
  showBottomNotice,
  // финальный watchdog: если по какой-то причине match_result не пришёл — форсим через callback
  onMatchResultFallback,
  // снапшоты state для финального watchdog (через ref, чтобы не пересоздавать handleRoundResult)
  screenRef,
  matchResultRef,
}) {
  // Animation state
  const [ballVisible, setBallVisible] = useState(true);
  const [ballStyle, setBallStyle] = useState({});
  const [keeperState, setKeeperState] = useState('idle');
  const [isKeeperMirrored, setIsKeeperMirrored] = useState(false);
  const [keeperX, setKeeperX] = useState(0);
  const [keeperBottom, setKeeperBottom] = useState('4');
  const [keeperTransitionDisabled, setKeeperTransitionDisabled] = useState(false);
  const [resultMessage, setResultMessage] = useState(null);
  const [showingResult, setShowingResult] = useState(false);
  const [overtimeAnnounce, setOvertimeAnnounce] = useState(false);

  // Refs — синхронные снапшоты state'ов + списки таймеров.
  const showingResultRef = useRef(false);
  const overtimeAnnounceRef = useRef(false);
  const lastAnimSignatureRef = useRef('');
  const animTimersRef = useRef([]);
  // Fix #2: overtime таймеры в ОТДЕЛЬНОМ ref'е, чтобы animTimersRef cleanup при следующем
  // round_start не убил setOvertimeAnnounce(false) и модалка не зависла на весь овертайм.
  const overtimeTimersRef = useRef([]);
  const roundStuckTimerRef = useRef(null);
  const waitingBotMoveTimerRef = useRef(null);

  useEffect(() => { showingResultRef.current = showingResult; }, [showingResult]);
  useEffect(() => { overtimeAnnounceRef.current = overtimeAnnounce; }, [overtimeAnnounce]);

  const clearRoundStuckTimer = useCallback(() => {
    if (roundStuckTimerRef.current) {
      clearTimeout(roundStuckTimerRef.current);
      roundStuckTimerRef.current = null;
    }
  }, []);

  const clearWaitingBotMoveTimer = useCallback(() => {
    if (waitingBotMoveTimerRef.current) {
      clearTimeout(waitingBotMoveTimerRef.current);
      waitingBotMoveTimerRef.current = null;
    }
  }, []);

  // Используется из round_start handler'а в GamePage — сбрасывает анимационный state в чистое
  // (без обратной анимации, потому что round_start уже произошёл и keeper должен сразу быть idle).
  const resetForNewRound = useCallback(() => {
    lastAnimSignatureRef.current = '';
    animTimersRef.current.forEach((t) => clearTimeout(t));
    animTimersRef.current = [];
    setShowingResult(false);
    setResultMessage(null);
    setBallVisible(true);
    setBallStyle({});
    setKeeperState('idle');
    setIsKeeperMirrored(false);
    setKeeperX(0);
    setKeeperBottom('4');
  }, []);

  // Используется из match_result / useMatchLifecycle — полный hard-reset.
  const resetAll = useCallback(() => {
    lastAnimSignatureRef.current = '';
    animTimersRef.current.forEach((t) => clearTimeout(t));
    animTimersRef.current = [];
    overtimeTimersRef.current.forEach((t) => clearTimeout(t));
    overtimeTimersRef.current = [];
    clearRoundStuckTimer();
    clearWaitingBotMoveTimer();
    setShowingResult(false);
    setResultMessage(null);
    setOvertimeAnnounce(false);
  }, [clearRoundStuckTimer, clearWaitingBotMoveTimer]);

  // Сохраняем ссылки для использования из обработчиков, которые требуют стабильности.
  const handleRoundResult = useCallback((msg) => {
    // A2: signature-guard — defensive против повторного вызова handleRoundResult для одного хода.
    // Marker check в applyPvpRoomState уже защищает PvP-путь, но demo-bot путь вызывает
    // handleServerMessage напрямую (без marker) — это страховка против дублей анимации.
    const sig = `${msg.round ?? 0}:${msg.kickerIndex ?? -1}:${msg.kickerZone ?? -1}:${msg.keeperZone ?? -1}:${msg.isGoal ? 1 : 0}`;
    if (sig === lastAnimSignatureRef.current) return; // тот же ход — игнор
    lastAnimSignatureRef.current = sig;

    // A2: чистим таймеры предыдущего раунда — невозможно, чтобы их setState'ы перебили текущий
    animTimersRef.current.forEach((t) => clearTimeout(t));
    animTimersRef.current = [];

    clearRoundStuckTimer();
    stopTimer();
    setWaitingOpponent(false);
    setShowingResult(true);
    setInputBlocked(true);
    setScores(msg.scores);
    if (msg.history) setHistory(msg.history);

    // КРИТИЧЕСКИЙ МОМЕНТ: Включаем быстрый polling — может начаться овертайм или закончиться игра
    enableFastPolling();

    const { kickerZone, keeperZone, isGoal, kickerIndex } = msg;
    const iAmKicker = playerIndexRef.current === kickerIndex;

    // Fix #1: toast показывается ТОЛЬКО когда сервер явно сообщил, что my side был auto-resolved
    // (флаг autoFilledSides от server pvpAdvanceByTime). Сравнение зон давало false positive
    // при overtime/role swap, где kicker/keeper менялись и нумерация выглядела как mismatch.
    if (playModeRef.current === 'pvp' && Array.isArray(msg.autoFilledSides) && msg.mySide && msg.autoFilledSides.includes(msg.mySide)) {
      showBottomNotice('Ход не успел дойти, авто-выбор сервера');
    }

    // Ball flies to kicker's zone
    const target = targetPositions[kickerZone];
    setBallVisible(true);
    setBallStyle({
      transform: `translate(${target.x}px, ${target.y}px) scale(0.55)`,
      transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
    });
    playSound('kick');

    // Keeper moves to their chosen zone
    const kpos = keeperZonePos[keeperZone];
    setIsKeeperMirrored(keeperZone === 0 || keeperZone === 2);

    animTimersRef.current.push(setTimeout(() => {
      setKeeperX(kpos.x);
      setKeeperBottom(String(kpos.bottom));
      // Save sprite ONLY when keeper actually catches the ball
      if (!isGoal) setKeeperState('save');
      else setKeeperState('moved'); // missed — stays idle sprite, just moves to position
    }, 150));

    // If saved, hide the flying ball after it "reaches" the keeper.
    animTimersRef.current.push(setTimeout(() => {
      if (!isGoal) setBallVisible(false);
    }, 420));

    // Result text
    animTimersRef.current.push(setTimeout(() => {
      if (isGoal) {
        playSound('goal');
        if (iAmKicker) {
          setResultMessage({ text: 'GOAL!', type: 'win' });
          confetti({ particleCount: 25, spread: 40, origin: { y: 0.6 }, ticks: 40 });
          if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
        } else {
          setResultMessage({ text: 'GOAL!', type: 'loss' });
          if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
        }
      } else {
        playSound('save');
        if (iAmKicker) {
          setResultMessage({ text: 'SAVED!', type: 'loss' });
          if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
        } else {
          setResultMessage({ text: 'SAVED!', type: 'win' });
          confetti({ particleCount: 25, spread: 40, origin: { y: 0.6 }, ticks: 40 });
          if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
        }
      }
    }, 400));

    // Мгновенный (без обратной анимации) сброс вратаря в idle-позицию ВНУТРИ окна показа
    // результата. Без флага keeperTransitionDisabled <div> и <img> вратаря плавно
    // откатываются за 0.45s — игроки видят это как «вторую анимацию» одного хода.
    animTimersRef.current.push(setTimeout(() => {
      if (!showingResultRef.current) return; // если раунд уже сменился — пусть round_start решит
      setBallVisible(false);
      setKeeperTransitionDisabled(true);
      setKeeperX(0);
      setKeeperBottom('4');
      setIsKeeperMirrored(false);
      setKeeperState('idle');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setKeeperTransitionDisabled(false);
        });
      });
    }, 1100));

    // Если начинается овертайм - показываем уведомление ПЕРЕД следующим раундом
    if (msg.startSuddenDeath) {
      const overtimeStartRound = msg.round || 0;
      overtimeTimersRef.current.forEach((t) => clearTimeout(t));
      overtimeTimersRef.current = [];
      overtimeTimersRef.current.push(setTimeout(() => {
        setOvertimeAnnounce(true);
        setSuddenDeath(true);
        setSuddenDeathStartRound(overtimeStartRound);
        if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('warning');
        overtimeTimersRef.current.push(setTimeout(() => {
          setOvertimeAnnounce(false);
          setShowingResult(false);
          setResultMessage(null);
        }, 2000));
      }, 1200));
    }

    // Fix #3: 1500ms — анимация удара (0.4с) + текст GOAL/SAVED успевают прочитаться,
    // потом сразу запрашиваем next state. Синхронизировано с серверным round_result→turn_input
    // transition (тоже 1500ms).
    const safetyTimeout = 1500;
    roundStuckTimerRef.current = setTimeout(() => {
      if (!showingResultRef.current) return;
      setShowingResult(false);
      setResultMessage(null);
      if (playModeRef.current === 'pvp') {
        // Форсируем poll — server только что транзитнулся в turn_input, надо подхватить состояние
        pvpPollInFlightRef.current = false;
        pvpPollState();
        // Если первый poll попал в момент когда сервер ещё не дотранзитнулся,
        // догоняем ещё одним через 400мс. updated_at-guard отбросит, если ответ stale.
        animTimersRef.current.push(setTimeout(() => {
          if (!matchEndedRef.current && pvpRoomIdRef.current) {
            pvpPollInFlightRef.current = false;
            pvpPollState();
          }
        }, 400));
      } else {
        setInputBlocked(false);
      }
    }, safetyTimeout);

    // Финальный раунд (gameOver=true): гарантированный watchdog. Если по какой-то причине
    // никто не довёл матч до result-экрана за 2.5 секунды после анимации удара, форсим
    // match_result сами. Покрывает: оборванное polling-окно в PvP, потерянный setTimeout
    // в demo-bot, любой другой race в цепочке завершения.
    if (msg.gameOver) {
      animTimersRef.current.push(setTimeout(() => {
        if (matchEndedRef.current) return;
        if (screenRef?.current === 'result' || matchResultRef?.current) return;
        let youWon = false;
        if (msg.winnerSide && msg.mySide) {
          youWon = msg.winnerSide === msg.mySide;
        } else if (Array.isArray(msg.scores) && msg.scores.length === 2) {
          const myIdx = playerIndexRef.current;
          youWon = myIdx === 0 ? msg.scores[0] > msg.scores[1] : msg.scores[1] > msg.scores[0];
        }
        onMatchResultFallback?.({ youWon, scores: msg.scores || [0, 0] });
      }, 2500));
    }
  }, [
    clearRoundStuckTimer, stopTimer, enableFastPolling, pvpPollState, showBottomNotice,
    setWaitingOpponent, setInputBlocked, setScores, setHistory,
    setSuddenDeath, setSuddenDeathStartRound,
    playerIndexRef, playModeRef, pvpPollInFlightRef, matchEndedRef, pvpRoomIdRef,
    screenRef, matchResultRef, onMatchResultFallback,
  ]);

  return {
    // animation state
    ballVisible,
    ballStyle,
    keeperState,
    isKeeperMirrored,
    keeperX,
    keeperBottom,
    keeperTransitionDisabled,
    resultMessage,
    showingResult,
    overtimeAnnounce,
    // refs (используются снаружи в applyPvpRoomState/handleChooseZone и lifecycle reset)
    showingResultRef,
    overtimeAnnounceRef,
    lastAnimSignatureRef,
    animTimersRef,
    overtimeTimersRef,
    roundStuckTimerRef,
    waitingBotMoveTimerRef,
    // setters экспонируем для match_result/opponent_left handler'ов в GamePage
    setShowingResult,
    setResultMessage,
    setOvertimeAnnounce,
    // actions
    handleRoundResult,
    clearRoundStuckTimer,
    clearWaitingBotMoveTimer,
    resetForNewRound,
    resetAll,
  };
}
