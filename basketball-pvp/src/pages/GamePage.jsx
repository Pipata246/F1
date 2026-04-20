import React, { useState, useRef, useEffect, useCallback } from 'react';
import confetti from 'canvas-confetti';
import { motion, AnimatePresence } from 'framer-motion';

const ASSET_BASE = import.meta.env.BASE_URL || '/basketball-pvp/';
const SETTINGS_KEY = "f1duel_global_settings_v1";
function appSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { sound: s?.sound !== false, haptic: s?.haptic !== false };
  } catch {
    return { sound: true, haptic: true };
  }
}

// ============ SOUNDS (pooled) ============
const SFX_POOL = {};
function preloadSounds() {
  const vols = { click: 0.3, swoosh: 0.4, hit: 0.6, miss: 0.6, win: 0.6, lose: 0.6 };
  Object.entries(vols).forEach(([name, vol]) => {
    // Pool of 3 audio elements per sound — no cloneNode overhead
    SFX_POOL[name] = { pool: Array.from({ length: 3 }, () => { const a = new Audio(`${ASSET_BASE}${name}.mp3`); a.preload = 'auto'; a.volume = vol; return a; }), idx: 0 };
  });
}
function sfx(name) {
  try {
    if (!appSettings().sound) return;
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
  { key: 'close', label: 'БЛИЖНЯЯ', pts: '1 очко', pct: '~85%', bg: 'from-[#63e6be] to-[#8ff0cf]' },
  { key: 'mid',   label: 'СРЕДНЯЯ', pts: '2 очка', pct: '~50%', bg: 'from-[#48d2ac] to-[#63e6be]' },
  { key: 'far',   label: 'ДАЛЬНЯЯ', pts: '3 очка', pct: '~35%', bg: 'from-[#30b89e] to-[#48d2ac]' },
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
  const safeFrameStyle = {
    paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)',
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
    boxSizing: 'border-box',
  };
  const [screen, setScreen] = useState('stake-online');
  const [displayName, setDisplayName] = useState('Player');
  const [opponent, setOpponent] = useState('');
  const [playerIndex, setPlayerIndex] = useState(0);
  const [gamePhase, setGamePhase] = useState(null);
  const [scores, setScores] = useState([0, 0]);
  const [round, setRound] = useState(0);
  const [maxRounds, setMaxRounds] = useState(7);
  const [choosing, setChoosing] = useState(false);
  const [locked, setLocked] = useState(false);
  const [timer, setTimer] = useState(12);
  const [positions, setPositions] = useState([{ x: PLAYER_X[0], y: START_Y }, { x: PLAYER_X[1], y: START_Y }]);
  const [ballAnim, setBallAnim] = useState(null); // single ball, not array
  const [shotResult, setShotResult] = useState(null); // single result
  const [matchResult, setMatchResult] = useState(null);
  const [selectedStakeOptions, setSelectedStakeOptions] = useState([]);
  const [currentStakeTon, setCurrentStakeTon] = useState(null);
  const [balanceTon, setBalanceTon] = useState(0);
  const [bottomNotice, setBottomNotice] = useState('');
  const [announce, setAnnounce] = useState(null);
  const [selectedDistance, setSelectedDistance] = useState(null);
  const [roundResolving, setRoundResolving] = useState(false);
  const [acceptInfo, setAcceptInfo] = useState(null);
  const [acceptTick, setAcceptTick] = useState(0);

  const wsRef = useRef(null);
  const timerRef = useRef(null);
  const piRef = useRef(0);
  const scoresRef = useRef([0, 0]);
  const nameRef = useRef('');
  const oppRef = useRef('');
  const gameRef = useRef(null);
  const pending = useRef([]);
  const tgInitDataRef = useRef('');
  const matchSavedRef = useRef(false);
  const localMatchRef = useRef(null);
  const playModeRef = useRef('idle'); // idle | bot | pvp
  const pvpRoomIdRef = useRef(null);
  const pvpOpponentTgIdRef = useRef(null);
  const pvpOpponentIsBotRef = useRef(false);
  const pvpPollTimerRef = useRef(null);
  const pvpPollInFlightRef = useRef(false);
  const pvpLastRoundMarkerRef = useRef(0);
  const pvpLastPhaseKeyRef = useRef('');
  const pvpLastStartKeyRef = useRef('');
  const choiceLockedRef = useRef(false);
  const roundResolvingRef = useRef(false);
  // Defer "round_start" UI until after post-round announcement.
  const roundStartDeferredRef = useRef(null);
  const allowRoundStartAtRef = useRef(0);
  const noticeTimerRef = useRef(null);
  const launchHandledRef = useRef(false);

  useEffect(() => { piRef.current = playerIndex; }, [playerIndex]);
  useEffect(() => { scoresRef.current = scores; }, [scores]);
  useEffect(() => { nameRef.current = displayName; }, [displayName]);
  useEffect(() => { oppRef.current = opponent; }, [opponent]);
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tgInitDataRef.current = tg?.initData || '';
    if (tg?.BackButton) tg.BackButton.hide();
    preloadSounds();
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
    const onPageHidePvp = () => postPvp('pvpLeaveRoom');
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onPageHidePvp);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHidePvp);
    };
  }, []);
  useEffect(() => () => {
    if (playModeRef.current === 'pvp' && pvpRoomIdRef.current && tgInitDataRef.current) {
      const payload = JSON.stringify({ action: 'pvpLeaveRoom', initData: tgInitDataRef.current, roomId: pvpRoomIdRef.current });
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
    wsRef.current?.close();
    clearInterval(timerRef.current);
    if (pvpPollTimerRef.current) clearInterval(pvpPollTimerRef.current);
    pending.current.forEach(clearTimeout);
  }, []);

  function clearPending() { pending.current.forEach(clearTimeout); pending.current = []; }
  function sched(fn, ms) { pending.current.push(setTimeout(fn, ms)); }
  const startTimer = () => { stopTimer(); setTimer(12); timerRef.current = setInterval(() => setTimer(p => { if (p <= 1) { stopTimer(); if (choosing && !locked) { choiceLockedRef.current = true; setLocked(true); setChoosing(false); if (playModeRef.current === 'pvp' && pvpRoomIdRef.current && tgInitDataRef.current) { apiPost({ action: 'pvpSubmitMove', initData: tgInitDataRef.current, roomId: pvpRoomIdRef.current, move: { distance: 'mid' } }).catch(() => {}); } else if (playModeRef.current === 'bot') { localOnClientMessage('choose_distance', { distance: 'mid' }); } } return 0; } return p - 1; }), 1000); };
  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  const apiPost = useCallback(async (payload) => {
    const res = await fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return res.json();
  }, []);

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
  function normalizeShotsForViewer(shotsRaw) {
    const arr = Array.isArray(shotsRaw) ? shotsRaw.slice() : [];
    const me = Number(piRef.current || 0);
    // In online mode, always show shots in fixed order (player 0 then player 1) for synchronization.
    // In bot mode, show player's throw first.
    if (playModeRef.current === 'pvp') {
      arr.sort((a, b) => {
        const ai = Number(a?.playerIndex || 0);
        const bi = Number(b?.playerIndex || 0);
        return ai - bi;
      });
    } else {
      arr.sort((a, b) => {
        const am = Number(a?.playerIndex) === me ? 0 : 1;
        const bm = Number(b?.playerIndex) === me ? 0 : 1;
        return am - bm;
      });
    }
    return arr;
  }

  function roundAnimTotalMs(phase, shotsCount) {
    const dur = phase === 1 ? 1.6 : 2.4, durMs = dur * 1000;
    const moveMs = phase === 1 ? 100 : 400, showMs = 1000, gap = 300;
    const cycle = moveMs + durMs + showMs + gap;
    return Math.max(0, Number(shotsCount || 0)) * cycle + 200;
  }

  function animateRound(shotsRaw, phase, finalScores, onDone) {
    clearPending();
    const shots = normalizeShotsForViewer(shotsRaw);
    const dur = phase === 1 ? 1.6 : 2.4, durMs = dur*1000;
    const moveMs = phase===1?100:400, showMs=1000, gap=300;
    const cycle = moveMs+durMs+showMs+gap;

    shots.forEach((shot, i) => {
      const t0 = i*cycle;
      // Move player
      sched(() => {
        if (phase !== 1) {
          setPositions(() => {
            const n = [{ x: PLAYER_X[0], y: START_Y }, { x: PLAYER_X[1], y: START_Y }];
            n[shot.playerIndex] = { x: PLAYER_X[shot.playerIndex], y: DIST_Y[shot.distance] || START_Y };
            return n;
          });
        }
        setShotResult(null);
      }, t0);
      // Ball
      sched(() => { sfx('swoosh'); const kf=buildKF(shot.playerIndex,shot.distance,shot.made); if(kf)setBallAnim({id:Date.now()+i,kf,duration:dur}); }, t0+moveMs);
      // Result: show per-shot only, no score updates mid-sequence.
      const rimT = t0+moveMs+durMs*0.72;
      sched(() => { sfx(shot.made?'hit':'miss'); setShotResult({made:shot.made,points:shot.points}); }, rimT);
      sched(() => setBallAnim(null), t0+moveMs+durMs+200);
      sched(() => setShotResult(null), rimT+showMs);
    });
    const endAt = shots.length * cycle + 200;
    sched(() => {
      setShotResult(null);
      // In online mode, scores are already updated by server
      if (playModeRef.current !== 'pvp') {
        setScores([...finalScores]);
      }
      onDone?.();
    }, endAt);
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
        setGamePhase(msg.phase===2?'main':'overtime');
        setScores(msg.scores); setRound(0); setChoosing(false);
        setPositions([{x:PLAYER_X[0],y:START_Y},{x:PLAYER_X[1],y:START_Y}]);
        if(msg.phase===2) showAnnounce('GAME ON','7 раундов');
        else showAnnounce('OVERTIME','До разницы'); break;
      case 'round_start':
        // Stage (4): do not start the next selection UI until "GAME ON" disappears (bot mode only).
        if (playModeRef.current !== 'pvp' && Date.now() < Number(allowRoundStartAtRef.current || 0)) {
          roundStartDeferredRef.current = msg;
          break;
        }
        // Never show next-turn controls while previous round animations are still playing.
        if (roundResolvingRef.current) break;
        setAnnounce(null);
        setRound(msg.round);
        setMaxRounds(msg.maxRounds);
        setChoosing(true);
        setLocked(false);
        startTimer();
        break;
      case 'choice_locked': setLocked(true); choiceLockedRef.current = true; stopTimer(); break;
      case 'opponent_locked': break;
      case 'round_result':
        // Ignore if already resolving (server sends multiple round_result messages)
        if (roundResolvingRef.current) return;
        stopTimer();
        setChoosing(false);
        setLocked(false);
        setRound(msg.round);
        setAnnounce(null);
        roundResolvingRef.current = true;
        setRoundResolving(true);
        animateRound(msg.shots, msg.phase, msg.scores, () => {
          roundResolvingRef.current = false;
          setRoundResolving(false);
          // Update scores after animation completes
          setScores(msg.scores);
        });
        break;
      case 'match_result':
        sched(() => { setMatchResult({youWon:msg.youWon,scores:msg.scores}); setScreen('result'); sfx(msg.youWon?'win':'lose');
          if (playModeRef.current === 'bot') saveMatchToBackend(msg.youWon, msg.scores);
          if(msg.youWon) confetti({particleCount:80,spread:80,origin:{y:0.5},colors:['#FFD700','#4AFF93','#FFF']});
        }, 600); break;
      case 'opponent_left': setMatchResult({youWon:true,scores:[0,0],opponentLeft:true}); setScreen('result'); break;
    }
  }, []);

  function showAnnounce(t,s){setAnnounce({title:t,sub:s});sched(()=>setAnnounce(null),1600);}

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
    if (String(room.status) === 'active' && !room.player2_tg_user_id) { setScreen('waiting'); return; }

    const myTg = String(window.Telegram?.WebApp?.initDataUnsafe?.user?.id || '');
    const meIsP1 = String(room.player1_tg_user_id || '') === myTg;
    const myIdx = meIsP1 ? 0 : 1;
    const mySide = meIsP1 ? 'p1' : 'p2';
    pvpOpponentTgIdRef.current = meIsP1 ? String(room.player2_tg_user_id || '') : String(room.player1_tg_user_id || '');
    pvpOpponentIsBotRef.current = pvpOpponentTgIdRef.current.startsWith('bot_fallback_');
    setScreen('game');
    setAcceptInfo(null);
    setPlayerIndex(myIdx);
    piRef.current = myIdx;
    setOpponent(meIsP1 ? (room.player2_name || 'Соперник') : (room.player1_name || 'Соперник'));
    setCurrentStakeTon(room.stake_ton != null ? Number(room.stake_ton) : null);

    const phaseNum = Number(s.phaseNum || 1);
    const phaseKey = `${phaseNum}:${String(s.phase || '')}`;
    if (phaseKey !== pvpLastPhaseKeyRef.current) {
      pvpLastPhaseKeyRef.current = phaseKey;
      handleMsg({ type: 'phase_start', phase: phaseNum, scores: [Number(s?.scores?.p1 || 0), Number(s?.scores?.p2 || 0)] });
    }

    const rr = s.lastRoundResult || {};
    const marker = Number(rr.marker || 0);
    if (marker > pvpLastRoundMarkerRef.current) {
      pvpLastRoundMarkerRef.current = marker;
      handleMsg({
        type: 'round_result',
        shots: Array.isArray(rr.shots) ? rr.shots : [],
        phase: Number(rr.phaseNum || phaseNum),
        round: Number(rr.round || 0),
        scores: [Number(rr?.scores?.p1 || 0), Number(rr?.scores?.p2 || 0)],
      });
      return;
    }

    if (s.phase === 'turn_input') {
      const startKey = `${phaseNum}:${Number(s.round || 0)}`;
      if (startKey === pvpLastStartKeyRef.current) return;
      if (roundResolvingRef.current) return;
      pvpLastStartKeyRef.current = startKey;
      choiceLockedRef.current = false;
      setSelectedDistance(null);
      handleMsg({
        type: 'round_start',
        round: Number(s.round || 0) + 1,
        maxRounds: Number(s.maxRounds || 7),
        phase: phaseNum,
        scores: [Number(s?.scores?.p1 || 0), Number(s?.scores?.p2 || 0)],
      });
      return;
    }

    if (s.phase === 'match_over' || String(room.status) === 'finished' || String(room.status) === 'cancelled') {
      stopPvpPolling();
      pvpRoomIdRef.current = null;
      const arr = [Number(s?.scores?.p1 || 0), Number(s?.scores?.p2 || 0)];
      let youWon = false;
      if (s.winnerSide) youWon = s.winnerSide === mySide;
      else if (arr[0] !== arr[1]) youWon = myIdx === 0 ? arr[0] > arr[1] : arr[1] > arr[0];
      if (s.endedByLeave && s.leftBy && String(s.leftBy) !== myTg) {
        setMatchResult({ youWon: true, scores: arr, opponentLeft: true });
        setScreen('result');
        return;
      }
      handleMsg({ type: 'match_result', youWon, scores: arr });
    }
  }, [handleMsg, stopPvpPolling]);

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
          findGameOnline();
        }
        return;
      }
      if (data.room) applyPvpRoomState(data.room);
    }).catch(() => {}).finally(() => {
      pvpPollInFlightRef.current = false;
    });
  }, [apiPost, applyPvpRoomState, stopPvpPolling, goHome, acceptInfo]);

  const startPvpPolling = useCallback(() => {
    stopPvpPolling();
    pvpPollTimerRef.current = setInterval(() => pvpPollState(), 900);
    pvpPollState();
  }, [pvpPollState, stopPvpPolling]);

  function resolveShot(distance) {
    const cfg = {
      close: { points: 1, baseChance: 0.85, variance: 0.1 },
      mid: { points: 2, baseChance: 0.5, variance: 0.1 },
      far: { points: 3, baseChance: 0.35, variance: 0.1 },
    }[distance] || { points: 2, baseChance: 0.5, variance: 0.1 };
    const chance = cfg.baseChance + (Math.random() * 2 - 1) * cfg.variance;
    const made = Math.random() < chance;
    return { made, points: made ? cfg.points : 0 };
  }
  function botChooseDistance(myScore, oppScore) {
    const diff = myScore - oppScore;
    let w;
    if (diff >= 4) w = { close: 55, mid: 35, far: 10 };
    else if (diff >= 2) w = { close: 35, mid: 45, far: 20 };
    else if (diff > 0) w = { close: 25, mid: 45, far: 30 };
    else if (diff === 0) w = { close: 15, mid: 45, far: 40 };
    else if (diff >= -2) w = { close: 10, mid: 35, far: 55 };
    else w = { close: 5, mid: 25, far: 70 };
    const total = w.close + w.mid + w.far;
    const r = Math.random() * total;
    if (r < w.close) return 'close';
    if (r < w.close + w.mid) return 'mid';
    return 'far';
  }
  function localStartRound() {
    const m = localMatchRef.current;
    if (!m || m.finished) return;
    m.choices = [null, null];
    choiceLockedRef.current = false;
    setSelectedDistance(null);
    const max = m.phase === 2 ? 7 : 999;
    handleMsg({ type: 'round_start', round: m.round + 1, maxRounds: max, phase: m.phase, scores: [...m.scores] });
  }
  function localFinishMatch() {
    const m = localMatchRef.current;
    if (!m || m.finished) return;
    m.finished = true;
    handleMsg({ type: 'match_result', youWon: m.scores[0] > m.scores[1], scores: [...m.scores] });
  }
  function localResolveRound() {
    const m = localMatchRef.current;
    if (!m || m.finished) return;
    const shots = [0, 1].map((i) => {
      const distance = m.choices[i];
      const { made, points } = resolveShot(distance);
      m.scores[i] += points;
      return { playerIndex: i, distance, made, points };
    });
    m.round += 1;
    handleMsg({ type: 'round_result', shots, scores: [...m.scores], round: m.round, phase: m.phase });
    // Prevent demo freeze: schedule next step after actual round animation + "GAME ON".
    const afterMs = roundAnimTotalMs(m.phase, 2) + 1650;
    if (m.phase === 2 && m.round >= 7) {
      if (m.scores[0] !== m.scores[1]) sched(() => localFinishMatch(), afterMs);
      else sched(() => { m.phase = 3; m.round = 0; handleMsg({ type: 'phase_start', phase: 3, scores: [...m.scores] }); sched(localStartRound, 800); }, afterMs);
      return;
    }
    if (m.phase === 3) {
      if (m.scores[0] !== m.scores[1]) sched(() => localFinishMatch(), afterMs);
      else sched(localStartRound, afterMs);
      return;
    }
    sched(localStartRound, afterMs);
  }
  function localOnClientMessage(type, data = {}) {
    const m = localMatchRef.current;
    if (type === 'find_game' || type === 'find_bot') {
      const uid = data.tgUserId || null;
      localMatchRef.current = {
        tgUserId: uid,
        phase: 2,
        round: 0,
        scores: [0, 0],
        choices: [null, null],
        finished: false,
      };
      handleMsg({ type: 'waiting' });
      sched(() => {
        handleMsg({ type: 'game_found', opponent: 'БОТ', playerIndex: 0 });
        handleMsg({ type: 'phase_start', phase: 2, scores: [0, 0] });
        sched(localStartRound, 800);
      }, 550);
      return;
    }
    if (!m || m.finished) return;
    if (type === 'cancel_wait') { localMatchRef.current = null; return; }
    if (type === 'choose_distance') {
      if (m.choices[0] !== null) return;
      m.choices[0] = data.distance || 'mid';
      choiceLockedRef.current = true;
      handleMsg({ type: 'choice_locked' });
      m.choices[1] = botChooseDistance(m.scores[1], m.scores[0]);
      sched(localResolveRound, 450);
    }
  }
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

  const findGameOnline = () => {
    sfx('click');
    const n = displayName.trim() || 'Player';
    const stakes = askStakeOptions();
    if (!stakes) return;
    tgInitDataRef.current = window.Telegram?.WebApp?.initData || tgInitDataRef.current || '';
    setSelectedStakeOptions(stakes);
    setCurrentStakeTon(null);
    matchSavedRef.current = false;
    clearPending();
    pvpLastRoundMarkerRef.current = 0;
    pvpLastPhaseKeyRef.current = '';
    pvpLastStartKeyRef.current = '';
    stopPvpPolling();
    pvpRoomIdRef.current = null;

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
      initData: tgInitDataRef.current,
      gameKey: 'basketball',
      playerName: n,
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

  const findGameBot = () => {
    sfx('click');
    const n = displayName.trim() || 'Player';
    matchSavedRef.current = false;
    clearPending();
    stopPvpPolling();
    pvpRoomIdRef.current = null;
    setCurrentStakeTon(null);
    playModeRef.current = 'bot';
    localOnClientMessage('find_bot', { name: n, tgUserId: window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || null });
  };


  const cancelWait = () => {
    clearPending();
    const mode = playModeRef.current;
    if (mode === 'bot') {
      localOnClientMessage('cancel_wait');
      playModeRef.current = 'idle';
      goHome();
      return;
    }
    if (mode === 'pvp') {
      const rid = pvpRoomIdRef.current;
      pvpRoomIdRef.current = null;
      stopPvpPolling();
      if (rid && tgInitDataRef.current) {
        apiPost({ action: 'pvpCancelQueue', initData: tgInitDataRef.current, roomId: rid }).catch(() => {});
      }
    }
    playModeRef.current = 'idle';
    goHome();
  };

  const chooseDist = (d) => {
    if (locked || !choosing || choiceLockedRef.current || roundResolvingRef.current) return;
    choiceLockedRef.current = true;
    sfx('click');
    setChoosing(false);
    setSelectedDistance(d);
    if (playModeRef.current === 'pvp') {
      if (!pvpRoomIdRef.current || !tgInitDataRef.current) return;
      setLocked(true);
      stopTimer();
      apiPost({
        action: 'pvpSubmitMove',
        initData: tgInitDataRef.current,
        roomId: pvpRoomIdRef.current,
        move: { distance: d },
      }).then((data) => {
        if (data?.ok && data.room) applyPvpRoomState(data.room);
      }).catch(() => {
        setLocked(false);
        choiceLockedRef.current = false;
        setSelectedDistance(null);
      });
      return;
    }
    localOnClientMessage('choose_distance', { distance: d });
  };

  const playAgain = () => {
    clearPending();
    stopPvpPolling();
    pvpRoomIdRef.current = null;
    playModeRef.current = 'idle';
    setMatchResult(null);
    setGamePhase(null);
    goHome();
  };
  function saveMatchToBackend(youWon, finalScores) {
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
          gameKey: 'basketball',
          mode: 'bot',
          winnerTgUserId: youWon ? tgUserId : null,
          players: [
            { tgUserId, name: displayName || 'Player', score: finalScores?.[0] || 0, isWinner: !!youWon, isBot: false },
            { tgUserId: null, name: opponent || 'БОТ', score: finalScores?.[1] || 0, isWinner: !youWon, isBot: true },
          ],
          score: { left: finalScores?.[0] || 0, right: finalScores?.[1] || 0 },
          details: { phase: gamePhase || null, roundsPlayed: round || 0 },
        },
      }),
    }).catch(() => { matchSavedRef.current = false; });
  }

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

  // ============ RENDER ============
  const myName=displayName||'ТЫ',opName=opponent||'OPP',pi=playerIndex;

  if(screen==='menu') return null;

  if (screen==='demo-intro') return (
    <div className="h-screen bg-[#0a0a0c] flex flex-col items-center justify-center overflow-hidden select-none" style={{ ...ST, ...safeFrameStyle }}>
      <div className="z-10 w-full max-w-sm px-5 text-center">
        <h1 className="text-3xl text-white uppercase tracking-widest">ДЭМО РЕЖИМ</h1>
        <p className="text-gray-300 text-sm mt-3 leading-relaxed">
          Тренировочная игра против бота в стиле Streetball. Без TON-ставок:
          можно спокойно тестировать дистанции и ритм бросков.
        </p>
        <button onClick={()=>findGameBot()} className="w-full mt-5 bg-emerald-500 text-black py-3 rounded-xl uppercase tracking-wider">Играть</button>
        <button onClick={()=>goHome()} className="w-full mt-2 bg-white/5 border border-white/15 text-white py-3 rounded-xl uppercase tracking-wider">Назад</button>
      </div>
    </div>
  );

  if(screen==='stake-online') return (
    <div className="h-screen bg-[#0a0a0c] flex flex-col items-center justify-center overflow-hidden select-none" style={{ ...ST, ...safeFrameStyle }}>
      <div className="z-10 flex flex-col items-center gap-5 w-full max-w-sm px-5">
        <button onClick={()=>goHome()} className="self-start text-gray-400 hover:text-white text-sm uppercase tracking-wider" style={ST}>← Назад</button>
        <div className="text-8xl">🏀</div>
        <h1 className="text-5xl text-white tracking-widest uppercase">STREET<span className="text-amber-400">BALL</span></h1>
        <p className="text-[11px] text-gray-500 uppercase tracking-[0.2em] mb-2 text-center">Выбери ставки</p>
        <div className="w-full max-w-xs mx-auto">
          <div className="grid grid-cols-3 gap-2">
            {[1, 5, 10, 25, 50, 100].map((stake) => {
              const active = selectedStakeOptions.includes(stake);
              const blocked = Number(balanceTon || 0) < Number(stake);
              return (
                <button
                  key={stake}
                  type="button"
                  onClick={() => toggleStakeOption(stake)}
                  className={`aspect-square rounded-lg border-2 text-xs uppercase tracking-wider ${
                    blocked
                      ? 'bg-green-500/20 border-green-400 text-green-200'
                      : active
                        ? 'bg-emerald-400/20 border-emerald-300 text-emerald-200 shadow-[0_0_14px_rgba(34,197,94,0.35)]'
                        : 'bg-white/5 border-white/15 text-white/75 hover:bg-white/10'
                  }`}
                >
                  {stake} TON
                </button>
              );
            })}
          </div>
          <button onClick={()=>findGameOnline()} className="w-full mt-3 bg-emerald-500 text-black py-4 rounded-xl text-lg uppercase tracking-widest active:scale-95">Играть</button>
        </div>
        {!!bottomNotice && (
          <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[9999] bg-black/90 text-white text-sm font-bold px-4 py-2 rounded-xl">
            {bottomNotice}
          </div>
        )}
      </div>
    </div>
  );

  if(screen==='waiting') return (
    <div className="h-screen bg-[#0a0a0c] flex flex-col items-center justify-center select-none" style={{ ...ST, ...safeFrameStyle }}>
      <div className="w-20 h-20 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      <p className="text-white text-3xl uppercase tracking-widest mt-6">ИЩЕМ...</p>
      {!!selectedStakeOptions.length && <p className="text-gray-400 text-sm uppercase mt-2">Ставки: {selectedStakeOptions.join(', ')} TON</p>}
      <button onClick={cancelWait} className="text-gray-600 text-sm uppercase mt-8 px-8 py-3 border border-white/10 rounded-xl">Отмена</button>
      {!!acceptInfo && (
        <div className="fixed inset-0 z-[999] bg-black/65 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-gradient-to-b from-[#6a3b1f] to-[#3f2517] border border-emerald-200/35 rounded-2xl p-5 text-center shadow-2xl">
            <p className="text-white text-lg uppercase tracking-wider">Матч найден</p>
            <p className="text-gray-100 text-sm mt-2">{acceptInfo.p1} vs {acceptInfo.p2}</p>
            {acceptInfo.stake != null && <p className="text-emerald-200 text-sm mt-1">Ставка: {acceptInfo.stake} TON</p>}
            <p className={`text-3xl font-black mt-2 ${Math.max(0, Math.ceil((Number(acceptInfo.deadlineMs || 0) - Date.now()) / 1000)) <= 3 ? 'text-rose-200' : 'text-emerald-200'}`}>{Math.max(0, Math.ceil((Number(acceptInfo.deadlineMs || 0) - Date.now()) / 1000)) + (acceptTick * 0)}с</p>
            <p className="mt-3 text-xs text-emerald-100/90 uppercase tracking-wider">Игра начнется автоматически</p>
          </div>
        </div>
      )}
    </div>
  );

  if(screen==='result'&&matchResult) {
    const ms=matchResult.scores[pi]??0, os=matchResult.scores[1-pi]??0;
    const myColor=pi===0?'text-emerald-400':'text-emerald-400', opColor=pi===0?'text-emerald-400':'text-emerald-400';
    const tonStake = Number(currentStakeTon || 0);
    const hasTonStake = playModeRef.current !== 'bot' && Number.isFinite(tonStake) && tonStake > 0;
    const tonResultText = hasTonStake
      ? (matchResult.youWon ? `TON итог: +${(tonStake * 2).toFixed(9).replace(/\.?0+$/, '')} TON` : `TON итог: -${tonStake.toFixed(9).replace(/\.?0+$/, '')} TON`)
      : null;
    return (
      <div className="h-screen bg-[#0a0a0c] flex flex-col items-center justify-center select-none" style={{ ...ST, ...safeFrameStyle }}>
        {matchResult.opponentLeft?<h1 className="text-4xl text-emerald-400 uppercase tracking-widest">Соперник вышел</h1>
          :matchResult.youWon
            ?<div className="text-center"><div className="text-8xl mb-2">🏆</div><h1 className="text-7xl uppercase text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 to-green-500">WIN!</h1></div>
            :<div className="text-center"><div className="text-8xl mb-2">😔</div><h1 className="text-6xl uppercase text-transparent bg-clip-text bg-gradient-to-b from-red-300 to-red-600">LOSE</h1></div>
        }
        <div className="flex items-center gap-10 mt-8">
          <div className="text-center"><p className={`${myColor} text-base uppercase`}>{myName}</p><p className="text-7xl text-white mt-1">{ms}</p></div>
          <p className="text-4xl text-gray-700">:</p>
          <div className="text-center"><p className={`${opColor} text-base uppercase`}>{opName}</p><p className="text-7xl text-white mt-1">{os}</p></div>
        </div>
        {tonResultText && <div className={`mt-3 text-sm uppercase ${matchResult.youWon ? 'text-emerald-300' : 'text-rose-300'}`}>{tonResultText}</div>}
        <button onClick={playAgain} className="mt-10 bg-emerald-500 text-black py-5 px-20 rounded-xl text-2xl uppercase tracking-widest active:scale-95">ЕЩЁ</button>
      </div>
    );
  }

  // --- GAME ---
  // Scoreboard matches court: P0=left(blue), P1=right(red)
  const p0Name=pi===0?myName:opName, p1Name=pi===1?myName:opName;
  const p0Score=scores[0]??0, p1Score=scores[1]??0;
  const phaseLabel=gamePhase==='overtime'?'OT':null;

  return (
    <div className="h-screen relative overflow-hidden select-none" style={{ ...ST, ...safeFrameStyle }}>
      {/* BG */}
      <img src={`${ASSET_BASE}bg.webp`} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover object-top z-0"
        style={{ imageRendering:'pixelated', transformOrigin:'top center', transform:'scale(1.15) translateY(8%)' }} />

      <Ambient />

      {/* SCOREBOARD */}
      <div className="absolute top-0 left-0 right-0 z-30 px-2 pt-1">
        <div className="bg-black/85 border-b-2 border-[#34C759]/50 rounded-b-2xl px-4 py-2">
          {currentStakeTon != null && <div className="text-center text-[10px] text-emerald-300 uppercase tracking-wider mb-1">Ставка: {currentStakeTon} TON</div>}
          <div className="flex justify-between items-center">
            <div className="flex-1 text-center">
              <p className="text-xs text-[#34C759] uppercase tracking-wider truncate">{p0Name}{pi===0?' · ТЫ':' · СОПЕРНИК'}</p>
              <p className="text-5xl text-[#34C759] leading-none mt-0.5">{p0Score}</p>
            </div>
            <div className="flex flex-col items-center px-4 gap-0.5">
              <span className="text-2xl text-white/80 tracking-widest">VS</span>
              {phaseLabel&&<span className="text-[9px] text-gray-500 uppercase">{phaseLabel}</span>}
              {(gamePhase==='main'||gamePhase==='overtime')&&<span className="text-base text-emerald-400">{round}/{maxRounds}</span>}
              {choosing&&!locked&&<span className={`text-sm ${timer<=3?'text-red-400 animate-pulse':'text-white/25'}`}>{timer}s</span>}
            </div>
            <div className="flex-1 text-center">
              <p className="text-xs text-[#34C759] uppercase tracking-wider truncate">{p1Name}{pi===1?' · ТЫ':' · СОПЕРНИК'}</p>
              <p className="text-5xl text-[#34C759] leading-none mt-0.5">{p1Score}</p>
            </div>
          </div>
        </div>
      </div>

      {/* ANNOUNCE — simple fade, no spring */}
      {announce && (
        <div className="fixed inset-0 flex items-center justify-center z-[100] pointer-events-none animate-[fadeIn_0.2s]">
          <div className="absolute left-0 right-0 bg-black/65" style={{top:'38%',height:'24%'}} />
          <div className="relative z-10 text-center">
            <div className="text-5xl text-[#63e6be] uppercase tracking-[0.2em]" style={{textShadow:'0 4px 20px rgba(99,230,190,0.4)'}}>{announce.title}</div>
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
            <img src={`${ASSET_BASE}Subway_Homeless_2_48x48.gif`} alt="" draggable={false}
              style={{width:CHAR_W,height:CHAR_H,imageRendering:'pixelated',transform:idx===1?'scaleX(-1)':'none'}} />
            <div className={`absolute -top-4 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-wider whitespace-nowrap ${idx===0?'text-[#63e6be]':'text-[#8ff0cf]'}`}
              style={{textShadow:'0 1px 3px rgba(0,0,0,0.9)'}}>
              {idx===0?p0Name:p1Name}{idx===pi?' · ТЫ':' · OPP'}
            </div>
          </div>
        ))}

        {/* Ball — framer-motion only for the arc (GPU transforms) */}
        {ballAnim && (
          <motion.img key={ballAnim.id} src={`${ASSET_BASE}Ball.png`} alt="" draggable={false} className="absolute z-20"
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
              <span className={`text-5xl ${shotResult.made?'text-[#63e6be]':'text-red-500'}`}
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
        {choosing&&!locked&&!roundResolving ? (
          <div className="flex gap-2 animate-[fadeIn_0.2s]">
            {DISTS.map(d => (
              <button key={d.key} onClick={()=>chooseDist(d.key)}
                disabled={!!selectedDistance}
                className={`flex-1 bg-gradient-to-b ${d.bg} text-black py-5 rounded-xl border-2 uppercase ${
                  selectedDistance ? 'opacity-60 border-white/20' : 'active:scale-95 border-white/10'
                }`}>
                <div className="text-base tracking-wider">{d.label}</div>
                <div className="text-[11px] opacity-60 mt-0.5">{d.pts} · {d.pct}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex justify-center">
            {locked&&!shotResult&&(
              <div className="flex items-center gap-3 bg-black/70 px-6 py-3 rounded-xl">
                <div className="w-4 h-4 border-2 border-[#63e6be]/40 border-t-transparent rounded-full animate-spin" />
                <p className="text-white/30 text-sm uppercase tracking-wider">Ожидание...</p>
              </div>
            )}
            {selectedDistance && !locked && (
              <p className="text-[#63e6be]/80 text-sm uppercase tracking-wider bg-black/60 px-5 py-3 rounded-xl">
                Выбор: {selectedDistance === 'close' ? 'Ближняя' : selectedDistance === 'mid' ? 'Средняя' : 'Дальняя'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default GamePage;
