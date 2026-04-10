import React, { useState, useRef, useEffect, useCallback } from 'react';
import confetti from 'canvas-confetti';
import { motion, AnimatePresence } from 'framer-motion';

const WS_URL = import.meta.env.DEV ? 'ws://localhost:3002' : 'wss://' + location.host;

// ============ SOUNDS (pooled) ============
const SFX_POOL = {};
function preloadSounds() {
  const vols = { click: 0.3, swoosh: 0.4, hit: 0.6, miss: 0.6, win: 0.6, lose: 0.6 };
  Object.entries(vols).forEach(([name, vol]) => {
    // Pool of 3 audio elements per sound — no cloneNode overhead
    SFX_POOL[name] = { pool: Array.from({ length: 3 }, () => { const a = new Audio(`/${name}.mp3`); a.preload = 'auto'; a.volume = vol; return a; }), idx: 0 };
  });
}
function sfx(name) {
  try {
    const s = SFX_POOL[name]; if (!s) return;
    const a = s.pool[s.idx % s.pool.length]; s.idx++;
    a.currentTime = 0; a.play().catch(() => {});
  } catch {}
}

// ============ LAYOUT ============
const HOOP = { x: 50, y: 28 };
const PLAYER_X = [28, 72];
const DIST_Y = { close: 50, mid: 58, far: 70 };
const START_Y = DIST_Y.mid;
const CHAR_W = Math.round(48 * 0.75);
const CHAR_H = Math.round(48 * 0.9 * 1.4 * 1.5 * 0.85);
const BALL_SIZE = 34;
const ST = { fontFamily: "'Russo One', 'Impact', sans-serif" };

const DISTS = [
  { key: 'close', label: 'БЛИЖНЯЯ', pts: '1 очко', pct: '~85%', bg: 'from-green-600 to-green-700' },
  { key: 'mid',   label: 'СРЕДНЯЯ', pts: '2 очка', pct: '~50%', bg: 'from-amber-500 to-amber-700' },
  { key: 'far',   label: 'ДАЛЬНЯЯ', pts: '3 очка', pct: '~35%', bg: 'from-red-500 to-red-700' },
];

// ============ CSS-ONLY AMBIENT (zero JS cost) ============
const Ambient = React.memo(() => (
  <div className="absolute inset-0 z-[2] pointer-events-none overflow-hidden">
    {[0,1,2,3].map(i => <div key={`l${i}`} className="leaf" style={{ left: `${10+i*25}%`, width:12, height:7, backgroundColor:['#4a7c3f','#5a8f4a','#3d6b35','#6b9e5a'][i], '--drift':`${30+i*15}px`,'--spin':`${360+i*90}deg`,'--dur':`${9+i*2}s`,'--delay':`${i*2.5}s` }} />)}
    {[0,1,2].map(i => <div key={`d${i}`} className="dust" style={{ left:`${20+i*30}%`, width:3, height:3, '--sway':`${i%2?20:-20}px`,'--dust-op':0.2,'--dur':`${6+i*2}s`,'--delay':`${i*2}s` }} />)}
    <div className="ray" style={{ left:'30%', width:60, height:'55%', transform:'rotate(14deg)', transformOrigin:'top center', '--dur':'8s','--delay':'0s' }} />
  </div>
));

