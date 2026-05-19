import React, { useState, useRef, useEffect, useCallback } from 'react';
import confetti from 'canvas-confetti';
import {
  armAudioOnGesture,
  preloadSounds,
  playSound,
  startBackground,
  stopBackground,
  isAudioReady,
  appSettings,
} from '../lib/sound.js';
import { saveMatchToBackend } from '../lib/saveMatch.js';
import { WaitingScreen } from '../components/screens/WaitingScreen.jsx';
import { StakeSelectScreen } from '../components/screens/StakeSelectScreen.jsx';
import { ResultScreen } from '../components/screens/ResultScreen.jsx';
import { GameScreen } from '../components/screens/GameScreen.jsx';
import { useTelegramWebApp } from '../hooks/useTelegramWebApp.js';
import { useMatchResume } from '../hooks/useMatchResume.js';
import { apiPost } from '../lib/api.js';
import { usePvpPolling } from '../hooks/usePvpPolling.js';
import { useMatchLifecycle } from '../hooks/useMatchLifecycle.js';
import { useGameTimer } from '../hooks/useGameTimer.js';
import { useGameAnimation } from '../hooks/useGameAnimation.js';
import { usePvpSubmit } from '../hooks/usePvpSubmit.js';
import { useDemoBot } from '../hooks/useDemoBot.js';
import { useApplyRoomState } from '../hooks/useApplyRoomState.js';

const ASSET_BASE = import.meta.env.BASE_URL || '/super-penallity/';

