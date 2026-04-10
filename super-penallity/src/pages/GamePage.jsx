import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import confetti from 'canvas-confetti';
import { motion, AnimatePresence } from 'framer-motion';

const WS_URL = import.meta.env.DEV
  ? 'ws://localhost:3001'
  : 'wss://' + location.host;

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
  const [screen, setScreen] = useState('menu');
  const [playerName, setPlayerName] = useState('');
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

  const wsRef = useRef(null);
  const timerRef = useRef(null);
  const playerIndexRef = useRef(0);

  useEffect(() => { playerIndexRef.current = playerIndex; }, [playerIndex]);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg?.initDataUnsafe?.user) {
      setPlayerName(tg.initDataUnsafe.user.first_name || 'Player');
    }
    // Show Telegram back button
    if (tg?.BackButton) {
      tg.BackButton.show();
      tg.BackButton.onClick(() => { window.history.back(); });
    }
  }, []);

  useEffect(() => {
    return () => {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const connectWS = useCallback(() => {
    if (wsRef.current) wsRef.current.close();
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onclose = () => { wsRef.current = null; };
    return ws;
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
        handleRoundResult(msg);
        break;

      case 'match_result':
        setTimeout(() => {
          setMatchResult({ youWon: msg.youWon, scores: msg.scores });
          setScreen('result');
          if (msg.youWon) {
            confetti({ particleCount: 200, spread: 100, origin: { y: 0.5 } });
            window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
          } else {
            window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
          }
        }, 300);
        break;

      case 'opponent_left':
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
        if (prev <= 1) { stopTimer(); return 0; }
        return prev - 1;
      });
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const handleRoundResult = (msg) => {
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
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
        } else {
          setResultMessage({ text: 'GOAL!', type: 'loss' });
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
        }
      } else {
        if (iAmKicker) {
          setResultMessage({ text: 'SAVED!', type: 'loss' });
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
        } else {
          setResultMessage({ text: 'SAVED!', type: 'win' });
          confetti({ particleCount: 25, spread: 40, origin: { y: 0.6 }, ticks: 40 });
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
        }
      }
    }, 400);
  };

  const sendMessage = (type, data = {}) => {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type, ...data }));
    }
  };

  const handleFindGame = (bot = false) => {
    const name = playerName.trim() || 'Player';
    setPlayerName(name);
    const ws = connectWS();
    ws.onopen = () => {
      const tgUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || 'anon_' + Math.random().toString(36).slice(2, 8);
      ws.send(JSON.stringify({ type: bot ? 'find_bot' : 'find_game', name, tgUserId }));
    };
    ws.onmessage = (e) => handleServerMessage(JSON.parse(e.data));
  };

  const handleCancelWait = () => {
    sendMessage('cancel_wait');
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    setScreen('menu');
  };

  const handleChooseZone = (zone) => {
    if (zoneLocked || showingResult) return;
    sendMessage('choose_zone', { zone });
  };

  const handlePlayAgain = () => {
    setMatchResult(null);
    setHistory([]);
    setScreen('menu');
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
  };

  // ==================== RENDER ====================

  const darkBg = "bg-[#121214]";

  // --- MENU ---
  if (screen === 'menu') {
    return (
      <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none relative`}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,_rgba(59,130,246,0.08),_transparent_70%)] pointer-events-none" />

        <div className="z-10 flex flex-col items-center gap-6 w-full max-w-xs px-4">
          <button onClick={() => window.history.back()} className="self-start text-gray-400 hover:text-white text-sm transition-colors mb-2">← Назад</button>
          <h1 className="text-4xl font-black text-white tracking-tight">
            Super<span className="text-yellow-400">Penallity</span>
          </h1>
          <p className="text-gray-500 text-sm -mt-4">PvP Penalty Shootout</p>

          <input
            type="text"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            placeholder="Твоё имя"
            maxLength={20}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-center text-lg outline-none focus:border-yellow-400/50 transition-colors"
          />
          <button onClick={() => handleFindGame(false)} className="w-full bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-bold py-4 rounded-xl text-lg transition-all active:scale-95 shadow-lg shadow-blue-500/20">
            Онлайн
          </button>
          <button onClick={() => handleFindGame(true)} className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold py-4 rounded-xl text-lg transition-all active:scale-95">
            С ботом
          </button>
          <button onClick={() => { window.location.href = '/profile'; }} className="text-gray-500 hover:text-gray-300 text-sm mt-2 transition-colors">
            Профиль
          </button>
        </div>
      </div>
    );
  }

  // --- WAITING ---
  if (screen === 'waiting') {
    return (
      <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none`}>
        <div className="z-10 flex flex-col items-center gap-6">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-white text-xl font-bold">Ищем соперника...</p>
          <button onClick={handleCancelWait} className="text-gray-400 hover:text-white text-sm mt-4 px-6 py-2 border border-white/10 rounded-lg transition-colors">
            Отмена
          </button>
        </div>
      </div>
    );
  }

  // --- RESULT ---
  if (screen === 'result' && matchResult) {
    return (
      <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none`}>
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
              <p className="text-blue-400 text-sm font-bold">{playerName || 'Ты'}</p>
              <p className="text-4xl font-black text-blue-400">{matchResult.scores[playerIndex]}</p>
            </div>
            <p className="text-2xl text-gray-600 font-bold">:</p>
            <div className="text-center">
              <p className="text-red-400 text-sm font-bold">{opponent}</p>
              <p className="text-4xl font-black text-red-400">{matchResult.scores[1 - playerIndex]}</p>
            </div>
          </div>

          <div className="flex flex-col items-center gap-2 mt-4 bg-white/5 p-3 rounded-xl border border-white/10">
            <KickDots history={history} playerIdx={playerIndex} totalKicks={5} label={playerName || 'Ты'} color="text-blue-400" />
            <KickDots history={history} playerIdx={1 - playerIndex} totalKicks={5} label={opponent} color="text-red-400" />
          </div>

          <button onClick={handlePlayAgain} className="mt-6 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-bold py-4 px-12 rounded-xl text-lg transition-all active:scale-95 shadow-lg shadow-blue-500/20">
            Ещё раз
          </button>
        </div>
      </div>
    );
  }

  // --- GAME SCREEN --- (green grass background only here)
  const myScore = scores[playerIndex] ?? 0;
  const oppScore = scores[1 - playerIndex] ?? 0;

  return (
    <div className="h-screen bg-[#1a6b35] flex flex-col items-center overflow-hidden font-sans select-none relative">
      {/* Green field gradient */}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,_#145a2a_0%,_#1a6b35_30%,_#1e7a3c_60%,_#196330_100%)] pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_20%,_rgba(255,255,255,0.04),_transparent_50%)] pointer-events-none" />

      {/* Grass blades at bottom */}
      <GrassSVG />

      {/* Scoreboard */}
      <div className="z-10 w-full px-4 pt-3 mb-1">
        <div className="bg-black/40 backdrop-blur-md p-3 rounded-2xl border border-white/10 shadow-lg">
          {/* Scores row */}
          <div className="flex justify-between items-center">
            <div className="flex-1 text-center">
              <p className="text-[10px] text-blue-400 font-bold uppercase tracking-widest truncate">{playerName || 'Ты'}</p>
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
            <KickDots history={history} playerIdx={playerIndex} totalKicks={5} label={playerName || 'Ты'} color="text-blue-400" />
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
          <img src="/gate.png" alt="Gate" className="absolute inset-0 w-full h-full object-contain z-0 drop-shadow-[0_20px_50px_rgba(0,0,0,0.5)]" />
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
              src={keeperState === 'save' ? '/keeper_save.png' : '/keeper_idle.png'}
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
            <img src="/ball.png" alt="Ball" className="w-[70px] h-[70px] drop-shadow-[0_10px_20px_rgba(0,0,0,0.6)]" style={ballStyle} />
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
    </div>
  );
};

export default GamePage;