// ============ COMPONENT ============
const GamePage = () => {
  const [screen, setScreen] = useState('menu');
  const [playerName, setPlayerName] = useState('');
  const [opponent, setOpponent] = useState('');
  const [playerIndex, setPlayerIndex] = useState(0);
  const [gamePhase, setGamePhase] = useState(null);
  const [scores, setScores] = useState([0, 0]);
  const [round, setRound] = useState(0);
  const [maxRounds, setMaxRounds] = useState(5);
  const [choosing, setChoosing] = useState(false);
  const [locked, setLocked] = useState(false);
  const [timer, setTimer] = useState(12);
  const [positions, setPositions] = useState([{ x: PLAYER_X[0], y: START_Y }, { x: PLAYER_X[1], y: START_Y }]);
  const [ballAnim, setBallAnim] = useState(null); // single ball, not array
  const [shotResult, setShotResult] = useState(null); // single result
  const [matchResult, setMatchResult] = useState(null);
  const [announce, setAnnounce] = useState(null);

  const wsRef = useRef(null);
  const timerRef = useRef(null);
  const piRef = useRef(0);
  const scoresRef = useRef([0, 0]);
  const nameRef = useRef('');
  const oppRef = useRef('');
  const gameRef = useRef(null);
  const pending = useRef([]);

  useEffect(() => { piRef.current = playerIndex; }, [playerIndex]);
  useEffect(() => { scoresRef.current = scores; }, [scores]);
  useEffect(() => { nameRef.current = playerName; }, [playerName]);
  useEffect(() => { oppRef.current = opponent; }, [opponent]);
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg?.initDataUnsafe?.user) setPlayerName(tg.initDataUnsafe.user.first_name || 'Player');
    if (tg?.BackButton) { tg.BackButton.show(); tg.BackButton.onClick(() => window.history.back()); }
    preloadSounds();
  }, []);
  useEffect(() => () => { wsRef.current?.close(); clearInterval(timerRef.current); pending.current.forEach(clearTimeout); }, []);

  function clearPending() { pending.current.forEach(clearTimeout); pending.current = []; }
  function sched(fn, ms) { pending.current.push(setTimeout(fn, ms)); }
  const startTimer = () => { stopTimer(); setTimer(12); timerRef.current = setInterval(() => setTimer(p => { if (p <= 1) { stopTimer(); return 0; } return p - 1; }), 1000); };
  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  const connectWS = useCallback(() => { wsRef.current?.close(); const ws = new WebSocket(WS_URL); wsRef.current = ws; ws.onclose = () => { wsRef.current = null; }; return ws; }, []);
  const send = (t, d = {}) => { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: t, ...d })); };

  // ============ TRAJECTORY (pixels, GPU transforms) ============
  function buildKF(shooterIdx, distance, made) {
    const el = gameRef.current; if (!el) return null;
    const W = el.offsetWidth, H = el.offsetHeight;
    const sx = PLAYER_X[shooterIdx]/100*W, sy = ((DIST_Y[distance]||START_Y)-5)/100*H;
    const hx = HOOP.x/100*W, hy = HOOP.y/100*H;
    const px = (sx+hx)/2, py = Math.min(sy,hy) - H*0.12;
    const [ex, ey] = made ? [hx, hy+H*0.12] : [hx+(shooterIdx===0?W*0.12:-W*0.12), hy+H*0.08];
    const o = BALL_SIZE/2;
    return { x:[sx-o,px-o,hx-o,ex-o], y:[sy-o,py-o,hy-o,ey-o], opacity: made?[1,1,1,0]:[1,1,0.8,0.1], scale:[1,0.85,0.75,made?0.35:0.5], rotate: made?[0,0,0,0]:[0,0,0,180] };
  }

  // ============ SHOT ANIMATION (sequential, minimal state updates) ============
  function animateRound(shots, phase, finalScores) {
    clearPending();
    const dur = phase === 1 ? 1.6 : 2.4, durMs = dur*1000;
    const moveMs = phase===1?100:400, showMs=1000, gap=300;
    const cycle = moveMs+durMs+showMs+gap;
    const pre = [...scoresRef.current];

    shots.forEach((shot, i) => {
      const t0 = i*cycle;
      // Move player
      sched(() => { if (phase!==1) setPositions(p=>{const n=[...p];n[shot.playerIndex]={x:PLAYER_X[shot.playerIndex],y:DIST_Y[shot.distance]||START_Y};return n;}); setShotResult(null); }, t0);
      // Ball
      sched(() => { sfx('swoosh'); const kf=buildKF(shot.playerIndex,shot.distance,shot.made); if(kf)setBallAnim({id:Date.now()+i,kf,duration:dur}); }, t0+moveMs);
      // Result (no confetti per shot — only on match end)
      const rimT = t0+moveMs+durMs*0.72;
      sched(() => { sfx(shot.made?'hit':'miss'); setShotResult({made:shot.made,points:shot.points}); if(i===0){const s=[...pre];s[shot.playerIndex]+=shot.points;setScores(s);}else setScores([...finalScores]); }, rimT);
      sched(() => setBallAnim(null), t0+moveMs+durMs+200);
      sched(() => setShotResult(null), rimT+showMs);
    });
    sched(() => setShotResult(null), shots.length*cycle+200);
  }

  // ============ SERVER ============
  const handleMsg = useCallback((msg) => {
    switch(msg.type) {
      case 'waiting': setScreen('waiting'); break;
      case 'game_found':
        setOpponent(msg.opponent); setPlayerIndex(msg.playerIndex); piRef.current=msg.playerIndex;
        setScores([0,0]); setGamePhase(null); setBallAnim(null); setShotResult(null);
        setPositions([{x:PLAYER_X[0],y:START_Y},{x:PLAYER_X[1],y:START_Y}]);
        setScreen('game'); break;
      case 'phase_start':
        setGamePhase(msg.phase===1?'warmup':msg.phase===2?'main':'overtime');
        setScores(msg.scores); setRound(0); setChoosing(false);
        setPositions([{x:PLAYER_X[0],y:START_Y},{x:PLAYER_X[1],y:START_Y}]);
        if(msg.phase===1) showAnnounce('WARM UP','5 авто-бросков · 1 очко');
        else if(msg.phase===2) showAnnounce('GAME ON','5 раундов');
        else showAnnounce('OVERTIME','До разницы'); break;
      case 'round_start': setAnnounce(null); setRound(msg.round); setMaxRounds(msg.maxRounds); setChoosing(true); setLocked(false); startTimer(); break;
      case 'choice_locked': setLocked(true); stopTimer(); break;
      case 'opponent_locked': break;
      case 'round_result': stopTimer(); setChoosing(false); setLocked(false); setRound(msg.round); setAnnounce(null); animateRound(msg.shots,msg.phase,msg.scores); break;
      case 'match_result':
        sched(() => { setMatchResult({youWon:msg.youWon,scores:msg.scores}); setScreen('result'); sfx(msg.youWon?'win':'lose');
          if(msg.youWon) confetti({particleCount:80,spread:80,origin:{y:0.5},colors:['#FFD700','#4AFF93','#FFF']});
        }, 600); break;
      case 'opponent_left': setMatchResult({youWon:true,scores:[0,0],opponentLeft:true}); setScreen('result'); break;
    }
  }, []);

  function showAnnounce(t,s){setAnnounce({title:t,sub:s});sched(()=>setAnnounce(null),1600);}

  const findGame=(bot)=>{sfx('click');const n=playerName.trim()||'Player';setPlayerName(n);
    const ws=connectWS();ws.onopen=()=>{const uid=window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString()||'anon_'+Math.random().toString(36).slice(2,8);ws.send(JSON.stringify({type:bot?'find_bot':'find_game',name:n,tgUserId:uid}));};
    ws.onmessage=(e)=>handleMsg(JSON.parse(e.data));};
  const cancelWait=()=>{send('cancel_wait');wsRef.current?.close();setScreen('menu');};
  const chooseDist=(d)=>{if(locked||!choosing)return;sfx('click');setChoosing(false);send('choose_distance',{distance:d});};
  const playAgain=()=>{clearPending();setMatchResult(null);setGamePhase(null);setScreen('menu');wsRef.current?.close();};

  // ============ RENDER ============
  const myName=playerName||'ТЫ',opName=opponent||'OPP',pi=playerIndex;

  if(screen==='menu') return (
    <div className="h-screen bg-[#0a0a0c] flex flex-col items-center justify-center overflow-hidden select-none" style={ST}>
      <div className="z-10 flex flex-col items-center gap-5 w-full max-w-sm px-5">
        <button onClick={()=>window.history.back()} className="self-start text-gray-400 hover:text-white text-sm uppercase tracking-wider" style={ST}>← Назад</button>
        <div className="text-8xl">🏀</div>
        <h1 className="text-5xl text-white tracking-widest uppercase">STREET<span className="text-amber-400">BALL</span></h1>
        <p className="text-gray-600 text-xs uppercase tracking-[0.4em] -mt-2">1 VS 1</p>
        <input type="text" value={playerName} onChange={e=>setPlayerName(e.target.value)} placeholder="ТВОЁ ИМЯ" maxLength={16}
          className="w-full bg-white/5 border-2 border-amber-500/30 rounded-xl px-4 py-4 text-white text-center text-xl uppercase outline-none focus:border-amber-400 tracking-wider" />
        <button onClick={()=>findGame(false)} className="w-full bg-amber-500 text-black py-5 rounded-xl text-xl uppercase tracking-widest active:scale-95">ОНЛАЙН</button>
        <button onClick={()=>findGame(true)} className="w-full bg-white/5 border-2 border-white/15 text-white py-5 rounded-xl text-xl uppercase tracking-widest active:scale-95">С БОТОМ</button>
      </div>
    </div>
  );

  if(screen==='waiting') return (
    <div className="h-screen bg-[#0a0a0c] flex flex-col items-center justify-center select-none" style={ST}>
      <div className="w-20 h-20 border-4 border-amber-500 border-t-transparent rounded-full animate-spin" />
      <p className="text-white text-3xl uppercase tracking-widest mt-6">ИЩЕМ...</p>
      <button onClick={cancelWait} className="text-gray-600 text-sm uppercase mt-8 px-8 py-3 border border-white/10 rounded-xl">Отмена</button>
    </div>
  );

  if(screen==='result'&&matchResult) {
    const ms=matchResult.scores[pi]??0, os=matchResult.scores[1-pi]??0;
    const myColor=pi===0?'text-blue-400':'text-red-400', opColor=pi===0?'text-red-400':'text-blue-400';
    return (
      <div className="h-screen bg-[#0a0a0c] flex flex-col items-center justify-center select-none" style={ST}>
        {matchResult.opponentLeft?<h1 className="text-4xl text-amber-400 uppercase tracking-widest">Соперник вышел</h1>
          :matchResult.youWon
            ?<div className="text-center"><div className="text-8xl mb-2">🏆</div><h1 className="text-7xl uppercase text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 to-green-500">WIN!</h1></div>
            :<div className="text-center"><div className="text-8xl mb-2">😔</div><h1 className="text-6xl uppercase text-transparent bg-clip-text bg-gradient-to-b from-red-300 to-red-600">LOSE</h1></div>
        }
        <div className="flex items-center gap-10 mt-8">
          <div className="text-center"><p className={`${myColor} text-base uppercase`}>{myName}</p><p className="text-7xl text-white mt-1">{ms}</p></div>
          <p className="text-4xl text-gray-700">:</p>
          <div className="text-center"><p className={`${opColor} text-base uppercase`}>{opName}</p><p className="text-7xl text-white mt-1">{os}</p></div>
        </div>
        <button onClick={playAgain} className="mt-10 bg-amber-500 text-black py-5 px-20 rounded-xl text-2xl uppercase tracking-widest active:scale-95">ЕЩЁ</button>
      </div>
    );
  }

  // --- GAME ---
  // Scoreboard matches court: P0=left(blue), P1=right(red)
  const p0Name=pi===0?myName:opName, p1Name=pi===1?myName:opName;
  const p0Score=scores[0]??0, p1Score=scores[1]??0;
  const phaseLabel=gamePhase==='warmup'?'WARM UP':gamePhase==='overtime'?'OT':null;

  return (
    <div className="h-screen relative overflow-hidden select-none" style={ST}>
      {/* BG */}
      <img src="/bg.webp" alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover object-top z-0"
        style={{ imageRendering:'pixelated', transformOrigin:'top center', transform:'scale(1.15) translateY(8%)' }} />

      <Ambient />

      {/* SCOREBOARD */}
      <div className="absolute top-0 left-0 right-0 z-30 px-2 pt-1">
        <div className="bg-black/85 border-b-2 border-amber-500/50 rounded-b-2xl px-4 py-2">
          <div className="flex justify-between items-center">
            <div className="flex-1 text-center">
              <p className="text-xs text-blue-400 uppercase tracking-wider truncate">{p0Name}</p>
              <p className="text-5xl text-blue-400 leading-none mt-0.5">{p0Score}</p>
            </div>
            <div className="flex flex-col items-center px-4 gap-0.5">
              <span className="text-2xl text-white/80 tracking-widest">VS</span>
              {phaseLabel&&<span className="text-[9px] text-gray-500 uppercase">{phaseLabel}</span>}
              {(gamePhase==='main'||gamePhase==='overtime')&&<span className="text-base text-amber-400">{round}/{maxRounds}</span>}
              {choosing&&!locked&&<span className={`text-sm ${timer<=3?'text-red-400 animate-pulse':'text-white/25'}`}>{timer}s</span>}
            </div>
            <div className="flex-1 text-center">
              <p className="text-xs text-red-400 uppercase tracking-wider truncate">{p1Name}</p>
              <p className="text-5xl text-red-400 leading-none mt-0.5">{p1Score}</p>
            </div>
          </div>
        </div>
      </div>

      {/* ANNOUNCE — simple fade, no spring */}
      {announce && (
        <div className="fixed inset-0 flex items-center justify-center z-[100] pointer-events-none animate-[fadeIn_0.2s]">
          <div className="absolute left-0 right-0 bg-black/65" style={{top:'38%',height:'24%'}} />
          <div className="relative z-10 text-center">
            <div className="text-5xl text-amber-400 uppercase tracking-[0.2em]" style={{textShadow:'0 4px 20px rgba(245,158,11,0.4)'}}>{announce.title}</div>
            {announce.sub&&<div className="text-white/40 text-sm mt-2 uppercase tracking-wider">{announce.sub}</div>}
          </div>
        </div>
      )}

      {/* GAME AREA */}
      <div ref={gameRef} className="absolute inset-0 z-10">
        {/* Players — CSS transitions, no framer-motion */}
        {[0,1].map(idx => (
          <div key={idx} className="absolute z-10" style={{
            width:CHAR_W,height:CHAR_H,marginLeft:-CHAR_W/2,marginTop:-CHAR_H,
            left:`${positions[idx].x}%`,top:`${positions[idx].y}%`,
            transition:'left 0.3s ease-out, top 0.3s ease-out', willChange:'left,top',
          }}>
            <img src="/Subway_Homeless_2_48x48.gif" alt="" draggable={false}
              style={{width:CHAR_W,height:CHAR_H,imageRendering:'pixelated',transform:idx===1?'scaleX(-1)':'none'}} />
            <div className={`absolute -top-4 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-wider whitespace-nowrap ${idx===0?'text-blue-400':'text-red-400'}`}
              style={{textShadow:'0 1px 3px rgba(0,0,0,0.9)'}}>{idx===0?p0Name:p1Name}</div>
          </div>
        ))}

        {/* Ball — framer-motion only for the arc (GPU transforms) */}
        {ballAnim && (
          <motion.img key={ballAnim.id} src="/Ball.png" alt="" draggable={false} className="absolute z-20"
            style={{left:0,top:0,width:BALL_SIZE,height:BALL_SIZE,imageRendering:'pixelated',willChange:'transform'}}
            initial={{x:ballAnim.kf.x[0],y:ballAnim.kf.y[0],opacity:1,scale:1,rotate:0}}
            animate={{x:ballAnim.kf.x,y:ballAnim.kf.y,opacity:ballAnim.kf.opacity,scale:ballAnim.kf.scale,rotate:ballAnim.kf.rotate}}
            transition={{duration:ballAnim.duration,times:[0,0.38,0.72,1],ease:'easeInOut'}}
          />
        )}

        {/* ✓/✗ below hoop — simple CSS, no spring physics */}
        {shotResult && (
          <div className="absolute z-40 pointer-events-none animate-[fadeIn_0.15s]"
            style={{left:'50%',top:`${HOOP.y+8}%`,transform:'translateX(-50%)'}}>
            <div className="flex flex-col items-center">
              <span className={`text-5xl ${shotResult.made?'text-green-400':'text-red-500'}`}
                style={{textShadow:'0 3px 12px rgba(0,0,0,0.8)'}}>
                {shotResult.made?'✓':'✗'}
              </span>
              {shotResult.points>0&&<span className="text-lg text-white" style={{textShadow:'0 2px 6px rgba(0,0,0,0.8)'}}>+{shotResult.points}</span>}
            </div>
          </div>
        )}
      </div>

      {/* BOTTOM */}
      <div className="absolute bottom-2 left-0 right-0 z-30 px-3">
        {choosing&&!locked ? (
          <div className="flex gap-2 animate-[fadeIn_0.2s]">
            {DISTS.map(d => (
              <button key={d.key} onClick={()=>chooseDist(d.key)}
                className={`flex-1 bg-gradient-to-b ${d.bg} text-white py-5 rounded-xl active:scale-95 border-2 border-white/10 uppercase`}>
                <div className="text-base tracking-wider">{d.label}</div>
                <div className="text-[11px] opacity-60 mt-0.5">{d.pts} · {d.pct}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex justify-center">
            {locked&&!shotResult&&(
              <div className="flex items-center gap-3 bg-black/70 px-6 py-3 rounded-xl">
                <div className="w-4 h-4 border-2 border-amber-400/40 border-t-transparent rounded-full animate-spin" />
                <p className="text-white/30 text-sm uppercase tracking-wider">Ожидание...</p>
              </div>
            )}
            {gamePhase==='warmup'&&!ballAnim&&!shotResult&&(
              <p className="text-amber-400/60 text-sm uppercase tracking-widest bg-black/60 px-5 py-3 rounded-xl">Авто-броски...</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default GamePage;
