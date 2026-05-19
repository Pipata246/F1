import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import confetti from 'canvas-confetti';
import { motion, AnimatePresence } from 'framer-motion';
import { createClient } from '@supabase/supabase-js';
import { TmaTopSafe } from '../components/TmaTopSafe.jsx';
import { zoneTargetCenters, targetPositions, keeperZonePos } from '../lib/zonePositions.js';
import {
  armAudioOnGesture,
  preloadSounds,
  playSound,
  startBackground,
  stopBackground,
  isAudioReady,
  appSettings,
} from '../lib/sound.js';
import { GrassSVG } from '../components/GrassSVG.jsx';
import { KickDots } from '../components/KickDots.jsx';
import { Keeper } from '../components/Keeper.jsx';
import { Ball } from '../components/Ball.jsx';
import { TargetZones } from '../components/TargetZones.jsx';
import { ConnectionErrorModal } from '../components/ConnectionErrorModal.jsx';
import { WaitingScreen } from '../components/screens/WaitingScreen.jsx';
import { StakeSelectScreen } from '../components/screens/StakeSelectScreen.jsx';
import { ResultScreen } from '../components/screens/ResultScreen.jsx';
import { useTelegramWebApp } from '../hooks/useTelegramWebApp.js';
import { useMatchResume } from '../hooks/useMatchResume.js';
import { apiPost } from '../lib/api.js';
import { usePvpPolling } from '../hooks/usePvpPolling.js';
import { useMatchLifecycle } from '../hooks/useMatchLifecycle.js';
import { useGameTimer } from '../hooks/useGameTimer.js';
import { useGameAnimation } from '../hooks/useGameAnimation.js';
import { usePvpSubmit } from '../hooks/usePvpSubmit.js';
import { useDemoBot } from '../hooks/useDemoBot.js';

