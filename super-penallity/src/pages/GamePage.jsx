import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import confetti from 'canvas-confetti';
import { motion, AnimatePresence } from 'framer-motion';
const ASSET_BASE = import.meta.env.BASE_URL || '/super-penallity/';
const SETTINGS_KEY = "f1duel_global_settings_v1";
function appSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { sound: s?.sound !== false, haptic: s?.haptic !== false };
  } catch {
    return { sound: true, haptic: true };
  }
}

// Gate container: 360x280, zone grid: left=16, w=328, h=238 (85% of 280)
// Zone cells: 164x119 each
// Zone centers from container origin:
//   0(TL)=(98,60)  1(TR)=(262,60)  2(BL)=(98,178)  3(BR)=(262,178)
// Ball starts at center-x=180, center-y=255 (bottom:-10, img 70x70)
// So ball translate = zoneCenter - ballStart
const targetPositions = [
  { x: -82, y: -195 },  // zone 0: top-left
  { x: 82, y: -195 },   // zone 1: top-right
  { x: -82, y: -77 },   // zone 2: bottom-left
  { x: 82, y: -77 },    // zone 3: bottom-right
];

// Keeper x offset from center (180) to zone center
// Keeper bottom values so keeper center aligns with zone center y
// Using h=100px save sprite: bottom = (280 - zoneCenterY) - 50
const keeperZonePos = [
  { x: -82, bottom: 170 }, // zone 0: top-left
  { x: 82, bottom: 170 },  // zone 1: top-right
  { x: -82, bottom: 52 },  // zone 2: bottom-left
  { x: 82, bottom: 52 },   // zone 3: bottom-right
];

// SVG grass — memoized to prevent re-renders (350 paths)
const GrassSVG = memo(() => (
  <svg className="absolute bottom-0 left-0 w-full h-36 z-[1] pointer-events-none" viewBox="0 0 400 120" preserveAspectRatio="none">
    {/* Layer 1: dark tall back blades */}
    <g fill="#145a2a" opacity="0.9">
      {Array.from({ length: 60 }).map((_, i) => {
        const x = i * 6.7 + Math.sin(i * 1.7) * 3;
        const h = 40 + Math.sin(i * 0.5) * 18;
        const lean = Math.sin(i * 0.8) * 8;
        const w = 4 + Math.sin(i * 1.1) * 2;
        return <path key={`a${i}`} d={`M${x},120 Q${x + lean},${120 - h * 0.6} ${x + lean * 0.6},${120 - h} Q${x + lean * 0.3},${120 - h * 0.6} ${x + w},120`} />;
      })}
    </g>
    {/* Layer 2: medium green mid blades */}
    <g fill="#1a6b35" opacity="0.85">
      {Array.from({ length: 70 }).map((_, i) => {
        const x = i * 5.8 + 2 + Math.cos(i * 1.3) * 4;
        const h = 32 + Math.cos(i * 0.7) * 14;
        const lean = Math.cos(i * 1.1) * 7;
        const w = 5 + Math.cos(i * 0.9) * 2;
        return <path key={`b${i}`} d={`M${x},120 Q${x + lean},${120 - h * 0.6} ${x + lean * 0.5},${120 - h} Q${x + lean * 0.2},${120 - h * 0.6} ${x + w},120`} />;
      })}
    </g>
    {/* Layer 3: bright thick front blades */}
    <g fill="#1e7a3c" opacity="0.8">
      {Array.from({ length: 80 }).map((_, i) => {
        const x = i * 5 + 1 + Math.sin(i * 2.1) * 3;
        const h = 24 + Math.sin(i * 0.9) * 10;
        const lean = Math.sin(i * 0.6) * 5;
        const w = 6 + Math.sin(i * 1.4) * 2;
        return <path key={`c${i}`} d={`M${x},120 Q${x + lean},${120 - h * 0.5} ${x + lean * 0.4},${120 - h} Q${x + lean * 0.1},${120 - h * 0.5} ${x + w},120`} />;
      })}
    </g>
    {/* Layer 4: short dense foreground */}
    <g fill="#22903f" opacity="0.7">
      {Array.from({ length: 90 }).map((_, i) => {
        const x = i * 4.5 + Math.cos(i * 1.9) * 2;
        const h = 16 + Math.cos(i * 1.2) * 8;
        const lean = Math.cos(i * 0.7) * 4;
        const w = 5 + Math.cos(i * 1.6) * 2;
        return <path key={`d${i}`} d={`M${x},120 Q${x + lean},${120 - h * 0.5} ${x + lean * 0.3},${120 - h} Q${x},${120 - h * 0.5} ${x + w},120`} />;
      })}
    </g>
    {/* Layer 5: tiny accent blades */}
    <g fill="#28a347" opacity="0.5">
      {Array.from({ length: 50 }).map((_, i) => {
        const x = i * 8 + 3 + Math.sin(i * 2.5) * 4;
        const h = 10 + Math.sin(i * 1.8) * 5;
        const lean = Math.sin(i * 1.3) * 3;
        return <path key={`e${i}`} d={`M${x},120 Q${x + lean},${120 - h} ${x + lean * 0.2},${120 - h - 3} Q${x},${120 - h} ${x + 4},120`} />;
      })}
    </g>
  </svg>
));