const GamePage = () => {
  const safeFrameStyle = {
    paddingTop: 'var(--tg-safe-top-ui)',
    paddingBottom: 'var(--tg-safe-bottom-ui)',
    boxSizing: 'border-box',
  };
  const safeFrameGameStyle = {
    paddingBottom: 'var(--tg-safe-bottom-ui)',
    boxSizing: 'border-box',
  };
  const [screen, setScreen] = useState('stake-online');
  /** Имя с бэка (authSession.display_name), из Telegram */
  const [displayName, setDisplayName] = useState('Player');
  const [opponent, setOpponent] = useState('');
  const [playerIndex, setPlayerIndex] = useState(0);

  // Game state
  const [round, setRound] = useState(0);
  const [maxRounds, setMaxRounds] = useState(5);
  const [role, setRole] = useState('kicker');
  const [scores, setScores] = useState([0, 0]);
  const [suddenDeath, setSuddenDeath] = useState(false);
  const [suddenDeathStartRound, setSuddenDeathStartRound] = useState(0); // Раунд начала овертайма
  const [zoneLocked, setZoneLocked] = useState(false);
  const [waitingOpponent, setWaitingOpponent] = useState(false);
  const [history, setHistory] = useState([]);
  const [selectedZone, setSelectedZone] = useState(null); // pending — локальный выбор до подтверждения сервером
  // A1: confirmedZone из server (room.state_json.choices[mySide] или lastRoundResult).
  // Мишень рендерится по (confirmedZone ?? selectedZone). После подтверждения сервером
  // мишень мгновенно переключается на серверную зону — невозможен рассинхрон с мячом.
  const [confirmedZone, setConfirmedZone] = useState(null);

  // Animation state — owned by useGameAnimation hook.

  // Role announcement
  const [roleAnnounce, setRoleAnnounce] = useState(null);
  const [inputBlocked, setInputBlocked] = useState(false);

  // Match result
  const [matchResult, setMatchResult] = useState(null);
  const [selectedStakeOptions, setSelectedStakeOptions] = useState([]);
  const [currentStakeTon, setCurrentStakeTon] = useState(null);
  const [balanceTon, setBalanceTon] = useState(0);
  const [bottomNotice, setBottomNotice] = useState('');
  const [acceptInfo, setAcceptInfo] = useState(null);
  const [acceptTick, setAcceptTick] = useState(0);
  const [showConnectionError, setShowConnectionError] = useState(false);

  const playerIndexRef = useRef(0);
  const matchRef = useRef(null);
  const tgInitDataRef = useTelegramWebApp({
    onDisplayName: (n) => setDisplayName(n),
    onBalance: (b) => setBalanceTon(b),
  });
  const matchSavedRef = useRef(false);
  /** Как в frog-hunt: только один из режимов — онлайн (pvp) или локальный бот, никогда оба сразу. */
  const playModeRef = useRef('idle');
  const pvpRoomIdRef = useRef(null);
  const pvpOpponentTgIdRef = useRef(null);
  const pvpOpponentIsBotRef = useRef(false);
  const pvpLastRoundMarkerRef = useRef(0);
  const pvpLastStartKeyRef = useRef('');
  const pvpMoveCommittedRef = useRef(false);
  const selectedZoneRef = useRef(null);
  const matchEndedRef = useRef(false);
  const lastSubmittedZoneRef = useRef(null);
  // A4: reconciliation против out-of-order ответов и stale poll'ов
  const lastAppliedUpdatedAtRef = useRef(0); // ms of room.updated_at
  // A3: текущий turnId раунда, обновляется из poll. Привязывает submit к конкретному раунду.
  const turnIdRef = useRef('');
  const localFindTimerRef = useRef(null);
  const pvpFindRetryTimerRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const launchHandledRef = useRef(false);
  // pvpMoveWatchdogTimerRef живёт в usePvpSubmit (auto-cleanup на unmount).
  const waitingOpponentTimerRef = useRef(null); // Таймер для отслеживания долгого ожидания

  // Snapshots для финального watchdog в useGameAnimation (он зовёт onMatchResultFallback,
  // и нужно знать актуальный screen/matchResult без пересоздания handleRoundResult).
  const screenRef = useRef(screen);
  const matchResultRef = useRef(null);

  useEffect(() => { playerIndexRef.current = playerIndex; }, [playerIndex]);
  useEffect(() => { selectedZoneRef.current = selectedZone; }, [selectedZone]);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { matchResultRef.current = matchResult; }, [matchResult]);

  useEffect(() => {
    ['keeper_idle', 'keeper_save', 'keeper_green', 'keeper_red', 'ball', 'gate'].forEach((name) => {
      const img = new Image();
      img.src = `${ASSET_BASE}${name}.png`;
    });
    // A9: на iOS AudioContext активируется только в user-gesture. До тапа звуки молчат.
    armAudioOnGesture();
    preloadSounds();
  }, []);

  // A9: если фон должен играть, а AudioContext ещё не готов — перезапускаем при первом тапе
  useEffect(() => {
    if (screen !== 'game') return undefined;
    if (isAudioReady()) return undefined;
    const retry = () => { if (screen === 'game') startBackground(); };
    window.addEventListener('pointerdown', retry, { once: true, capture: true });
    return () => window.removeEventListener('pointerdown', retry, { capture: true });
  }, [screen]);

  useEffect(() => {
    if (screen === 'game') startBackground();
    else stopBackground();
    return () => { if (screen !== 'game') stopBackground(); };
  }, [screen]);

  useEffect(() => () => stopBackground(), []);

  // Отслеживание долгого ожидания соперника — многоступенчатый recovery.
  useEffect(() => {
    if (!(waitingOpponent && playModeRef.current === 'pvp' && screen === 'game')) {
      if (waitingOpponentTimerRef.current) {
        clearTimeout(waitingOpponentTimerRef.current);
        waitingOpponentTimerRef.current = null;
      }
      if (!waitingOpponent) setShowConnectionError(false);
      return undefined;
    }

    const timers = [];

    // Нормальный flow: бот 0.3-1с + poll 0.4с + анимация 2.5с ≈ 4с висит waitingOpponent.
    // Recovery таймеры начинаются ПОСЛЕ этого окна, чтобы не мешать обычной игре.
    //
    // D: все recovery'и теперь учитывают pvpMoveCommittedRef. Если submit подтверждён сервером
    // (committed=true), значит ход уже у сервера, и долгое ожидание — это бот думает или
    // анимация раунда. Лишние forced polls в этом случае только давят сервер.
    // Recovery нужно ТОЛЬКО когда submit потерялся (network drop), т.е. committed=false.

    // 8 сек: force poll (тикнет pvpAdvanceByTime, бот сходит если завис)
    timers.push(setTimeout(() => {
      if (!waitingOpponent || matchEndedRef.current || pvpMoveCommittedRef.current) return;
      pvpPollInFlightRef.current = false;
      pvpPollState();
    }, 8000));

    // 14 сек: forced poll, чтобы подтянуть актуальный state.
    timers.push(setTimeout(() => {
      if (!waitingOpponent || matchEndedRef.current || pvpMoveCommittedRef.current) return;
      pvpPollInFlightRef.current = false;
      pvpPollState();
    }, 14000));

    // 22 сек: модалка с выходом — показываем только если submit реально не дошёл.
    timers.push(setTimeout(() => {
      if (!waitingOpponent || matchEndedRef.current || pvpMoveCommittedRef.current) return;
      setShowConnectionError(true);
    }, 22000));

    return () => { timers.forEach(clearTimeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingOpponent, screen]);

  // G: auto-hide connection-error через 10 сек после показа. Polling всё равно продолжает
  // ретраить в фоне (interval 800мс не останавливается), так что модалка-блокер ни к чему —
  // если сеть восстановится, успешный poll сбросит её сам ([usePvpPolling onShowConnectionError(false)]).
  useEffect(() => {
    if (!showConnectionError) return undefined;
    const t = setTimeout(() => setShowConnectionError(false), 10000);
    return () => clearTimeout(t);
  }, [showConnectionError]);

  const showBottomNotice = useCallback((msg) => {
    setBottomNotice(String(msg || ''));
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setBottomNotice(''), 2200);
  }, []);

  // Forward refs для разрыва циклической зависимости с usePvpPolling: хук объявляется
  // выше, чем applyPvpRoomState/goHome/startSearchOnline (они зависят от polling-функций
  // самого хука). useEffect ниже подсасывает свежие ссылки в refs на каждый рендер.
  const applyPvpRoomStateRef = useRef(null);
  const goHomeRef = useRef(null);
  const startSearchOnlineRef = useRef(null);
  // sendMessage определяется ниже useGameTimer, который зовёт его из таймера. Forward-ref
  // разрывает цикличность; useGameTimer на каждом тике обращается к свежей ссылке через .current.
  const sendMessageRef = useRef(null);
  // useGameAnimation зовёт stopTimer (вверху раунда), но useGameTimer объявлен ниже и
  // зависит от showingResultRef (владеет useGameAnimation). Forward-ref снимает цикл.
  const stopTimerRef = useRef(null);
  // matchResult-fallback handler из useGameAnimation: завершение матча обрабатывает
  // handleServerMessage ниже, ссылка прокидывается через ref.
  const onMatchResultFallbackRef = useRef(null);

  const {
    stopPvpPolling,
    startPvpPolling,
    pvpPollState,
    enableFastPolling,
    pvpPollInFlightRef,
    serverClockOffsetMsRef,
    connectionErrorTimerRef,
  } = usePvpPolling({
    initDataRef: tgInitDataRef,
    pvpRoomIdRef,
    matchEndedRef,
    playModeRef,
    screen,
    acceptInfo,
    onApplyRoomState: (room) => applyPvpRoomStateRef.current?.(room),
    onAcceptTimeout: () => goHomeRef.current?.(),
    onRoomNotFoundAccept: () => {
      pvpRoomIdRef.current = null;
      setAcceptInfo(null);
      setScreen('waiting');
      showBottomNotice('Пользователь не принял матч');
      startSearchOnlineRef.current?.();
    },
    onShowConnectionError: setShowConnectionError,
  });

  // Стабильные wrappers вокруг forward-ref'ов, чтобы передавать в хуки без пересоздания ссылок.
  const stopTimerForwarded = useCallback(() => stopTimerRef.current?.(), []);
  const onMatchResultFallbackForwarded = useCallback((arg) => onMatchResultFallbackRef.current?.(arg), []);
  const sendMessageForwarded = useCallback((...args) => sendMessageRef.current?.(...args), []);

  // Анимация раунда — owns анимационный state и handleRoundResult. Зовёт stopTimer через
  // forward-ref (useGameTimer объявлен ниже) и onMatchResultFallback (handleServerMessage ниже).
  const animation = useGameAnimation({
    pvpRoomIdRef,
    matchEndedRef,
    playerIndexRef,
    playModeRef,
    pvpPollInFlightRef,
    setWaitingOpponent,
    setInputBlocked,
    setScores,
    setHistory,
    setSuddenDeath,
    setSuddenDeathStartRound,
    stopTimer: stopTimerForwarded,
    enableFastPolling,
    pvpPollState,
    showBottomNotice,
    onMatchResultFallback: onMatchResultFallbackForwarded,
    screenRef,
    matchResultRef,
  });

  const {
    ballVisible, ballStyle, keeperState, isKeeperMirrored, keeperX, keeperBottom,
    keeperTransitionDisabled, resultMessage, showingResult, overtimeAnnounce,
    showingResultRef, overtimeAnnounceRef, lastAnimSignatureRef, animTimersRef,
    overtimeTimersRef, roundStuckTimerRef, waitingBotMoveTimerRef,
    setShowingResult, setResultMessage, setOvertimeAnnounce,
    handleRoundResult, clearRoundStuckTimer, clearWaitingBotMoveTimer,
    resetForNewRound, resetAll: resetAnimationAll,
  } = animation;

  // Timer раунда — отделён от анимации/sendMessage чтобы избежать stale-state в setInterval.
  // sendMessage передаётся через sendMessageRef (forward-ref), потому что определяется ниже.
  const { timer, startTimer, stopTimer } = useGameTimer({
    lastSubmittedZoneRef,
    selectedZoneRef,
    showingResultRef,
    setSelectedZone,
    sendMessage: sendMessageForwarded,
  });

  // Подсасываем stopTimer в forward-ref для useGameAnimation.
  useEffect(() => { stopTimerRef.current = stopTimer; }, [stopTimer]);

  const goHome = useCallback(() => {
    // Очищаем состояние игры и отправляем на бэкенд что вышли
    if (playModeRef.current === 'pvp' && pvpRoomIdRef.current && tgInitDataRef.current) {
      // КРИТИЧНО: Отправляем pvpLeaveRoom чтобы засчитать поражение
      const payload = JSON.stringify({
        action: 'pvpLeaveRoom',
        initData: tgInitDataRef.current,
        roomId: pvpRoomIdRef.current,
      });
      
      // Используем sendBeacon для надёжной отправки
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/user', new Blob([payload], { type: 'application/json' }));
        }
      } catch {}
      
      // Дублируем обычным fetch с keepalive
      fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
    
    // Останавливаем polling через хук
    stopPvpPolling();

    playModeRef.current = 'idle';
    pvpRoomIdRef.current = null;

    // ОТКЛЮЧАЕМ ВСЕ УВЕДОМЛЕНИЯ перед переходом
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.disableClosingConfirmation();
    }

    // Переходим на ГЛАВНУЮ СТРАНИЦУ (не игры, а сайта) БЕЗ ЗАДЕРЖКИ
    window.location.replace('/');
  }, [stopPvpPolling]);

  // Обработка браузерной кнопки "Назад"
  useEffect(() => {
    const handlePopState = () => {
      // При нажатии браузерной кнопки "Назад" - всегда на главную
      goHome();
    };
    
    // Добавляем запись в историю браузера ВСЕГДА когда не на главной
    if (screen !== 'stake-online') {
      window.history.pushState({ screen }, '', window.location.pathname);
    }
    
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [screen, goHome]);

  // УБИРАЕМ ВСЕ УВЕДОМЛЕНИЯ - удаляем beforeunload полностью
  // useEffect для beforeunload УДАЛЁН

  // A7: resume после refresh + сохранение/очистка sessionStorage + cancel-queue на pagehide.
  useMatchResume({
    screen,
    initDataRef: tgInitDataRef,
    pvpRoomIdRef,
    playModeRef,
    onResume: (room) => {
      pvpRoomIdRef.current = Number(room.id);
      playModeRef.current = 'pvp';
      matchEndedRef.current = false;
      startPvpPolling();
    },
  });

  // Тикер для обратного отсчёта в accept-модалке.
  useEffect(() => {
    if (screen !== 'accept') return undefined;
    const id = setInterval(() => setAcceptTick((v) => v + 1), 500);
    return () => clearInterval(id);
  }, [screen]);

  useEffect(() => {
    return () => {
      if (playModeRef.current === 'pvp' && pvpRoomIdRef.current && tgInitDataRef.current) {
        const payload = JSON.stringify({
          action: 'pvpLeaveRoom',
          initData: tgInitDataRef.current,
          roomId: pvpRoomIdRef.current,
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
      // timer чистится auto-cleanup'ом в useGameTimer
      // pvpPollTimer и connectionErrorTimer чистятся auto-cleanup'ом в usePvpPolling
      if (localFindTimerRef.current) clearTimeout(localFindTimerRef.current);
      if (pvpFindRetryTimerRef.current) clearTimeout(pvpFindRetryTimerRef.current);
      if (roundStuckTimerRef.current) clearTimeout(roundStuckTimerRef.current);
      if (waitingBotMoveTimerRef.current) clearTimeout(waitingBotMoveTimerRef.current);
      if (waitingOpponentTimerRef.current) clearTimeout(waitingOpponentTimerRef.current);
    };
  }, []);

  const handleServerMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'waiting':
        setScreen('waiting');
        break;

      case 'game_found':
        setOpponent(msg.opponent);
        setPlayerIndex(msg.playerIndex);
        playerIndexRef.current = msg.playerIndex;
        setScores([0, 0]);
        setRound(0);
        setSuddenDeath(false);
        setSuddenDeathStartRound(0);
        setHistory([]);
        setScreen('game');
        break;

      case 'round_start':
        clearRoundStuckTimer();
        clearMoveWatchdog();
        clearWaitingBotMoveTimer();
        // A2 + animation state cleanup: сигнатура, anim-таймеры, ball/keeper в idle, showingResult сброшен.
        resetForNewRound();
        // Fix #2: страховка от зависшей overtime модалки.
        // Если показалась — снимаем при входе в следующий раунд, даже если timer'ы потерялись.
        if (overtimeAnnounce) setOvertimeAnnounce(false);
        setRound(msg.round);
        setMaxRounds(msg.maxRounds);
        setRole(msg.role);
        setScores(msg.scores);
        setSuddenDeath(msg.suddenDeath);
        if (msg.history) setHistory(msg.history);
        setZoneLocked(false);
        setWaitingOpponent(false);
        setSelectedZone(null);
        selectedZoneRef.current = null;
        setConfirmedZone(null); // A1: новый раунд — сбрасываем серверно-подтверждённую зону
        lastSubmittedZoneRef.current = null; // новый раунд — снимаем commit-флаг хода
        playSound('whistle_start');
        
        // roleAnnounce ускорен до 500ms. Игрок успевает прочитать "Твой удар!"/"Отбивай мяч!"
        // (короткий текст + анимация появления), но не зевает лишнее время до старта таймера.
        // Расчёт остатка реального времени до серверного auto-resolve через clock offset.
        const computeRemainingSeconds = () => {
          if (!msg.phaseAtMs || !Number.isFinite(msg.phaseAtMs)) return undefined;
          const SERVER_AUTO_RESOLVE_MS = 17000;
          const SAFETY_BUFFER_MS = 1000;
          const serverNowEstimate = Date.now() - serverClockOffsetMsRef.current;
          const serverElapsed = serverNowEstimate - msg.phaseAtMs;
          const remainingMs = SERVER_AUTO_RESOLVE_MS - serverElapsed - SAFETY_BUFFER_MS;
          if (remainingMs <= 0) return 2;
          return Math.ceil(remainingMs / 1000);
        };
        if (!overtimeAnnounceRef.current) {
          setRoleAnnounce({ role: msg.role, round: msg.round });
          setInputBlocked(true);
          setTimeout(() => {
            setRoleAnnounce(null);
            setInputBlocked(false);
            startTimer(computeRemainingSeconds());
          }, 500);
        } else {
          setTimeout(() => {
            setRoleAnnounce({ role: msg.role, round: msg.round });
            setInputBlocked(true);
            setTimeout(() => {
              setRoleAnnounce(null);
              setInputBlocked(false);
              startTimer(computeRemainingSeconds());
            }, 500);
          }, 2000);
        }
        break;

      case 'zone_locked':
        setZoneLocked(true);
        setWaitingOpponent(true);
        stopTimer();
        break;

      case 'round_result':
        clearWaitingBotMoveTimer();
        handleRoundResult(msg);
        break;

      case 'match_result':
        // Идемпотентность: если matchEndedRef уже выставлен — мы уже завершали матч, выходим.
        // Без этого watchdog мог делать второй setScreen/playSound, плюс свежий poll мог
        // на доли секунды вернуть UI в game и result-экран моргал.
        if (matchEndedRef.current) break;
        matchEndedRef.current = true;
        clearRoundStuckTimer();
        clearMoveWatchdog();
        clearWaitingBotMoveTimer();
        // Останавливаем polling — больше никаких applyPvpRoomState и переключений screen
        if (playModeRef.current === 'pvp') {
          stopPvpPolling();
          pvpRoomIdRef.current = null;
          try { sessionStorage.removeItem('sp_active_room'); } catch {}
        }
        // Чистим все остаточные анимационные таймеры финального раунда + сбрасываем showingResult/overtime.
        resetAnimationAll();
        playSound('whistle_end');
        setTimeout(() => {
          setMatchResult({ youWon: msg.youWon, scores: msg.scores });
          setScreen('result');
          if (playModeRef.current === 'pvp' && !matchSavedRef.current) {
            saveMatchToBackend({
              youWon: msg.youWon,
              finalScores: msg.scores,
              finalHistory: matchRef.current?.history || history,
              matchSavedRef,
              initData: tgInitDataRef.current,
              displayName,
              opponent,
              opponentTgId: pvpOpponentTgIdRef.current,
              opponentIsBot: pvpOpponentIsBotRef.current,
              suddenDeath,
            });
          }
          if (msg.youWon) {
            confetti({ particleCount: 200, spread: 100, origin: { y: 0.5 } });
            if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
          } else {
            if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
          }
        }, 300);
        break;

      case 'opponent_left':
        clearRoundStuckTimer();
        clearMoveWatchdog();
        clearWaitingBotMoveTimer();
        setMatchResult({ youWon: true, scores: [0, 0], opponentLeft: true });
        setScreen('result');
        break;
    }
  }, [history, overtimeAnnounce]);

  // clearMoveWatchdog приходит из usePvpSubmit (см. ниже).

  // ==================== HTTP POLLING ====================
  // Сетевой слой polling-а — в usePvpPolling, преобразование room.state_json в события —
  // в useApplyRoomState. handleServerMessage оркеструет события и UI-state.
  const { applyPvpRoomState } = useApplyRoomState({
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
    setAcceptInfo,
    setScreen,
    setPlayerIndex,
    setOpponent,
    setCurrentStakeTon,
    setConfirmedZone,
    setSelectedZone,
    setMatchResult,
    stopPvpPolling,
    handleServerMessage,
  });

  // PvP submit-ветка: pvpSubmitMove + retry + watchdog. Зависит от applyPvpRoomState (выше).
  const { submitPvpZone, cancelPvpWait, clearMoveWatchdog, pvpMoveWatchdogTimerRef } = usePvpSubmit({
    pvpRoomIdRef,
    initDataRef: tgInitDataRef,
    pvpMoveCommittedRef,
    lastSubmittedZoneRef,
    selectedZoneRef,
    turnIdRef,
    setSelectedZone,
    setZoneLocked,
    setWaitingOpponent,
    stopTimer,
    enableFastPolling,
    pvpPollState,
    applyPvpRoomState,
    showBottomNotice,
  });

  // Demo-bot ветка: локальная игра без сети. Снапшоты round/scores/history/suddenDeath
  // передаются getter'ом — иначе chooseDemoZone пересоздавался бы каждый рендер.
  const demoSnapshotRef = useRef({ round, scores, history, suddenDeath, suddenDeathStartRound });
  useEffect(() => {
    demoSnapshotRef.current = { round, scores, history, suddenDeath, suddenDeathStartRound };
  }, [round, scores, history, suddenDeath, suddenDeathStartRound]);

  const getDemoSnapshot = useCallback(() => demoSnapshotRef.current, []);
  const { chooseDemoZone } = useDemoBot({
    lastSubmittedZoneRef,
    selectedZoneRef,
    setSelectedZone,
    setZoneLocked,
    setWaitingOpponent,
    setSuddenDeathStartRound,
    stopTimer,
    handleServerMessage,
    getDemoSnapshot,
  });

  // Тонкий диспетчер: маршрутизирует тип сообщения и playMode в соответствующий хук.
  // Сохраняет ту же сигнатуру что и старый sendMessage, чтобы handleChooseZone/useGameTimer
  // могли звать sendMessage(type, data) без изменений.
  const sendMessage = useCallback((type, data = {}) => {
    const mode = playModeRef.current;
    if (mode === 'pvp') {
      if (type === 'cancel_wait') { cancelPvpWait(); return; }
      if (type === 'choose_zone') { submitPvpZone(data.zone); return; }
      return;
    }
    if (mode === 'demo-bot') {
      if (type === 'choose_zone') { chooseDemoZone(data.zone); return; }
    }
  }, [playModeRef, cancelPvpWait, submitPvpZone, chooseDemoZone]);

  // Подсасываем sendMessage в forward-ref для useGameTimer.
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  // onMatchResultFallback — финальный watchdog в useGameAnimation зовёт handleServerMessage
  // через ref, потому что handleServerMessage определена ниже useGameAnimation.
  useEffect(() => {
    onMatchResultFallbackRef.current = ({ youWon, scores }) => {
      handleServerMessage({ type: 'match_result', youWon, scores: scores || [0, 0] });
    };
  }, [handleServerMessage]);

  const askStakeOptions = () => {
    if (!selectedStakeOptions.length) {
      showBottomNotice('Выбери минимум одну ставку');
      return null;
    }
    return selectedStakeOptions.slice().sort((a, b) => a - b);
  };

  const toggleStakeOption = (stake) => {
    if (Number(balanceTon || 0) < Number(stake)) {
      showBottomNotice('У вас недостаточно денег на балансе');
      return;
    }
    setSelectedStakeOptions((prev) => (
      prev.includes(stake) ? prev.filter((x) => x !== stake) : [...prev, stake]
    ));
  };

  // Lifecycle действия (старт матчмейкинга, демо, отмена, заново, выход) вынесены
  // в useMatchLifecycle. Подсасываем актуальные ссылки applyPvpRoomState/goHome/startSearchOnline
  // в forward-refs для usePvpPolling (хук объявлен выше них).
  const {
    startSearchOnline,
    startSearchBot,
    handleCancelWait,
    handlePlayAgain,
    handleExitToMenu,
  } = useMatchLifecycle({
    displayName,
    askStakeOptions,
    initDataRef: tgInitDataRef,
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
    showBottomNotice,
    startPvpPolling,
    stopPvpPolling,
    applyPvpRoomState,
    handleServerMessage,
  });

  // Подсасываем актуальные ссылки в forward-refs для usePvpPolling.
  useEffect(() => {
    applyPvpRoomStateRef.current = applyPvpRoomState;
    goHomeRef.current = goHome;
    startSearchOnlineRef.current = startSearchOnline;
  });

  const handleChooseZone = (zone) => {
    if (![0, 1, 2, 3].includes(Number(zone))) return;
    // Атомарная защита через ref: state-based zoneLocked может быть stale между двумя тапами
    // в одном React tick (batched update), что давало рассинхрон «мишень светит B, мяч летит в A».
    if (selectedZoneRef.current !== null && selectedZoneRef.current !== undefined) return;
    if (lastSubmittedZoneRef.current !== null && lastSubmittedZoneRef.current !== undefined) return;
    if (showingResultRef.current || inputBlocked || roleAnnounce) return;
    const z = Number(zone);
    selectedZoneRef.current = z;
    setSelectedZone(z);
    sendMessage('choose_zone', { zone: z });
  };

  useEffect(() => {
    if (launchHandledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const launchMode = String(params.get('launch') || '').toLowerCase();
    if (launchMode !== 'play' && launchMode !== 'demo') return;
    launchHandledRef.current = true;
    if (launchMode === 'demo') {
      setScreen('demo-intro');
    } else {
      const roomId = params.get('roomId');
      if (roomId) {
        // Случайная игра — сразу подключаемся к комнате
        tgInitDataRef.current = window.Telegram?.WebApp?.initData || tgInitDataRef.current || '';
        pvpRoomIdRef.current = Number(roomId);
        playModeRef.current = 'pvp';
        // Восстанавливаем ставку из URL для кнопки "Играть снова"
        const stakeFromUrl = Number(params.get('stake') || 0);
        if (stakeFromUrl > 0) setSelectedStakeOptions([stakeFromUrl]);
        setScreen('waiting');
        startPvpPolling();
      } else {
        setScreen('stake-online');
      }
    }
  }, []);

  // ==================== RENDER ====================

  const darkBg = "bg-[#121214]";

  if (screen === 'menu') return null;

  if (screen === 'demo-intro') {
    return (
      <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none`} style={safeFrameStyle}>
        <div className="z-10 w-full max-w-sm px-5 text-center">
          <h1 className="text-3xl font-black text-white">ПЕНАЛЬТИ</h1>
          <p className="text-gray-300 text-sm mt-3 leading-relaxed">
            PvP режим с автоматическим подбором соперника. Если нет игроков онлайн — 
            система подключит бота. Минимальная ставка 0.1 TON.
          </p>
          <button onClick={() => startSearchBot()} className="w-full mt-5 bg-emerald-500 hover:bg-emerald-400 text-black font-black py-3 rounded-xl">Играть</button>
          <button onClick={() => goHome()} className="w-full mt-2 bg-white/5 border border-white/15 text-white py-3 rounded-xl">Назад</button>
        </div>
      </div>
    );
  }

  if (screen === 'waiting') {
    return (
      <WaitingScreen
        darkBg={darkBg}
        safeFrameStyle={safeFrameStyle}
        selectedStakeOptions={selectedStakeOptions}
        acceptInfo={acceptInfo}
        acceptTick={acceptTick}
        onCancel={handleCancelWait}
      />
    );
  }

  if (screen === 'stake-online') {
    return (
      <StakeSelectScreen
        darkBg={darkBg}
        safeFrameStyle={safeFrameStyle}
        selectedStakeOptions={selectedStakeOptions}
        balanceTon={balanceTon}
        bottomNotice={bottomNotice}
        onToggleStake={toggleStakeOption}
        onStart={() => startSearchOnline()}
        onBack={() => goHome()}
      />
    );
  }

  if (screen === 'result' && matchResult) {
    return (
      <ResultScreen
        darkBg={darkBg}
        safeFrameStyle={safeFrameStyle}
        matchResult={matchResult}
        playerIndex={playerIndex}
        displayName={displayName}
        opponent={opponent}
        history={history}
        suddenDeath={suddenDeath}
        suddenDeathStartRound={suddenDeathStartRound}
        currentStakeTon={currentStakeTon}
        playMode={playModeRef.current}
        onExit={handleExitToMenu}
        onPlayAgain={handlePlayAgain}
      />
    );
  }

  // --- GAME SCREEN ---
  return (
    <GameScreen
      safeFrameGameStyle={safeFrameGameStyle}
      assetBase={ASSET_BASE}
      displayName={displayName}
      opponent={opponent}
      playerIndex={playerIndex}
      scores={scores}
      currentStakeTon={currentStakeTon}
      suddenDeath={suddenDeath}
      suddenDeathStartRound={suddenDeathStartRound}
      history={history}
      timer={timer}
      role={role}
      zoneLocked={zoneLocked}
      showingResult={showingResult}
      inputBlocked={inputBlocked}
      roleAnnounce={roleAnnounce}
      overtimeAnnounce={overtimeAnnounce}
      waitingOpponent={waitingOpponent}
      bottomNotice={bottomNotice}
      ballVisible={ballVisible}
      ballStyle={ballStyle}
      keeperState={keeperState}
      isKeeperMirrored={isKeeperMirrored}
      keeperX={keeperX}
      keeperBottom={keeperBottom}
      keeperTransitionDisabled={keeperTransitionDisabled}
      resultMessage={resultMessage}
      selectedZone={selectedZone}
      confirmedZone={confirmedZone}
      showConnectionError={showConnectionError}
      setShowConnectionError={setShowConnectionError}
      pvpPollInFlightRef={pvpPollInFlightRef}
      handleChooseZone={handleChooseZone}
      handleExitToMenu={handleExitToMenu}
      pvpPollState={pvpPollState}
    />
  );
};

export default GamePage;

