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
  const [timer, setTimer] = useState(10);
  const [history, setHistory] = useState([]);
  const [selectedZone, setSelectedZone] = useState(null); // pending — локальный выбор до подтверждения сервером
  // A1: confirmedZone из server (room.state_json.choices[mySide] или lastRoundResult).
  // Мишень рендерится по (confirmedZone ?? selectedZone). После подтверждения сервером
  // мишень мгновенно переключается на серверную зону — невозможен рассинхрон с мячом.
  const [confirmedZone, setConfirmedZone] = useState(null);

  // Animation state
  const [ballVisible, setBallVisible] = useState(true);
  const [ballStyle, setBallStyle] = useState({});
  const [keeperState, setKeeperState] = useState('idle');
  const [isKeeperMirrored, setIsKeeperMirrored] = useState(false);
  const [keeperX, setKeeperX] = useState(0);
  const [keeperBottom, setKeeperBottom] = useState('4');
  const [resultMessage, setResultMessage] = useState(null);
  const [showingResult, setShowingResult] = useState(false);
  // Когда true — у keeper-<div> и <img> transition='none'. Используется для мгновенного
  // сброса позиции/текстуры/высоты вратаря без обратной анимации (которая воспринимается
  // игроками как «вторая анимация» одного и того же хода).
  const [keeperTransitionDisabled, setKeeperTransitionDisabled] = useState(false);

  // Role announcement
  const [roleAnnounce, setRoleAnnounce] = useState(null);
  const [inputBlocked, setInputBlocked] = useState(false);

  // Overtime announcement
  const [overtimeAnnounce, setOvertimeAnnounce] = useState(false);

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
  const timerRef = useRef(null);
  const playerIndexRef = useRef(0);
  const matchRef = useRef(null);
  const tgInitDataRef = useRef('');
  const matchSavedRef = useRef(false);
  /** Как в frog-hunt: только один из режимов — онлайн (pvp) или локальный бот, никогда оба сразу. */
  const playModeRef = useRef('idle');
  const pvpRoomIdRef = useRef(null);
  const pvpOpponentTgIdRef = useRef(null);
  const pvpOpponentIsBotRef = useRef(false);
  const pvpPollTimerRef = useRef(null);
  const pvpPollInFlightRef = useRef(false);
  const pvpLastRoundMarkerRef = useRef(0);
  const pvpLastStartKeyRef = useRef('');
  const pvpMoveCommittedRef = useRef(false);
  const pvpLastTurnKeyRef = useRef('');
  const selectedZoneRef = useRef(null);
  const matchEndedRef = useRef(false);
  const lastSubmittedZoneRef = useRef(null);
  const PVP_POLL_MS = 800; // HTTP polling каждые 800мс как в Frog Hunt
  const PVP_POLL_FAST_MS = 200; // Быстрый polling в критические моменты (ускорено с 300мс)
  const pvpPollFastModeRef = useRef(false); // Флаг быстрого режима
  // A4: reconciliation против out-of-order ответов и stale poll'ов
  const lastAppliedUpdatedAtRef = useRef(0); // ms of room.updated_at
  const pvpPollRequestIdRef = useRef(0); // монотонный id для каждого poll
  // A2: signature последнего запущенного round_result + список таймеров анимации.
  // Защищает от двойного запуска анимации одного хода (особенно в demo-bot, где marker check
  // в applyPvpRoomState не работает — там прямой handleServerMessage).
  const lastAnimSignatureRef = useRef('');
  const animTimersRef = useRef([]);
  // Fix #2: отдельный список таймеров overtime modal'и. НЕ чистится при новом раунде
  // (иначе скрывающий setTimeout не успеет сработать и модалка висит весь овертайм).
  const overtimeTimersRef = useRef([]);
  const overtimeAnnounceRef = useRef(false);
  // A3: текущий turnId раунда, обновляется из poll. Привязывает submit к конкретному раунду.
  const turnIdRef = useRef('');
  // Дельта между clock-ами клиента и сервера: clientNow - serverNow (мс).
  // Позволяет вычислять "сколько на сервере уже прошло" с момента phaseAtMs не зависимо
  // от разъезда системных часов клиента и сервера.
  const serverClockOffsetMsRef = useRef(0);
  const localFindTimerRef = useRef(null);
  const pvpFindRetryTimerRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const launchHandledRef = useRef(false);
  const showingResultRef = useRef(false);
  const roundStuckTimerRef = useRef(null);
  const waitingBotMoveTimerRef = useRef(null);
  const pvpMoveWatchdogTimerRef = useRef(null); // Watchdog: защита от зависания после хода
  const connectionErrorTimerRef = useRef(null); // Таймер для показа ошибки соединения
  const lastSuccessfulPollRef = useRef(Date.now()); // Время последнего успешного poll
  const waitingOpponentTimerRef = useRef(null); // Таймер для отслеживания долгого ожидания
  // Supabase Realtime - НЕ ИСПОЛЬЗУЕМ, только HTTP polling
  const realtimeChannelRef = useRef(null);

  useEffect(() => { playerIndexRef.current = playerIndex; }, [playerIndex]);
  useEffect(() => { showingResultRef.current = showingResult; }, [showingResult]);
  useEffect(() => { selectedZoneRef.current = selectedZone; }, [selectedZone]);
  // Fix #2: синхронный ref для overtimeAnnounce — round_start handler читает его без React batch-задержки
  useEffect(() => { overtimeAnnounceRef.current = overtimeAnnounce; }, [overtimeAnnounce]);

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

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tgInitDataRef.current = tg?.initData || '';
    
    // Скрываем кнопку "Назад" в Telegram - не используем её
    if (tg?.BackButton) {
      tg.BackButton.hide();
    }
    
    // ОТКЛЮЧАЕМ ВСЕ УВЕДОМЛЕНИЯ TELEGRAM
    if (tg) {
      tg.disableClosingConfirmation();
    }
    
    const u = tg?.initDataUnsafe?.user;
    const fallback = u?.first_name || 'Player';
    const init = tgInitDataRef.current;
    if (!init) {
      setDisplayName(fallback);
      return;
    }
    fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'authSession', initData: init }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data?.ok && data.user?.display_name) {
          setDisplayName(String(data.user.display_name).slice(0, 64));
          setBalanceTon(Number(data.user.balance || 0));
        } else {
          setDisplayName(fallback);
          setBalanceTon(0);
        }
      })
      .catch(() => {
        setDisplayName(fallback);
        setBalanceTon(0);
      });
  }, []);
  
  const showBottomNotice = useCallback((msg) => {
    setBottomNotice(String(msg || ''));
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setBottomNotice(''), 2200);
  }, []);
  
  const apiPost = useCallback(async (payload) => {
    const res = await fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return res.json();
  }, []);
  
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
    
    // Останавливаем polling
    if (pvpPollTimerRef.current) {
      clearInterval(pvpPollTimerRef.current);
      pvpPollTimerRef.current = null;
    }
    
    playModeRef.current = 'idle';
    pvpRoomIdRef.current = null;
    
    // ОТКЛЮЧАЕМ ВСЕ УВЕДОМЛЕНИЯ перед переходом
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.disableClosingConfirmation();
    }
    
    // Переходим на ГЛАВНУЮ СТРАНИЦУ (не игры, а сайта) БЕЗ ЗАДЕРЖКИ
    // Используем replace чтобы не добавлять в историю
    window.location.replace('/');
  }, []);

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

  // A7: при mount проверяем sessionStorage на наличие активного матча и пробуем переподключиться.
  // Если матч ещё активен на сервере — восстанавливаем UI и polling. Иначе чистим storage.
  useEffect(() => {
    const stored = (() => { try { return sessionStorage.getItem('sp_active_room'); } catch { return null; } })();
    if (!stored) return;
    const storedRoomId = Number(stored);
    if (!Number.isInteger(storedRoomId) || storedRoomId <= 0) {
      try { sessionStorage.removeItem('sp_active_room'); } catch {}
      return;
    }
    // Ждём, пока tgInitData загрузится (он set'ится в другом useEffect)
    const tryReconnect = () => {
      const init = tgInitDataRef.current;
      if (!init) {
        setTimeout(tryReconnect, 200);
        return;
      }
      fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pvpGetMyActiveRoom', initData: init, gameKey: 'super_penalty' }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (!data?.ok || !data.room) {
            try { sessionStorage.removeItem('sp_active_room'); } catch {}
            return;
          }
          if (Number(data.room.id) !== storedRoomId) {
            try { sessionStorage.removeItem('sp_active_room'); } catch {}
            return;
          }
          // Восстанавливаем матч
          pvpRoomIdRef.current = Number(data.room.id);
          playModeRef.current = 'pvp';
          matchEndedRef.current = false;
          // Сразу запускаем polling — он принесёт актуальный state и applyPvpRoomState разрулит UI
          startPvpPolling();
        })
        .catch(() => { try { sessionStorage.removeItem('sp_active_room'); } catch {} });
    };
    tryReconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A7: при входе в активный матч сохраняем roomId, при выходе — чистим
  useEffect(() => {
    if (playModeRef.current === 'pvp' && pvpRoomIdRef.current && screen === 'game') {
      try { sessionStorage.setItem('sp_active_room', String(pvpRoomIdRef.current)); } catch {}
    } else if (screen === 'result' || screen === 'stake-online' || screen === 'menu') {
      try { sessionStorage.removeItem('sp_active_room'); } catch {}
    }
  }, [screen]);


  useEffect(() => {
    if (screen !== 'accept') return undefined;
    const id = setInterval(() => setAcceptTick((v) => v + 1), 500);
    return () => clearInterval(id);
  }, [screen]);

  useEffect(() => {
    const ping = () => {
      const init = tgInitDataRef.current;
      if (!init) return;
      fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'presenceHeartbeat', initData: init }),
      }).catch(() => {});
    };
    ping();
    const id = setInterval(ping, 9000);
    const onVis = () => { if (document.visibilityState === 'visible') ping(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', ping);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', ping);
    };
  }, []);

  useEffect(() => {
    const leave = () => {
      const init = tgInitDataRef.current;
      if (!init) return;
      const payload = JSON.stringify({ action: 'presenceLeave', initData: init });
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
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, []);

  // A7: убрали авто-отправку pvpLeaveRoom на pagehide и pvpCancelQueue на visibility=hidden
  // в активном матче. Refresh/сворачивание Telegram больше не приводит к мгновенной потере
  // ставки. Сервер сам объявит leave по stale presence (через 45с) если игрок не вернётся.
  // При входе в waiting (поиск) на pagehide всё ещё отменяем очередь — отдельная логика.
  useEffect(() => {
    const onPageHide = () => {
      // Отменяем поиск только если игрок не в активном матче (screen === 'waiting' и ещё нет roomId с активной фазой)
      if (playModeRef.current !== 'pvp') return;
      const init = tgInitDataRef.current;
      const rid = pvpRoomIdRef.current;
      if (!init || !rid) return;
      // В waiting (accept / matchmaking) отменяем — иначе оппонент будет ждать в зомби-комнате
      if (screen !== 'game') {
        const payload = JSON.stringify({ action: 'pvpCancelQueue', initData: init, roomId: rid });
        try { if (navigator.sendBeacon) navigator.sendBeacon('/api/user', new Blob([payload], { type: 'application/json' })); } catch {}
        fetch('/api/user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
      }
      // В активном матче — НЕ leave. Сервер сам разберётся через stale presence.
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
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
      if (timerRef.current) clearInterval(timerRef.current);
      if (pvpPollTimerRef.current) clearInterval(pvpPollTimerRef.current);
      if (localFindTimerRef.current) clearTimeout(localFindTimerRef.current);
      if (pvpFindRetryTimerRef.current) clearTimeout(pvpFindRetryTimerRef.current);
      if (roundStuckTimerRef.current) clearTimeout(roundStuckTimerRef.current);
      if (waitingBotMoveTimerRef.current) clearTimeout(waitingBotMoveTimerRef.current);
      if (pvpMoveWatchdogTimerRef.current) clearTimeout(pvpMoveWatchdogTimerRef.current);
      if (connectionErrorTimerRef.current) clearTimeout(connectionErrorTimerRef.current);
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
        // A2: сбрасываем signature + чистим зависшие анимационные таймеры предыдущего раунда
        lastAnimSignatureRef.current = '';
        animTimersRef.current.forEach((t) => clearTimeout(t));
        animTimersRef.current = [];
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
        setShowingResult(false);
        setResultMessage(null);
        setBallVisible(true);
        setBallStyle({});
        setKeeperState('idle');
        setIsKeeperMirrored(false);
        setKeeperX(0);
        setKeeperBottom('4');
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
        // Чистим все остаточные анимационные таймеры финального раунда
        animTimersRef.current.forEach((t) => clearTimeout(t));
        animTimersRef.current = [];
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

  const startTimer = (initialSecondsParam) => {
    stopTimer();
    // Серверный auto-resolve срабатывает через 17с от phaseAtMs. Если знаем сколько уже
    // прошло на сервере (через serverNowMs - phaseAtMs), стартуем таймер с реального
    // остатка минус 1с safety buffer. Игрок не «оторвётся» от сервера.
    const SERVER_AUTO_RESOLVE_S = 17;
    const SAFETY_BUFFER_S = 1;
    let initialSeconds = 11; // дефолт — для demo-bot или если sync не доступен
    if (Number.isFinite(initialSecondsParam) && initialSecondsParam > 0) {
      initialSeconds = Math.max(2, Math.min(SERVER_AUTO_RESOLVE_S - SAFETY_BUFFER_S, Math.ceil(initialSecondsParam)));
    }
    setTimer(initialSeconds);
    timerRef.current = setInterval(() => {
      setTimer(prev => {
        const next = prev - 1;
        if (prev <= 1) {
          stopTimer();
          // Refs синхронны и не stale в setInterval-замыкании, в отличие от zoneLocked/showingResult state.
          // Это снимает рассинхрон, когда игрок успел тапнуть в последнюю секунду, а таймер
          // не «увидел» этого и автозаполнил случайной зоной поверх его выбора.
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
            sendMessage('choose_zone', { zone: autoZone });
          }
          return 0;
        }
        if (next > 0 && next <= 3 && (lastSubmittedZoneRef.current === null || lastSubmittedZoneRef.current === undefined) && !showingResultRef.current) {
          playSound('tick');
        }
        return next;
      });
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };
  const clearRoundStuckTimer = () => {
    if (roundStuckTimerRef.current) {
      clearTimeout(roundStuckTimerRef.current);
      roundStuckTimerRef.current = null;
    }
  };
  const clearWaitingBotMoveTimer = () => {
    if (waitingBotMoveTimerRef.current) {
      clearTimeout(waitingBotMoveTimerRef.current);
      waitingBotMoveTimerRef.current = null;
    }
  };
  const clearMoveWatchdog = () => {
    if (pvpMoveWatchdogTimerRef.current) {
      clearTimeout(pvpMoveWatchdogTimerRef.current);
      pvpMoveWatchdogTimerRef.current = null;
    }
  };

  const handleRoundResult = (msg) => {
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
    clearMoveWatchdog();
    stopTimer();
    setWaitingOpponent(false);
    setShowingResult(true);
    setInputBlocked(true);
    setScores(msg.scores);
    if (msg.history) setHistory(msg.history);

    // КРИТИЧЕСКИЙ МОМЕНТ: Включаем быстрый polling
    // Может начаться овертайм или закончиться игра
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
      if (!isGoal) {
        setKeeperState('save');
      } else {
        // Keeper missed — stays idle sprite, just moves to position
        setKeeperState('moved');
      }
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
    // С флагом — keeper моментально телепортируется на стартовую позицию (transition: none),
    // потом флаг снимается, чтобы будущие прыжки снова были плавные.
    animTimersRef.current.push(setTimeout(() => {
      if (!showingResultRef.current) return; // если раунд уже сменился — пусть round_start решит
      setBallVisible(false);
      setKeeperTransitionDisabled(true);
      setKeeperX(0);
      setKeeperBottom('4');
      setIsKeeperMirrored(false);
      setKeeperState('idle');
      // Восстанавливаем transition после применения сброса (двойной rAF для надёжности на iOS)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setKeeperTransitionDisabled(false);
        });
      });
    }, 1100));

    // Если начинается овертайм - показываем уведомление ПЕРЕД следующим раундом
    if (msg.startSuddenDeath) {
      const overtimeStartRound = msg.round || 0;
      // Fix #2: overtime таймеры в ОТДЕЛЬНОМ ref'е, чтобы animTimersRef cleanup при следующем
      // round_start не убил setOvertimeAnnounce(false) и модалка не зависла на весь овертайм.
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

    // Fix #3: ускорено с 1800ms до 1500ms. Анимация удара (0.4с) + текст GOAL/SAVED
    // успевают прочитаться, потом сразу запрашиваем next state. Синхронизировано с
    // серверным round_result→turn_input transition (тоже 1500ms).
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
        if (screen === 'result' || matchResult) return;
        // Считаем результат по серверной стороне-победителю если есть, иначе по счёту
        let youWon = false;
        if (msg.winnerSide && msg.mySide) {
          youWon = msg.winnerSide === msg.mySide;
        } else if (Array.isArray(msg.scores) && msg.scores.length === 2) {
          const myIdx = playerIndexRef.current;
          youWon = myIdx === 0 ? msg.scores[0] > msg.scores[1] : msg.scores[1] > msg.scores[0];
        }
        handleServerMessage({ type: 'match_result', youWon, scores: msg.scores || [0, 0] });
      }, 2500));
    }
  };

  // ==================== HTTP POLLING (КАК В FROG HUNT) ====================
  const stopRealtimeSubscription = useCallback(() => {
    // Пустая функция - не используем WebSocket
  }, []);

  const startRealtimeSubscription = useCallback((roomId) => {
    // Пустая функция - не используем WebSocket
  }, []);

  const stopPvpPolling = useCallback(() => {
    if (pvpPollTimerRef.current) {
      clearInterval(pvpPollTimerRef.current);
      pvpPollTimerRef.current = null;
    }
    pvpPollInFlightRef.current = false;
  }, []);

  const startPvpPolling = useCallback(() => {
    stopPvpPolling();
    const interval = pvpPollFastModeRef.current ? PVP_POLL_FAST_MS : PVP_POLL_MS;
    pvpPollTimerRef.current = setInterval(() => {
      pvpPollState();
    }, interval);
    pvpPollState(); // Сразу первый запрос
  }, [stopPvpPolling]); // eslint-disable-line

  const enableFastPolling = useCallback(() => {
    if (pvpPollFastModeRef.current) return; // Уже включен
    pvpPollFastModeRef.current = true;
    startPvpPolling(); // Перезапускаем с новым интервалом
    // Fix #3/#4: продлили окно fast polling 10с -> 15с. Лаги сервера 5-7с накрываются с запасом.
    setTimeout(() => {
      pvpPollFastModeRef.current = false;
      if (pvpPollTimerRef.current) startPvpPolling();
    }, 15000);
  }, [startPvpPolling]);

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

  const pvpPollState = useCallback(() => {
    if (!pvpRoomIdRef.current || !tgInitDataRef.current || pvpPollInFlightRef.current) return;
    pvpPollInFlightRef.current = true;
    // A4: монотонный id — ответы с устаревшим id игнорируются (если успел уйти более новый запрос)
    const requestId = ++pvpPollRequestIdRef.current;

    if (connectionErrorTimerRef.current) clearTimeout(connectionErrorTimerRef.current);
    connectionErrorTimerRef.current = setTimeout(() => {
      if (playModeRef.current === 'pvp' && screen === 'game') {
        setShowConnectionError(true);
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
        initData: tgInitDataRef.current,
        roomId: pvpRoomIdRef.current,
      }),
      signal: controller ? controller.signal : undefined,
    })
      .then((r) => r.json())
      .then((data) => {
        // A4: stale-guard — если за время этого fetch уже улетел более новый poll, игнорируем ответ
        if (requestId !== pvpPollRequestIdRef.current) return;
        if (connectionErrorTimerRef.current) clearTimeout(connectionErrorTimerRef.current);
        setShowConnectionError(false);
        lastSuccessfulPollRef.current = Date.now();
        // Server clock offset для синхронизации таймера с серверным auto-resolve.
        if (data && Number.isFinite(Number(data.serverNowMs))) {
          serverClockOffsetMsRef.current = Date.now() - Number(data.serverNowMs);
        }

        if (!data?.ok) {
          const err = String(data?.error || '');
          if (err === 'ACCEPT_TIMEOUT') {
            stopPvpPolling();
            pvpRoomIdRef.current = null;
            goHome();
            return;
          }
          if (err === 'Room not found') {
            // A8: после завершения матча сервер чистит комнату через pvpDeleteRoomAfterDone.
            // Это НЕ accept-timeout — это нормальный cleanup. Не показываем «не принял матч»
            // и не запускаем новый поиск.
            if (matchEndedRef.current || screen === 'result') {
              stopPvpPolling();
              pvpRoomIdRef.current = null;
              return;
            }
            if (acceptInfo) {
              pvpRoomIdRef.current = null;
              setAcceptInfo(null);
              setScreen('waiting');
              showBottomNotice('Пользователь не принял матч');
              startSearchOnline();
            }
          }
          return;
        }
        if (data.room) applyPvpRoomState(data.room);
      })
      .catch(() => {
        const timeSinceLastSuccess = Date.now() - lastSuccessfulPollRef.current;
        if (timeSinceLastSuccess > 3000 && playModeRef.current === 'pvp' && screen === 'game') {
          setShowConnectionError(true);
        }
      })
      .finally(() => {
        clearTimeout(abortTimer);
        pvpPollInFlightRef.current = false;
      });
  }, [applyPvpRoomState, goHome, stopPvpPolling, acceptInfo, screen]);

  const sendMessage = (type, data = {}) => {
    if (playModeRef.current === 'pvp') {
      if (!pvpRoomIdRef.current || !tgInitDataRef.current) return;
      if (type === 'cancel_wait') {
        const rid = pvpRoomIdRef.current;
        pvpRoomIdRef.current = null;
        apiPost({
          action: 'pvpLeaveRoom',
          initData: tgInitDataRef.current,
          roomId: rid,
        }).catch(() => {});
        return;
      }
      if (type === 'choose_zone') {
        const zone = Number(data.zone);
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
        enableFastPolling(); // ускоряем polling до 300мс чтобы быстрее получить round_result

        let penAttempts = 0;

        const submitPenMove = () => {
          if (pvpMoveCommittedRef.current) return;
          penAttempts++;
          apiPost({
            action: 'pvpSubmitMove',
            initData: tgInitDataRef.current,
            roomId: pvpRoomIdRef.current,
            // A3: turnId связывает submit с конкретным раундом — сервер отвергнет stale
            move: { zone, turnId: turnIdRef.current || undefined },
          }).then((data2) => {
            if (pvpMoveCommittedRef.current) return;
            if (data2?.ok) {
              pvpMoveCommittedRef.current = true;
              if (data2.room) {
                applyPvpRoomState(data2.room);
              }
              setTimeout(() => pvpPollState(), 200);
            } else {
              const err = String(data2?.error || '');
              if (err === 'STALE_TURN') {
                // A3: submit пришёл уже после смены раунда — тихо игнорируем, poll принесёт актуальный state
                pvpMoveCommittedRef.current = true;
                pvpPollState();
                return;
              }
              if (penAttempts < 3) {
                setTimeout(submitPenMove, 400);
              } else {
                showBottomNotice('Сервер обрабатывает... Подожди соперника.');
              }
            }
          }).catch(() => {
            if (pvpMoveCommittedRef.current) return;
            if (penAttempts < 3) {
              setTimeout(submitPenMove, 400);
            } else {
              showBottomNotice('Сервер обрабатывает... Подожди соперника.');
            }
          });
        };
        submitPenMove();

        clearMoveWatchdog();
        pvpMoveWatchdogTimerRef.current = setTimeout(() => {
          if (!pvpMoveCommittedRef.current && pvpRoomIdRef.current && tgInitDataRef.current) {
            pvpPollState();
            setTimeout(() => pvpPollState(), 400);
            setTimeout(() => {
              if (!pvpMoveCommittedRef.current) {
                showBottomNotice('Сервер не отвечает... Ждём.');
              }
            }, 2000);
          }
        }, 4000);

        // Обычный polling 800мс уже работает - не нужны дополнительные интервалы
      }
      return;
    }
    
    // DEMO BOT MODE - локальная игра с ботом (полноценная игра как PvP)
    if (playModeRef.current === 'demo-bot') {
      if (type === 'choose_zone') {
        const playerZone = Number(data.zone);
        if (![0, 1, 2, 3].includes(playerZone)) return;

        // Atomic anti-duplicate через ref (как в PvP-ветке)
        if (lastSubmittedZoneRef.current !== null && lastSubmittedZoneRef.current !== undefined) return;
        lastSubmittedZoneRef.current = playerZone;
        if (selectedZoneRef.current === null || selectedZoneRef.current === undefined) {
          selectedZoneRef.current = playerZone;
          setSelectedZone(playerZone);
        }

        setZoneLocked(true);
        setWaitingOpponent(true);
        stopTimer();
        
        // Бот делает случайный ход мгновенно
        setTimeout(() => {
          const botZone = Math.floor(Math.random() * 4);
          
          // Определяем кто кикер в этом раунде (игрок = 0, бот = 1)
          const currentRound = round;
          const kickerIndex = (currentRound - 1) % 2 === 0 ? 0 : 1;
          const keeperIndex = 1 - kickerIndex;
          
          const kickerZone = kickerIndex === 0 ? playerZone : botZone;
          const keeperZone = keeperIndex === 0 ? playerZone : botZone;
          const isGoal = kickerZone !== keeperZone;
          
          // Обновляем счёт
          const newScores = [...scores];
          if (isGoal) newScores[kickerIndex]++;
          
          // Обновляем историю
          const newHistory = [...history, { kickerIndex, kickerZone, keeperZone, isGoal }];
          
          // ИСПРАВЛЕНИЕ: Проверяем по количеству ходов в истории, а не по номеру раунда
          // 5 раундов = 10 ходов (каждый игрок делает по 5 ударов)
          const totalMoves = newHistory.length;
          const maxMoves = 10; // 5 раундов × 2 хода
          
          // Проверяем нужен ли овертайм
          let needsOvertime = false;
          let startingSuddenDeath = false;
          let overtimeStartRound = suddenDeathStartRound;
          
          if (totalMoves >= maxMoves && !suddenDeath) {
            // Основная игра закончена (10 ходов) - проверяем счёт
            if (newScores[0] === newScores[1]) {
              needsOvertime = true;
              startingSuddenDeath = true;
              overtimeStartRound = totalMoves; // Запоминаем ход начала овертайма
            }
          }
          
          // Проверяем конец овертайма (кто-то забил больше в текущем цикле)
          let gameEnded = false;
          if (suddenDeath && totalMoves > maxMoves) {
            // В овертайме проверяем после каждых 2 ходов (1 цикл)
            const overtimeMoves = totalMoves - suddenDeathStartRound;
            if (overtimeMoves % 2 === 0) {
              // Цикл завершён - проверяем счёт последних 2 ходов
              const lastTwoMoves = newHistory.slice(-2);
              const p1Goals = lastTwoMoves.filter(h => h.kickerIndex === 0 && h.isGoal).length;
              const p2Goals = lastTwoMoves.filter(h => h.kickerIndex === 1 && h.isGoal).length;
              
              if (p1Goals !== p2Goals) {
                // Кто-то выиграл овертайм
                gameEnded = true;
              }
            }
          }
          
          // Показываем результат раунда.
          // gameOver передаётся для watchdog'а в handleRoundResult — на случай если
          // setTimeout match_result потерялся (animTimersRef cleanup и т.п.).
          const endsBasic = (totalMoves >= maxMoves && !needsOvertime && !suddenDeath);
          const gameOverFlag = endsBasic || gameEnded;
          handleServerMessage({
            type: 'round_result',
            kickerZone,
            keeperZone,
            isGoal,
            scores: newScores,
            round: currentRound,
            kickerIndex,
            history: newHistory,
            startSuddenDeath: startingSuddenDeath,
            gameOver: gameOverFlag,
            winnerSide: gameOverFlag ? (newScores[0] > newScores[1] ? 'p1' : 'p2') : null,
            mySide: 'p1', // в demo игрок всегда p1
          });
          
          // Устанавливаем suddenDeathStartRound если начинается овертайм
          if (startingSuddenDeath) {
            setTimeout(() => {
              setSuddenDeathStartRound(overtimeStartRound);
            }, 100);
          }
          
          // Проверяем конец игры
          if (totalMoves >= maxMoves && !needsOvertime && !suddenDeath) {
            // Основная игра закончена, есть победитель
            setTimeout(() => {
              const youWon = newScores[0] > newScores[1];
              handleServerMessage({
                type: 'match_result',
                youWon,
                scores: newScores,
              });
            }, 1500);
          } else if (gameEnded) {
            // Овертайм закончен
            setTimeout(() => {
              const youWon = newScores[0] > newScores[1];
              handleServerMessage({
                type: 'match_result',
                youWon,
                scores: newScores,
              });
            }, 1500);
          } else {
            // Следующий раунд
            setTimeout(() => {
              const nextRound = currentRound + 1;
              const nextKickerIndex = (nextRound - 1) % 2 === 0 ? 0 : 1;
              const inSuddenDeath = needsOvertime || suddenDeath;
              
              handleServerMessage({
                type: 'round_start',
                round: nextRound,
                maxRounds: inSuddenDeath ? nextRound : 5,
                role: nextKickerIndex === 0 ? 'kicker' : 'keeper',
                scores: newScores,
                suddenDeath: inSuddenDeath,
                history: newHistory,
              });
            }, startingSuddenDeath ? 4000 : 1500); // Больше времени если показываем овертайм
          }
        }, 100); // Минимальная задержка для плавности UI
      }
      return;
    }
    
    // Bot mode removed - all games go through backend now
    if (playModeRef.current === 'bot') {
      showBottomNotice('Режим бота больше не поддерживается. Используй PvP.');
      return;
    }
  };

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

  const startSearchOnline = () => {
    const name = displayName.trim() || 'Player';
    const stakes = askStakeOptions();
    if (!stakes) return;
    tgInitDataRef.current = window.Telegram?.WebApp?.initData || tgInitDataRef.current || '';
    setSelectedStakeOptions(stakes);
    setCurrentStakeTon(null);
    matchSavedRef.current = false;
    matchEndedRef.current = false;
    pvpLastRoundMarkerRef.current = 0;
    pvpLastStartKeyRef.current = '';
    pvpMoveCommittedRef.current = false;
    lastSubmittedZoneRef.current = null;
    selectedZoneRef.current = null;
    lastAppliedUpdatedAtRef.current = 0; // A4: сброс reconciliation на новый матч
    lastAnimSignatureRef.current = ''; // A2: сброс signature анимаций
    animTimersRef.current.forEach((t) => clearTimeout(t));
    animTimersRef.current = [];
    turnIdRef.current = ''; // A3: сброс turnId
    // Сброс UI state'ов от предыдущего матча — иначе мишень светится до выбора в новом матче
    setSelectedZone(null);
    setConfirmedZone(null);
    setZoneLocked(false);
    setShowingResult(false);
    setResultMessage(null);
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
    if (!tgInitDataRef.current) {
      playModeRef.current = 'idle';
      showBottomNotice('Нет Telegram-сессии. Открой игру через Telegram.');
      setScreen('stake-online');
      return;
    }
    setScreen('waiting');
    apiPost({
      action: 'pvpFindMatch',
      initData: tgInitDataRef.current || '',
      gameKey: 'super_penalty',
      playerName: name,
      stakeOptions: stakes,
    }).then((data) => {
      if (playModeRef.current !== 'pvp') return;
      if (!data?.ok || !data.room) throw new Error(String(data?.error || 'matchmaking'));
      pvpRoomIdRef.current = data.room.id;
      // Запускаем HTTP polling как в Frog Hunt
      startPvpPolling();
      // Сразу применяем начальное состояние
      if (data.room) applyPvpRoomState(data.room);
      // Polling как страховка пока WebSocket не подключился
      startPvpPolling();
    }).catch((err) => {
      playModeRef.current = 'idle';
      showBottomNotice(String(err?.message || '').trim() || 'Не удалось начать поиск. Попробуй снова.');
      setScreen('stake-online');
    });
  };

  const startSearchBot = () => {
    // Локальная игра с демо-ботом (без ставок, без бэкенда)
    playModeRef.current = 'demo-bot';
    matchEndedRef.current = false;
    matchSavedRef.current = false;
    lastSubmittedZoneRef.current = null;
    selectedZoneRef.current = null;
    lastAnimSignatureRef.current = ''; // A2: сброс signature анимаций
    animTimersRef.current.forEach((t) => clearTimeout(t));
    animTimersRef.current = [];
    // Сброс UI state'ов от предыдущего матча — иначе мишень светится до выбора в новом матче
    setSelectedZone(null);
    setConfirmedZone(null);
    setZoneLocked(false);
    setShowingResult(false);
    setResultMessage(null);
    setOpponent('Бот 🤖');
    setPlayerIndex(0); // Игрок всегда первый
    playerIndexRef.current = 0;
    setScores([0, 0]);
    setRound(0);
    setMaxRounds(5); // 5 раундов как в обычной игре
    setSuddenDeath(false);
    setSuddenDeathStartRound(0);
    setHistory([]);
    setScreen('game');
    
    // Начинаем первый раунд
    setTimeout(() => {
      handleServerMessage({
        type: 'round_start',
        round: 1,
        maxRounds: 5,
        role: 'kicker', // Игрок начинает как kicker
        scores: [0, 0],
        suddenDeath: false,
        history: [],
      });
    }, 500);
  };


  const handleCancelWait = () => {
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
      if (rid && tgInitDataRef.current) {
        // Отправляем отмену поиска
        const payload = JSON.stringify({
          action: 'pvpCancelQueue',
          initData: tgInitDataRef.current,
          roomId: rid,
        });
        
        // Используем sendBeacon для надёжной отправки
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon('/api/user', new Blob([payload], { type: 'application/json' }));
          }
        } catch {}
        
        // Дублируем обычным fetch
        fetch('/api/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
      stopPvpPolling();
    }
    if (mode === 'bot') {
      matchRef.current = null;
    }
    playModeRef.current = 'idle';
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    stopRealtimeSubscription();
    
    // ОТКЛЮЧАЕМ ВСЕ УВЕДОМЛЕНИЯ перед переходом
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.disableClosingConfirmation();
    }
    
    // Переходим на главную БЕЗ вызова goHome() чтобы избежать дублирования pvpLeaveRoom
    window.location.replace('/');
  };

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

  const handlePlayAgain = () => {
    const wasDemo = playModeRef.current === 'demo-bot';
    setMatchResult(null);
    setHistory([]);
    if (wasDemo) {
      startSearchBot();
    } else {
      startSearchOnline();
    }
  };
  const handleExitToMenu = () => {
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
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    
    // ОТКЛЮЧАЕМ ВСЕ УВЕДОМЛЕНИЯ перед переходом
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.disableClosingConfirmation();
    }
    
    // Переходим на главную
    window.location.replace('/');
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