// Dots for this player's KICKS only (not keeper rounds)
// Green = scored, Red = missed
const KickDots = memo(({ history, playerIdx, totalKicks = 5, label, color }) => {
  const kicks = history.filter(h => h.kickerIndex === playerIdx);
  return (
    <div className="flex items-center justify-center gap-2">
      <span className={`text-[10px] font-bold truncate w-14 text-right ${color}`}>{label}</span>
      <div className="flex gap-1">
        {Array.from({ length: totalKicks }).map((_, i) => {
          const k = kicks[i];
          if (!k) return <div key={i} className="w-4 h-4 rounded-full border-2 border-white/20" />;
          return (
            <div key={i} className={`w-4 h-4 rounded-full border-2 ${
              k.isGoal
                ? 'bg-green-500 border-green-400'
                : 'bg-red-500 border-red-400'
            }`} />
          );
        })}
      </div>
    </div>
  );
});

const GamePage = () => {
  const safeFrameStyle = {
    paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)',
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
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
  const [zoneLocked, setZoneLocked] = useState(false);
  const [waitingOpponent, setWaitingOpponent] = useState(false);
  const [timer, setTimer] = useState(10);
  const [history, setHistory] = useState([]);

  // Animation state
  const [ballStyle, setBallStyle] = useState({});
  const [keeperState, setKeeperState] = useState('idle');
  const [isKeeperMirrored, setIsKeeperMirrored] = useState(false);
  const [keeperX, setKeeperX] = useState(0);
  const [keeperBottom, setKeeperBottom] = useState('4');
  const [resultMessage, setResultMessage] = useState(null);
  const [showingResult, setShowingResult] = useState(false);

  // Role announcement
  const [roleAnnounce, setRoleAnnounce] = useState(null);

  // Match result
  const [matchResult, setMatchResult] = useState(null);
  const [selectedStakeOptions, setSelectedStakeOptions] = useState([]);
  const [currentStakeTon, setCurrentStakeTon] = useState(null);
  const [balanceTon, setBalanceTon] = useState(0);
  const [bottomNotice, setBottomNotice] = useState('');
  const [acceptInfo, setAcceptInfo] = useState(null);
  const [acceptTick, setAcceptTick] = useState(0);

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
  const localFindTimerRef = useRef(null);
  const pvpFindRetryTimerRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const launchHandledRef = useRef(false);
  const showingResultRef = useRef(false);
  const roundStuckTimerRef = useRef(null);
  const waitingBotMoveTimerRef = useRef(null);

  useEffect(() => { playerIndexRef.current = playerIndex; }, [playerIndex]);
  useEffect(() => { showingResultRef.current = showingResult; }, [showingResult]);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tgInitDataRef.current = tg?.initData || '';
    if (tg?.BackButton) tg.BackButton.hide();
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
  const goHome = useCallback(() => {
    window.location.href = '/';
  }, []);


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

  useEffect(() => {
    const postPvp = (action) => {
      if (playModeRef.current !== 'pvp') return;
      const init = tgInitDataRef.current;
      const rid = pvpRoomIdRef.current;
      if (!init || !rid) return;
      const payload = JSON.stringify({ action, initData: init, roomId: rid });
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
    const onVis = () => {
      if (document.visibilityState === 'hidden') postPvp('pvpCancelQueue');
    };
    const onPageHide = () => postPvp('pvpLeaveRoom');
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

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
    };
  }, []);

  const apiPost = useCallback(async (payload) => {
    const res = await fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return res.json();
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
        setHistory([]);
        setScreen('game');
        break;

      case 'round_start':
        clearRoundStuckTimer();
        clearWaitingBotMoveTimer();
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
        setBallStyle({});
        setKeeperState('idle');
        setIsKeeperMirrored(false);
        setKeeperX(0);
        setKeeperBottom('4');
        setRoleAnnounce({ role: msg.role, round: msg.round });
        setTimeout(() => setRoleAnnounce(null), 1800);
        startTimer();
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
        clearRoundStuckTimer();
        clearWaitingBotMoveTimer();
        setTimeout(() => {
          setMatchResult({ youWon: msg.youWon, scores: msg.scores });
          setScreen('result');
          if (playModeRef.current === 'bot') {
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
        clearWaitingBotMoveTimer();
        setMatchResult({ youWon: true, scores: [0, 0], opponentLeft: true });
        setScreen('result');
        break;
    }
  }, []);

  const startTimer = () => {
    stopTimer();
    setTimer(10);
    timerRef.current = setInterval(() => {
      setTimer(prev => {
        if (prev <= 1) {
          stopTimer();
          if (!zoneLocked && !showingResult) {
            const autoZone = Math.floor(Math.random() * 4);
            sendMessage('choose_zone', { zone: autoZone });
          }
          return 0;
        }
        return prev - 1;
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

  const handleRoundResult = (msg) => {
    clearRoundStuckTimer();
    stopTimer();
    setWaitingOpponent(false);
    setShowingResult(true);
    setScores(msg.scores);
    if (msg.history) setHistory(msg.history);

    const { kickerZone, keeperZone, isGoal, kickerIndex } = msg;
    const iAmKicker = playerIndexRef.current === kickerIndex;

    // Ball flies to kicker's zone
    const target = targetPositions[kickerZone];
    setBallStyle({
      transform: `translate(${target.x}px, ${target.y}px) scale(0.55)`,
      transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
    });

    // Keeper moves to their chosen zone
    const kpos = keeperZonePos[keeperZone];
    setIsKeeperMirrored(keeperZone === 0 || keeperZone === 2);

    setTimeout(() => {
      setKeeperX(kpos.x);
      setKeeperBottom(String(kpos.bottom));
      // Save sprite ONLY when keeper actually catches the ball
      if (!isGoal) {
        setKeeperState('save');
      } else {
        // Keeper missed — stays idle sprite, just moves to position
        setKeeperState('moved');
      }
    }, 150);

    // Result text
    setTimeout(() => {
      if (isGoal) {
        if (iAmKicker) {
          setResultMessage({ text: 'GOAL!', type: 'win' });
          confetti({ particleCount: 25, spread: 40, origin: { y: 0.6 }, ticks: 40 });
          if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
        } else {
          setResultMessage({ text: 'GOAL!', type: 'loss' });
          if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
        }
      } else {
        if (iAmKicker) {
          setResultMessage({ text: 'SAVED!', type: 'loss' });
          if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
        } else {
          setResultMessage({ text: 'SAVED!', type: 'win' });
          confetti({ particleCount: 25, spread: 40, origin: { y: 0.6 }, ticks: 40 });
          if (appSettings().haptic) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
        }
      }
    }, 400);

    // Safety net: if server/client transition gets stuck after GOAL/SAVED,
    // force a state refresh and unlock controls so the match never freezes.
    roundStuckTimerRef.current = setTimeout(() => {
      if (!showingResultRef.current) return;

      if (playModeRef.current === 'pvp') {
        const rid = pvpRoomIdRef.current;
        const init = tgInitDataRef.current;
        if (rid && init) {
          apiPost({ action: 'pvpGetRoomState', initData: init, roomId: rid })
            .then((data) => { if (data?.ok && data.room) applyPvpRoomState(data.room); })
            .catch(() => {});
        }
        setTimeout(() => {
          if (!showingResultRef.current) return;
          setShowingResult(false);
          setResultMessage(null);
          setZoneLocked(false);
          setWaitingOpponent(false);
          startTimer();
        }, 1200);
        return;
      }

      // Bot fallback: continue locally so demo never hangs.
      const m = matchRef.current;
      if (!m || m.finished) return;
      setShowingResult(false);
      setResultMessage(null);
      if (localShouldEndMatch(m)) {
        m.finished = true;
        handleServerMessage({ type: 'match_result', youWon: m.scores[0] > m.scores[1], scores: [...m.scores] });
      } else {
        localStartRound();
      }
    }, 5200);
  };

  const stopPvpPolling = useCallback(() => {
    if (pvpPollTimerRef.current) clearInterval(pvpPollTimerRef.current);
    pvpPollTimerRef.current = null;
    pvpPollInFlightRef.current = false;
  }, []);

  const applyPvpRoomState = useCallback((room) => {
    if (!room) return;
    const s = room.state_json || {};
    if (String(room.status) === 'active' && String(s.phase || '') === 'accept_match') {
      const am = s.acceptMatch || {};
      const myTgAccept = String(window.Telegram?.WebApp?.initDataUnsafe?.user?.id || '');
      const meIsP1Accept = String(room.player1_tg_user_id || '') === myTgAccept;
      setAcceptInfo({
        p1: room.player1_name || 'Игрок 1',
        p2: room.player2_name || 'Игрок 2',
        stake: room.stake_ton != null ? Number(room.stake_ton) : null,
        deadlineMs: Number(am.deadlineMs || 0),
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
    setScreen('game');
    setAcceptInfo(null);
    setPlayerIndex(myIdx);
    playerIndexRef.current = myIdx;
    setOpponent(meIsP1 ? (room.player2_name || 'Соперник') : (room.player1_name || 'Соперник'));
    setCurrentStakeTon(room.stake_ton != null ? Number(room.stake_ton) : null);

    const rr = s.lastRoundResult || {};
    const marker = Number(rr.marker || 0);
    if (marker > pvpLastRoundMarkerRef.current) {
      pvpLastRoundMarkerRef.current = marker;
      const scoresObj = rr.scores || { p1: 0, p2: 0 };
      handleServerMessage({
        type: 'round_result',
        kickerZone: Number(rr.kickerZone || 0),
        keeperZone: Number(rr.keeperZone || 0),
        isGoal: !!rr.isGoal,
        scores: [Number(scoresObj.p1 || 0), Number(scoresObj.p2 || 0)],
        round: Number(rr.round || 0),
        kickerIndex: Number(rr.kickerIndex || 0),
        history: Array.isArray(rr.history) ? rr.history : [],
      });
      return;
    }

    if (s.phase === 'turn_input') {
      const baseRound = Number(s.round || 0);
      const sudden = !!s.suddenDeath;
      const kickerIndex = sudden && Number.isInteger(Number(s.kickerOverride))
        ? Number(s.kickerOverride)
        : (baseRound % 2 === 0 ? 0 : 1);
      const roleNow = kickerIndex === myIdx ? 'kicker' : 'keeper';
      const startKey = `${baseRound}:${roleNow}:${sudden ? 1 : 0}`;
      if (startKey !== pvpLastStartKeyRef.current) {
        pvpLastStartKeyRef.current = startKey;
        const scoresObj = s.scores || { p1: 0, p2: 0 };
        handleServerMessage({
          type: 'round_start',
          round: baseRound + 1,
          maxRounds: Number(s.maxRounds || 10),
          role: roleNow,
          scores: [Number(scoresObj.p1 || 0), Number(scoresObj.p2 || 0)],
          suddenDeath: sudden,
          history: Array.isArray(s.history) ? s.history : [],
        });
      }
      return;
    }

    if (s.phase === 'match_over' || String(room.status) === 'finished' || String(room.status) === 'cancelled') {
      stopPvpPolling();
      pvpRoomIdRef.current = null;
      const scoresObj = s.scores || { p1: 0, p2: 0 };
      const arr = [Number(scoresObj.p1 || 0), Number(scoresObj.p2 || 0)];
      let youWon = false;
      if (s.winnerSide) youWon = s.winnerSide === mySide;
      else if (arr[0] !== arr[1]) youWon = myIdx === 0 ? arr[0] > arr[1] : arr[1] > arr[0];
      if (s.endedByLeave && s.leftBy && String(s.leftBy) !== myTg) {
        setMatchResult({ youWon: true, scores: arr, opponentLeft: true });
        setScreen('result');
        return;
      }
      handleServerMessage({ type: 'match_result', youWon, scores: arr });
    }
  }, [handleServerMessage, stopPvpPolling]);

  const pvpPollState = useCallback(() => {
    if (!pvpRoomIdRef.current || !tgInitDataRef.current || pvpPollInFlightRef.current) return;
    pvpPollInFlightRef.current = true;
    apiPost({
      action: 'pvpGetRoomState',
      initData: tgInitDataRef.current,
      roomId: pvpRoomIdRef.current,
    }).then((data) => {
      if (!data?.ok) {
        const err = String(data?.error || '');
        if (err === 'ACCEPT_TIMEOUT') {
          stopPvpPolling();
          pvpRoomIdRef.current = null;
          goHome();
          return;
        }
        if (err === 'Room not found' && acceptInfo) {
          pvpRoomIdRef.current = null;
          setAcceptInfo(null);
          setScreen('waiting');
          showBottomNotice('Пользователь не принял матч');
          startSearchOnline();
        }
        return;
      }
      if (data.room) applyPvpRoomState(data.room);
    }).catch(() => {}).finally(() => {
      pvpPollInFlightRef.current = false;
    });
  }, [apiPost, applyPvpRoomState, goHome, stopPvpPolling, acceptInfo]);

  const startPvpPolling = useCallback(() => {
    stopPvpPolling();
    pvpPollTimerRef.current = setInterval(() => pvpPollState(), 900);
    pvpPollState();
  }, [pvpPollState, stopPvpPolling]);

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
        setZoneLocked(true);
        setWaitingOpponent(true);
        stopTimer();
        apiPost({
          action: 'pvpSubmitMove',
          initData: tgInitDataRef.current,
          roomId: pvpRoomIdRef.current,
          move: { zone },
        }).then((data2) => {
          if (data2?.ok && data2.room) applyPvpRoomState(data2.room);
        }).catch(() => {
          setZoneLocked(false);
          setWaitingOpponent(false);
        });
        if (pvpOpponentIsBotRef.current) {
          clearWaitingBotMoveTimer();
          waitingBotMoveTimerRef.current = setTimeout(() => {
            const rid = pvpRoomIdRef.current;
            const init = tgInitDataRef.current;
            if (!rid || !init) return;
            apiPost({ action: 'pvpGetRoomState', initData: init, roomId: rid })
              .then((d) => { if (d?.ok && d.room) applyPvpRoomState(d.room); })
              .catch(() => {});
          }, 4500);
        }
      }
      return;
    }
    if (playModeRef.current !== 'bot') return;
    const m = matchRef.current;
    if (!m || m.finished) return;
    if (type === 'cancel_wait') {
      matchRef.current = null;
      return;
    }
    if (type === 'choose_zone') {
      const zone = Number(data.zone);
      if (![0, 1, 2, 3].includes(zone)) return;
      if (m.choices[0] !== null) return;
      m.choices[0] = zone;
      handleServerMessage({ type: 'zone_locked', zone });
      if (m.choices[1] === null) {
        m.choices[1] = Math.floor(Math.random() * 4);
      }
      localResolveRound();
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
    pvpLastRoundMarkerRef.current = 0;
    pvpLastStartKeyRef.current = '';
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
      startPvpPolling();
    }).catch((err) => {
      playModeRef.current = 'idle';
      showBottomNotice(String(err?.message || '').trim() || 'Не удалось начать поиск. Попробуй снова.');
      setScreen('stake-online');
    });
  };

  const startSearchBot = () => {
    const name = displayName.trim() || 'Player';
    setCurrentStakeTon(null);
    matchSavedRef.current = false;
    stopPvpPolling();
    if (pvpFindRetryTimerRef.current) clearTimeout(pvpFindRetryTimerRef.current);
    if (localFindTimerRef.current) clearTimeout(localFindTimerRef.current);
    matchRef.current = null;
    playModeRef.current = 'bot';
    setScreen('waiting');
    localFindTimerRef.current = setTimeout(() => {
      if (playModeRef.current !== 'bot') return;
      matchRef.current = {
        playerName: name,
        opponentName: 'Бот 🤖',
        tgUserId: window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || null,
        scores: [0, 0],
        round: 0,
        maxRounds: 10,
        suddenDeath: false,
        choices: [null, null],
        history: [],
        sdStart: 0,
        kickerOverride: null,
        finished: false,
      };
      handleServerMessage({ type: 'game_found', opponent: 'Бот 🤖', playerIndex: 0 });
      localStartRound();
      localFindTimerRef.current = null;
    }, 650);
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
        apiPost({
          action: 'pvpCancelQueue',
          initData: tgInitDataRef.current,
          roomId: rid,
        }).catch(() => {});
      }
      stopPvpPolling();
    }
    if (mode === 'bot') {
      matchRef.current = null;
    }
    playModeRef.current = 'idle';
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    goHome();
  };

  const handleChooseZone = (zone) => {
    if (zoneLocked || showingResult) return;
    sendMessage('choose_zone', { zone });
  };

  const handlePlayAgain = () => {
    if (playModeRef.current === 'bot') {
      setMatchResult(null);
      setHistory([]);
      startSearchBot();
      return;
    }
    if (playModeRef.current === 'pvp') {
      setMatchResult(null);
      setHistory([]);
      startSearchOnline();
      return;
    }
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
    goHome();
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
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
    goHome();
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
  };

  const getKickerIndex = (m) => {
    if (m.suddenDeath && m.kickerOverride !== null) return m.kickerOverride;
    return m.round % 2 === 0 ? 0 : 1;
  };

  const localStartRound = () => {
    const m = matchRef.current;
    if (!m || m.finished) return;
    m.choices = [null, null];
    if (m.suddenDeath) {
      const sdRound = m.round - m.sdStart;
      const pairNum = Math.floor(sdRound / 2);
      const withinPair = sdRound % 2;
      m.kickerOverride = (pairNum + withinPair) % 2;
    }
    const kickerIdx = getKickerIndex(m);
    handleServerMessage({
      type: 'round_start',
      round: m.round + 1,
      maxRounds: m.maxRounds,
      role: kickerIdx === 0 ? 'kicker' : 'keeper',
      scores: m.scores,
      suddenDeath: m.suddenDeath,
      history: m.history,
    });
  };

  const localResolveRound = () => {
    const m = matchRef.current;
    if (!m || m.finished || m.choices[0] === null || m.choices[1] === null) return;
    const kickerIdx = getKickerIndex(m);
    const keeperIdx = 1 - kickerIdx;
    const kickerZone = m.choices[kickerIdx];
    const keeperZone = m.choices[keeperIdx];
    const isGoal = kickerZone !== keeperZone;
    if (isGoal) m.scores[kickerIdx] += 1;
    m.history.push({ kickerIndex: kickerIdx, kickerZone, keeperZone, isGoal });
    m.round += 1;
    handleServerMessage({
      type: 'round_result',
      kickerZone,
      keeperZone,
      isGoal,
      scores: [...m.scores],
      round: m.round,
      kickerIndex: kickerIdx,
      history: [...m.history],
    });
    if (localShouldEndMatch(m)) {
      setTimeout(() => {
        if (!matchRef.current || matchRef.current.finished) return;
        m.finished = true;
        const youWon = m.scores[0] > m.scores[1];
        handleServerMessage({ type: 'match_result', youWon, scores: [...m.scores] });
      }, 2500);
    } else {
      setTimeout(() => localStartRound(), 2800);
    }
  };

  const localShouldEndMatch = (m) => {
    const [s0, s1] = m.scores;
    const roundsPlayed = m.round;
    if (m.suddenDeath) {
      const sdRounds = roundsPlayed - m.sdStart;
      if (sdRounds >= 2 && sdRounds % 2 === 0) return s0 !== s1;
      return false;
    }
    if (roundsPlayed >= m.maxRounds) {
      if (s0 === s1) {
        m.suddenDeath = true;
        m.sdStart = roundsPlayed;
        return false;
      }
      return true;
    }
    return false;
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
          mode: 'bot',
          winnerTgUserId: youWon ? tgUserId : null,
          players: [
            { tgUserId, name: displayName || 'Player', score: finalScores?.[0] || 0, isWinner: !!youWon, isBot: false },
            { tgUserId: null, name: opponent || 'Бот 🤖', score: finalScores?.[1] || 0, isWinner: !youWon, isBot: true },
          ],
          score: { left: finalScores?.[0] || 0, right: finalScores?.[1] || 0 },
          details: { roundsPlayed: finalHistory?.length || 0, suddenDeath },
        },
      }),
    }).catch(() => { matchSavedRef.current = false; });
  };

  useEffect(() => {
    if (launchHandledRef.current) return;
    const launchMode = String(new URLSearchParams(window.location.search).get('launch') || '').toLowerCase();
    if (launchMode !== 'play' && launchMode !== 'demo') return;
    launchHandledRef.current = true;
    if (launchMode === 'demo') {
      setScreen('demo-intro');
    } else {
      setScreen('stake-online');
    }
  }, []);

  // ==================== RENDER ====================

  const darkBg = "bg-[#121214]";

  if (screen === 'menu') return null;

  if (screen === 'demo-intro') {
    return (
      <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none`} style={safeFrameStyle}>
        <div className="z-10 w-full max-w-sm px-5 text-center">
          <h1 className="text-3xl font-black text-white">ДЭМО РЕЖИМ</h1>
          <p className="text-gray-300 text-sm mt-3 leading-relaxed">
            Тренировка против бота в стиле пенальти. Без TON-ставок:
            можно спокойно тестировать тактику и тайминг ударов.
          </p>
          <button onClick={() => startSearchBot()} className="w-full mt-5 bg-emerald-500 hover:bg-emerald-400 text-black font-black py-3 rounded-xl">Играть</button>
          <button onClick={() => goHome()} className="w-full mt-2 bg-white/5 border border-white/15 text-white py-3 rounded-xl">Назад</button>
        </div>
      </div>
    );
  }

  // --- WAITING ---
  if (screen === 'waiting') {
    const leftSec = Math.max(0, Math.ceil((Number(acceptInfo?.deadlineMs || 0) - Date.now()) / 1000)) + (acceptTick * 0);
    return (
      <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none`} style={safeFrameStyle}>
        <div className="z-10 flex flex-col items-center gap-6">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-white text-xl font-bold">Ищем соперника...</p>
          {!!selectedStakeOptions.length && <p className="text-gray-400 text-sm">Ставки: {selectedStakeOptions.join(', ')} TON</p>}
          <button onClick={handleCancelWait} className="text-gray-400 hover:text-white text-sm mt-4 px-6 py-2 border border-white/10 rounded-lg transition-colors">
            Отмена
          </button>
        </div>
        {!!acceptInfo && (
          <div className="fixed inset-0 z-[999] bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-gradient-to-b from-[#1f6a37] to-[#1a3f2a] border border-emerald-200/35 rounded-2xl p-5 text-center shadow-2xl">
              <p className="text-white text-lg font-black">Матч найден</p>
              <p className="text-gray-100 text-sm mt-2">{acceptInfo.p1} vs {acceptInfo.p2}</p>
              {acceptInfo.stake != null && <p className="text-lime-200 text-sm mt-1">Ставка: {acceptInfo.stake} TON</p>}
              <p className={`text-3xl font-black mt-2 ${leftSec <= 3 ? 'text-rose-200' : 'text-lime-200'}`}>{leftSec}с</p>
              <p className="mt-3 text-xs text-lime-100/90">Игра начнется автоматически</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (screen === 'stake-online') {
    return (
      <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none relative`} style={safeFrameStyle}>
        <div className="z-10 flex flex-col items-center gap-6 w-full max-w-xs px-4">
          <div className="w-full max-w-xs mx-auto">
            <p className="text-xs text-gray-400 mb-2 uppercase tracking-wider text-center">Выбери ставки TON</p>
            <div className="grid grid-cols-3 gap-2">
              {[1, 5, 10, 25, 50, 100].map((stake) => {
                const active = selectedStakeOptions.includes(stake);
                const blocked = Number(balanceTon || 0) < Number(stake);
                return (
                  <button
                    key={stake}
                    type="button"
                    onClick={() => toggleStakeOption(stake)}
                    className={`aspect-square rounded-xl border text-sm font-black transition-all ${
                      blocked
                        ? 'bg-red-500/20 border-red-400 text-red-200'
                        : active
                          ? 'bg-emerald-500/25 border-emerald-300 text-emerald-200 shadow-[0_0_16px_rgba(16,185,129,0.35)]'
                          : 'bg-white/5 border-white/15 text-white/80 hover:bg-white/10'
                    }`}
                  >
                    {stake} TON
                  </button>
                );
              })}
            </div>
            <button onClick={() => startSearchOnline()} className="w-full mt-3 bg-emerald-500 hover:bg-emerald-400 text-black font-black py-3 rounded-xl">Играть</button>
            <button onClick={() => goHome()} className="w-full mt-2 bg-white/5 border border-white/15 text-white py-3 rounded-xl">Назад</button>
          </div>
          {!!bottomNotice && (
            <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[9999] bg-black/90 text-white text-sm font-bold px-4 py-2 rounded-xl">
              {bottomNotice}
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- RESULT ---
  if (screen === 'result' && matchResult) {
    const tonStake = Number(currentStakeTon || 0);
    const hasTonStake = playModeRef.current !== 'bot' && Number.isFinite(tonStake) && tonStake > 0;
    const tonResultText = hasTonStake
      ? (matchResult.youWon ? `TON итог: +${(tonStake * 2).toFixed(9).replace(/\.?0+$/, '')} TON` : `TON итог: -${tonStake.toFixed(9).replace(/\.?0+$/, '')} TON`)
      : null;
    return (
      <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none`} style={safeFrameStyle}>
        <div className="z-10 flex flex-col items-center gap-6">
          {matchResult.opponentLeft ? (
            <>
              <h1 className="text-4xl font-black text-yellow-400">Соперник вышел</h1>
              <p className="text-gray-400">Победа засчитана!</p>
            </>
          ) : matchResult.youWon ? (
            <motion.h1 initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-b from-[#4aff93] to-[#00b548]">
              ПОБЕДА!
            </motion.h1>
          ) : (
            <motion.h1 initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-b from-[#ff6b6b] to-[#c90000]">
              ПОРАЖЕНИЕ
            </motion.h1>
          )}

          <div className="flex items-center gap-8 mt-4">
            <div className="text-center">
              <p className="text-blue-400 text-sm font-bold">{displayName || 'Ты'}</p>
              <p className="text-4xl font-black text-blue-400">{matchResult.scores[playerIndex]}</p>
            </div>
            <p className="text-2xl text-gray-600 font-bold">:</p>
            <div className="text-center">
              <p className="text-red-400 text-sm font-bold">{opponent}</p>
              <p className="text-4xl font-black text-red-400">{matchResult.scores[1 - playerIndex]}</p>
            </div>
          </div>
          {tonResultText && (
            <div className={`text-sm font-black ${matchResult.youWon ? 'text-emerald-300' : 'text-rose-300'}`}>{tonResultText}</div>
          )}

          <div className="flex flex-col items-center gap-2 mt-4 bg-white/5 p-3 rounded-xl border border-white/10">
            <KickDots history={history} playerIdx={playerIndex} totalKicks={5} label={displayName || 'Ты'} color="text-blue-400" />
            <KickDots history={history} playerIdx={1 - playerIndex} totalKicks={5} label={opponent} color="text-red-400" />
          </div>

          <div className="mt-6 flex gap-3">
            <button onClick={handleExitToMenu} className="bg-white/5 border border-white/20 text-white font-bold py-4 px-8 rounded-xl text-lg transition-all active:scale-95">
              Выйти
            </button>
            <button onClick={handlePlayAgain} className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-bold py-4 px-8 rounded-xl text-lg transition-all active:scale-95 shadow-lg shadow-blue-500/20">
              Ещё раз
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- GAME SCREEN --- (green grass background only here)
  const myScore = scores[playerIndex] ?? 0;
  const oppScore = scores[1 - playerIndex] ?? 0;

  return (
    <div className="h-screen bg-[#1a6b35] flex flex-col items-center overflow-hidden font-sans select-none relative" style={safeFrameStyle}>
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
            <KickDots history={history} playerIdx={playerIndex} totalKicks={5} label={displayName || 'Ты'} color="text-blue-400" />
            <KickDots history={history} playerIdx={1 - playerIndex} totalKicks={5} label={opponent} color="text-red-400" />
          </div>

          {/* Timer */}
          <div className="flex justify-center items-center mt-2 gap-2">
            {!zoneLocked && !showingResult && (
              <span className={`text-sm font-mono font-bold ${timer <= 3 ? 'text-red-400 animate-pulse' : 'text-white/40'}`}>
                {timer}с
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Role announcement removed — text moved below ball */}

      {/* Gate area + field markings */}
      <div className="relative z-10 w-[360px] h-[280px] mt-1 mx-auto flex justify-center">
        {/* Penalty area lines */}
        <div className="absolute bottom-[-80px] left-1/2 -translate-x-1/2 w-[280px] h-[60px] border-2 border-white/15 pointer-events-none z-0" />
        {/* Penalty spot */}
        <div className="absolute bottom-[-70px] left-1/2 -translate-x-1/2 w-[8px] h-[8px] rounded-full bg-white/25 pointer-events-none z-0" />
        <motion.div
          className="relative w-full h-full"
          animate={resultMessage?.type === 'win' ? { x: [-5, 5, -5, 5, 0] } : {}}
          transition={{ duration: 0.3 }}
        >
          <img src={`${ASSET_BASE}gate.png`} alt="Gate" className="absolute inset-0 w-full h-full object-contain z-0 drop-shadow-[0_20px_50px_rgba(0,0,0,0.5)]" />
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 w-[200px] h-[40px] bg-black/40 blur-xl rounded-[100%] z-0" />

          {/* Keeper */}
          <div
            className="absolute left-0 right-0 flex justify-center z-10 pointer-events-none"
            style={{
              bottom: keeperState === 'idle' ? '16px' : `${keeperBottom}px`,
              transform: `translateX(${keeperX}px)`,
              transition: 'transform 0.3s ease-out, bottom 0.3s ease-out',
            }}
          >
            <img
              src={keeperState === 'save' ? `${ASSET_BASE}keeper_save.png` : `${ASSET_BASE}keeper_idle.png`}
              alt="Keeper"
              className="object-contain drop-shadow-2xl"
              style={{
                height: keeperState === 'save' ? '100px' : '140px',
                transform: isKeeperMirrored ? 'scaleX(-1)' : 'scaleX(1)',
                transition: 'transform 0.15s ease-out, height 0.2s ease-out',
              }}
            />
          </div>

          {/* Ball */}
          <div className="absolute bottom-[-40px] left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <img src={`${ASSET_BASE}ball.png`} alt="Ball" className="w-[70px] h-[70px] drop-shadow-[0_10px_20px_rgba(0,0,0,0.6)]" style={ballStyle} />
          </div>

          {/* Zone buttons */}
          <div className="absolute top-0 left-4 w-[calc(100%-2rem)] h-[85%] grid grid-cols-2 grid-rows-2 z-30">
            {[0, 1, 2, 3].map((zone) => (
              <button
                key={zone}
                onClick={() => handleChooseZone(zone)}
                disabled={zoneLocked || showingResult}
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

      {/* Status text — below ball */}
      <div className="mt-14 z-10">
        {waitingOpponent && !showingResult && (
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-white/40 border-t-transparent rounded-full animate-spin" />
            <p className="text-white/40 text-sm font-bold">Ожидание соперника...</p>
          </div>
        )}
        {!zoneLocked && !showingResult && (
          <p className={`text-sm font-bold tracking-[0.2em] ${
            role === 'kicker' ? 'text-yellow-400/80' : 'text-blue-300/80'
          }`}>
            {role === 'kicker' ? '⚽ Выбери куда бить' : '🧤 Выбери куда прыгать'}
          </p>
        )}
      </div>
      {!!bottomNotice && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[9999] bg-black/90 text-white text-sm font-bold px-4 py-2 rounded-xl">
          {bottomNotice}
        </div>
      )}
    </div>
  );
};

export default GamePage;