const SUPABASE_URL = 'https://eolycsnxboeobasolczb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbHljc254Ym9lb2Jhc29sY3piIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3Njg0NTQsImV4cCI6MjA5MTM0NDQ1NH0.EVU6xdTy1S_9y5fgq4-AJJQHO-WPlNu3bFHgG617eJA';
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

  const wsRef = useRef(null);
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
  const pvpLastTurnKeyRef = useRef('');
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
  // Supabase Realtime - НЕ ИСПОЛЬЗУЕМ, только HTTP polling
  const realtimeChannelRef = useRef(null);

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

    // Нормальный flow: бот 0.3-1с + poll 0.8с + анимация 2.5с ≈ 4.6с висит waitingOpponent.
    // Recovery таймеры начинаются ПОСЛЕ этого окна, чтобы не мешать обычной игре.

    // 8 сек: force poll (тикнет pvpAdvanceByTime, бот сходит если завис)
    timers.push(setTimeout(() => {
      if (!waitingOpponent || matchEndedRef.current) return;
      pvpPollInFlightRef.current = false;
      pvpPollState();
    }, 8000));

    // 14 сек: forced poll, чтобы подтянуть актуальный state.
    // Раньше тут был ВТОРОЙ submit без turnId — это создавало баг: за 14 сек раунд мог
    // смениться, ретрай записывал зону прошлого раунда в новый. Удалили retry.
    // Если первый submit не прошёл по сети — fast polling + серверный auto-resolve справятся.
    timers.push(setTimeout(() => {
      if (!waitingOpponent || matchEndedRef.current) return;
      pvpPollInFlightRef.current = false;
      pvpPollState();
    }, 14000));

    // 22 сек: модалка с выходом
    timers.push(setTimeout(() => {
      if (!waitingOpponent || matchEndedRef.current) return;
      setShowConnectionError(true);
    }, 22000));

    return () => { timers.forEach(clearTimeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingOpponent, screen]);

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
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      // timer чистится auto-cleanup'ом в useGameTimer
      // pvpPollTimer и connectionErrorTimer чистятся auto-cleanup'ом в usePvpPolling
      if (localFindTimerRef.current) clearTimeout(localFindTimerRef.current);
      if (pvpFindRetryTimerRef.current) clearTimeout(pvpFindRetryTimerRef.current);
      if (roundStuckTimerRef.current) clearTimeout(roundStuckTimerRef.current);
      if (waitingBotMoveTimerRef.current) clearTimeout(waitingBotMoveTimerRef.current);
      if (waitingOpponentTimerRef.current) clearTimeout(waitingOpponentTimerRef.current);
      if (realtimeChannelRef.current) {
        supabaseClient.removeChannel(realtimeChannelRef.current);
        realtimeChannelRef.current = null;
      }
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
            saveMatchToBackend(msg.youWon, msg.scores, matchRef.current?.history || history);
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
  // Сетевой слой polling-а вынесен в usePvpPolling. applyPvpRoomState остаётся здесь как
  // callback, потому что глубоко связан с UI-state и handleServerMessage.
  const stopRealtimeSubscription = useCallback(() => {}, []);

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
      // Идемпотентность завершения матча инкапсулирована в case 'match_result' (handleServerMessage).
      // Здесь только готовим данные и единожды вызываем — без двойного cleanup'а.
      if (matchEndedRef.current) return;
      stopRealtimeSubscription();

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
      const myTgAccept = String(window.Telegram?.WebApp?.initDataUnsafe?.user?.id || '');
      const meIsP1Accept = String(room.player1_tg_user_id || '') === myTgAccept;
      const deadlineMs = Number(am.deadlineMs || 0);
      
      // Check if timer expired - if yes, wait for next poll to get turn_input phase
      if (deadlineMs > 0 && Date.now() >= deadlineMs) {
        // Timer expired but still in accept_match - wait for backend to transition
        setScreen('waiting');
        return;
      }
      
      setAcceptInfo({
        p1: room.player1_name || 'Игрок 1',
        p2: room.player2_name || 'Игрок 2',
        stake: room.stake_ton != null ? Number(room.stake_ton) : null,
        deadlineMs: deadlineMs,
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
    
    // Only transition to game screen if we're past accept phase
    if (s.phase === 'accept_match') {
      // Still in accept phase - stay on waiting screen
      return;
    }
    
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
      // Те же явные null/undefined-проверки чтобы не подставить 0 случайно.
      const rrKickerIdx = Number(rr.kickerIndex || 0);
      const myRaw = rrKickerIdx === myIdx ? rr.kickerZone : rr.keeperZone;
      let myZoneInResult = null;
      if (myRaw !== null && myRaw !== undefined) {
        const n = Number(myRaw);
        if (Number.isInteger(n) && n >= 0 && n <= 3) myZoneInResult = n;
      }
      if (myZoneInResult !== null) {
        setConfirmedZone(myZoneInResult);
      }
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
      return;
    }
  }, [handleServerMessage, stopPvpPolling, stopRealtimeSubscription]);

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
      return;
    }
    if (mode === 'bot') {
      showBottomNotice('Режим бота больше не поддерживается. Используй PvP.');
    }
  }, [playModeRef, cancelPvpWait, submitPvpZone, chooseDemoZone, showBottomNotice]);

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
    wsRef,
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
    stopRealtimeSubscription,
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

  const saveMatchToBackend = (youWon, finalScores, finalHistory) => {
    if (matchSavedRef.current || !tgInitDataRef.current) return;
    matchSavedRef.current = true;
    const tgUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || null;
    fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'recordMatch',
        initData: tgInitDataRef.current,
        payload: {
          gameKey: 'super_penalty',
          mode: 'pvp',
          winnerTgUserId: youWon ? tgUserId : null,
          players: [
            { tgUserId, name: displayName || 'Player', score: finalScores?.[0] || 0, isWinner: !!youWon, isBot: false },
            { tgUserId: pvpOpponentTgIdRef.current || null, name: opponent || 'Opponent', score: finalScores?.[1] || 0, isWinner: !youWon, isBot: pvpOpponentIsBotRef.current },
          ],
          score: { left: finalScores?.[0] || 0, right: finalScores?.[1] || 0 },
          details: { roundsPlayed: finalHistory?.length || 0, suddenDeath },
        },
      }),
    }).catch(() => { matchSavedRef.current = false; });
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

  // --- GAME SCREEN --- (green grass background only here)
  const myScore = scores[playerIndex] ?? 0;
  const oppScore = scores[1 - playerIndex] ?? 0;

  return (
    <div className="h-screen bg-[#1a6b35] flex flex-col items-center overflow-hidden font-sans select-none relative" style={{ ...safeFrameGameStyle, contain: 'layout style paint', touchAction: 'manipulation' }}>
      <TmaTopSafe variant="grass" />
      {/* Green field gradient */}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,_#145a2a_0%,_#1a6b35_30%,_#1e7a3c_60%,_#196330_100%)] pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_20%,_rgba(255,255,255,0.04),_transparent_50%)] pointer-events-none" />

      {/* Grass blades at bottom */}
      <GrassSVG />

      {/* Scoreboard */}
      <div className="z-10 w-full px-4 pt-3 mb-1">
        <div className="bg-black/40 backdrop-blur-md p-3 rounded-2xl border border-white/10 shadow-lg">
          {currentStakeTon != null && (
            <div className="text-center text-xs text-emerald-300 font-bold tracking-wider mb-2">СТАВКА: {currentStakeTon} TON</div>
          )}
          {/* Scores row */}
          <div className="flex justify-between items-center">
            <div className="flex-1 text-center">
              <p className="text-[10px] text-blue-400 font-bold uppercase tracking-widest truncate">{displayName || 'Ты'}</p>
              <p className="text-3xl font-black text-blue-400">{myScore}</p>
            </div>
            <div className="flex flex-col items-center px-3">
              <span className="text-2xl text-white/30 font-bold">:</span>
              {suddenDeath && (
                <span className="text-[10px] text-red-400 font-bold uppercase animate-pulse">ОВЕРТАЙМ</span>
              )}
            </div>
            <div className="flex-1 text-center">
              <p className="text-[10px] text-red-400 font-bold uppercase tracking-widest truncate">{opponent}</p>
              <p className="text-3xl font-black text-red-400">{oppScore}</p>
            </div>
          </div>

          {/* Centered kick dots */}
          <div className="mt-2 flex flex-col items-center gap-1">
            <KickDots 
              history={history} 
              playerIdx={playerIndex} 
              totalKicks={suddenDeath ? 1 : 5} 
              label={displayName || 'Ты'} 
              color="text-blue-400"
              suddenDeath={suddenDeath}
              suddenDeathStartRound={suddenDeathStartRound}
            />
            <KickDots 
              history={history} 
              playerIdx={1 - playerIndex} 
              totalKicks={suddenDeath ? 1 : 5} 
              label={opponent} 
              color="text-red-400"
              suddenDeath={suddenDeath}
              suddenDeathStartRound={suddenDeathStartRound}
            />
          </div>

          {/* Timer */}
          <div className="flex justify-center items-center mt-2 gap-2 h-5">
            <span
              className={`text-sm font-mono font-bold ${timer <= 3 ? 'text-red-400 animate-pulse' : 'text-white/40'}`}
              style={{ visibility: (!zoneLocked && !showingResult) ? 'visible' : 'hidden' }}
            >
              {timer}с
            </span>
          </div>
        </div>
      </div>

      {/* Role announcement removed — text moved below ball */}

      {/* Role announcement overlay */}
      <AnimatePresence>
        {roleAnnounce && (
          <motion.div
            key={`role-${roleAnnounce.round}`}
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none"
          >
            <div className={`px-10 py-5 rounded-2xl shadow-2xl text-center border-2 ${
              roleAnnounce.role === 'kicker'
                ? 'bg-black/85 border-yellow-400 shadow-yellow-500/40'
                : 'bg-black/85 border-emerald-400 shadow-emerald-500/40'
            }`}>
              <div className="text-4xl mb-2">
                {roleAnnounce.role === 'kicker' ? '⚽' : '🧤'}
              </div>
              <div className={`text-2xl font-black tracking-widest uppercase ${
                roleAnnounce.role === 'kicker' ? 'text-yellow-300' : 'text-emerald-300'
              }`}>
                {roleAnnounce.role === 'kicker' ? 'ТВОЙ УДАР!' : 'ОТБИВАЙ МЯЧ!'}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overtime announcement overlay */}
      <AnimatePresence>
        {overtimeAnnounce && (
          <motion.div
            key="overtime-announce"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none"
          >
            <div className="px-10 py-5 rounded-2xl shadow-2xl text-center border-4 bg-black/90 border-red-400 shadow-red-500/40">
              <div className="text-6xl mb-3 animate-pulse">⚡</div>
              <div className="text-4xl font-black tracking-widest uppercase text-red-400 mb-2">
                ОВЕРТАЙМ!
              </div>
              <div className="text-lg text-white/80 font-bold">
                Серия пенальти до первого гола
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Gate area + field markings */}
      <div className="relative z-10 w-[360px] h-[280px] mt-1 mx-auto flex justify-center">
        {/* Penalty area lines */}
        <div className="absolute bottom-[-80px] left-1/2 -translate-x-1/2 w-[280px] h-[60px] border-2 border-white/15 pointer-events-none z-0" />
        {/* Penalty spot */}
        <div className="absolute bottom-[-70px] left-1/2 -translate-x-1/2 w-[8px] h-[8px] rounded-full bg-white/25 pointer-events-none z-0" />
        <motion.div
          className="relative w-full h-full"
          style={{ willChange: 'transform' }}
        >
          <img src={`${ASSET_BASE}gate.png`} alt="Gate" className="absolute inset-0 w-full h-full object-contain z-0 drop-shadow-[0_20px_50px_rgba(0,0,0,0.5)]" />
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 w-[200px] h-[40px] bg-black/40 blur-xl rounded-[100%] z-0" />

          {/* Keeper */}
          <Keeper
            assetBase={ASSET_BASE}
            role={role}
            keeperState={keeperState}
            keeperX={keeperX}
            keeperBottom={keeperBottom}
            isKeeperMirrored={isKeeperMirrored}
            transitionDisabled={keeperTransitionDisabled}
          />

          <Ball assetBase={ASSET_BASE} visible={ballVisible} style={ballStyle} />

          <TargetZones
            role={role}
            displayedZone={confirmedZone != null ? confirmedZone : selectedZone}
            visible={!inputBlocked && !roleAnnounce && !showingResult && (role === 'kicker' || role === 'keeper')}
          />

          {/* Zone buttons */}
          <div
            className={`absolute top-0 left-4 w-[calc(100%-2rem)] h-[85%] grid grid-cols-2 grid-rows-2 z-30 ${inputBlocked || !!roleAnnounce ? 'pointer-events-none' : ''}`}
          >
            {[0, 1, 2, 3].map((zone) => (
              <button
                key={zone}
                type="button"
                tabIndex={-1}
                onClick={() => handleChooseZone(zone)}
                onMouseDown={(e) => e.preventDefault()}
                disabled={zoneLocked || showingResult || inputBlocked || !!roleAnnounce}
                className={`w-full h-full outline-none transition-colors rounded-lg ${
                  zoneLocked || showingResult ? 'cursor-default' : 'hover:bg-white/10 active:bg-white/20'
                }`}
              />
            ))}
          </div>

          {/* Result overlay */}
          <AnimatePresence>
            {resultMessage && (
              <motion.div
                initial={{ opacity: 0, scale: 0.5, y: 50 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.5 }}
                className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none"
              >
                <div className="relative">
                  <h1 className={`text-7xl font-black italic tracking-tighter drop-shadow-[0_5px_5px_rgba(0,0,0,1)]
                    ${resultMessage.type === 'win'
                      ? 'text-transparent bg-clip-text bg-gradient-to-b from-[#4aff93] to-[#00b548]'
                      : 'text-transparent bg-clip-text bg-gradient-to-b from-[#ff6b6b] to-[#c90000]'
                    }`}>
                    {resultMessage.text}
                  </h1>
                  <h1 className={`absolute inset-0 text-7xl font-black italic tracking-tighter -z-10 ${resultMessage.type === 'win' ? 'text-green-900' : 'text-red-900'}`}
                    style={{ WebkitTextStroke: '2px black' }}>
                    {resultMessage.text}
                  </h1>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>

      {/* Status text — below ball (fixed height to prevent layout jump) */}
      <div className="mt-14 z-10 h-6 flex items-center justify-center">
        {waitingOpponent && !showingResult ? (
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-white/40 border-t-transparent rounded-full animate-spin" />
            <p className="text-white/40 text-sm font-bold">Ожидание соперника...</p>
          </div>
        ) : (!zoneLocked && !showingResult) ? (
          <p className={`text-sm font-bold tracking-[0.2em] ${
            role === 'kicker' ? 'text-yellow-400/80' : 'text-blue-300/80'
          }`}>
            {role === 'kicker' ? '⚽ Выбери куда бить' : '🧤 Выбери куда прыгать'}
          </p>
        ) : null}
      </div>
      
      {/* Connection Error Modal */}
      <AnimatePresence>
        <ConnectionErrorModal
          visible={showConnectionError}
          onRetry={() => {
            setShowConnectionError(false);
            pvpPollInFlightRef.current = false;
            pvpPollState();
          }}
          onExit={() => {
            setShowConnectionError(false);
            handleExitToMenu();
          }}
        />
      </AnimatePresence>
      
      {!!bottomNotice && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[9999] bg-black/90 text-white text-sm font-bold px-4 py-2 rounded-xl">
          {bottomNotice}
        </div>
      )}
    </div>
  );
};

export default GamePage;

