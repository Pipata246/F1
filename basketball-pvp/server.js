import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const CENTRAL_API_URL = process.env.CENTRAL_API_URL || '';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

app.use('/basketball-pvp', express.static(path.join(__dirname, 'public')));
app.use('/basketball-pvp', express.static(path.join(__dirname, 'assets')));
app.use(express.json());

// ============ CONFIG ============
const DISTANCES = {
  close: { points: 1, baseChance: 0.85, variance: 0.10 },
  mid:   { points: 2, baseChance: 0.50, variance: 0.10 },
  far:   { points: 3, baseChance: 0.35, variance: 0.10 },
};
const WARMUP_ROUNDS = 5;
const MAIN_ROUNDS = 5;
const TURN_TIMEOUT = 15000;
const MAX_GAME_TIME = 300000; // 5 minutes max per match
const STUCK_CHECK_INTERVAL = 30000; // Check every 30s

// ============ STATE ============
const stats = {};
let waitingPlayer = null;
let roomIdCounter = 0;
const rooms = new Map();

async function reportMatchToCentral(payload) {
  if (!CENTRAL_API_URL || !INTERNAL_API_KEY || typeof fetch !== 'function') return;
  try {
    await fetch(`${CENTRAL_API_URL.replace(/\/+$/, '')}/api/user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        action: 'recordMatchInternal',
        ...payload,
      }),
    });
  } catch (e) {}
}

// ============ HELPERS ============
function sendTo(ws, msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { room.players.forEach(p => sendTo(p.ws, msg)); }
function sendToIdx(room, i, msg) { sendTo(room.players[i]?.ws, msg); }

function resolveShot(distance) {
  const d = DISTANCES[distance];
  const chance = d.baseChance + (Math.random() * 2 - 1) * d.variance;
  const made = Math.random() < chance;
  return { made, points: made ? d.points : 0 };
}

function botChooseDistance(myScore, oppScore) {
  const diff = myScore - oppScore;
  let w;
  if (diff >= 4)      w = { close: 55, mid: 35, far: 10 };
  else if (diff >= 2) w = { close: 35, mid: 45, far: 20 };
  else if (diff > 0)  w = { close: 25, mid: 45, far: 30 };
  else if (diff === 0) w = { close: 15, mid: 45, far: 40 };
  else if (diff >= -2) w = { close: 10, mid: 35, far: 55 };
  else                 w = { close: 5, mid: 25, far: 70 };
  const total = w.close + w.mid + w.far;
  const r = Math.random() * total;
  if (r < w.close) return 'close';
  if (r < w.close + w.mid) return 'mid';
  return 'far';
}

function addTimer(room, fn, ms) { const t = setTimeout(fn, ms); room.timers.push(t); return t; }
function clearTimers(room) { room.timers.forEach(t => clearTimeout(t)); room.timers = []; }
function findRoomByWs(ws) { for (const r of rooms.values()) if (r.players.some(p => p.ws === ws)) return r; return null; }

// ============ ROOM ============
function createRoom(p0, p1) {
  const room = {
    id: ++roomIdCounter, players: [p0, p1], scores: [0, 0],
    phase: 0, round: 0, choices: [null, null],
    timers: [], turnTimer: null, finished: false,
    startTime: Date.now(), stuckTimer: null,
  };
  rooms.set(room.id, room);
  p0.roomId = room.id; p1.roomId = room.id;

  room.stuckTimer = setTimeout(() => {
    if (room.finished) return;
    console.log(`[Room ${room.id}] Force ending stuck game`);
    room.forfeitWinner = room.scores[0] > room.scores[1] ? 0 : 1;
    endMatch(room, true);
  }, MAX_GAME_TIME);

  return room;
}

function cleanupRoom(room) { clearTimers(room); if (room.turnTimer) clearTimeout(room.turnTimer); rooms.delete(room.id); }

// ============ GAME FLOW ============
function startGame(room) {
  room.players.forEach((p, i) => sendTo(p.ws, { type: 'game_found', opponent: room.players[1 - i].name, playerIndex: i }));
  addTimer(room, () => startPhase(room, 1), 1500);
}

function startPhase(room, phase) {
  if (room.finished) return;
  room.phase = phase;
  room.round = 0;
  broadcast(room, { type: 'phase_start', phase, scores: [...room.scores] });
  if (phase === 1) {
    addTimer(room, () => autoWarmupRound(room), 2500);
  } else {
    addTimer(room, () => startRound(room), 2500);
  }
}

// --- Warmup: auto simultaneous, 1pt per hit ---
function autoWarmupRound(room) {
  if (room.finished) return;
  room.round++;

  const shots = [0, 1].map(i => {
    const { made } = resolveShot('mid');
    const pts = made ? 1 : 0;
    room.scores[i] += pts;
    return { playerIndex: i, distance: 'mid', made, points: pts };
  });

  broadcast(room, { type: 'round_result', shots, scores: [...room.scores], round: room.round, phase: 1 });

  if (room.round >= WARMUP_ROUNDS) {
    addTimer(room, () => startPhase(room, 2), 7500);
  } else {
    addTimer(room, () => autoWarmupRound(room), 7000);
  }
}

// --- Main / Overtime: simultaneous choice ---
function startRound(room) {
  if (room.finished) return;
  room.round++;
  room.choices = [null, null];

  const maxRounds = room.phase === 2 ? MAIN_ROUNDS : 999;
  broadcast(room, { type: 'round_start', round: room.round, maxRounds, phase: room.phase, scores: [...room.scores] });

  // Bot auto-chooses
  room.players.forEach((p, i) => {
    if (p.isBot) {
      const d = botChooseDistance(room.scores[i], room.scores[1 - i]);
      addTimer(room, () => handleChoice(room, i, d), 1500 + Math.random() * 1500);
    }
  });

  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    [0, 1].forEach(i => { if (room.choices[i] === null) handleChoice(room, i, 'mid'); });
  }, TURN_TIMEOUT);
}

function handleChoice(room, idx, distance) {
  if (room.finished || room.choices[idx] !== null) return;
  room.choices[idx] = distance;
  sendToIdx(room, idx, { type: 'choice_locked' });
  sendToIdx(room, 1 - idx, { type: 'opponent_locked' });

  if (room.choices[0] !== null && room.choices[1] !== null) {
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    addTimer(room, () => resolveRound(room), 300);
  }
}

function resolveRound(room) {
  if (room.finished) return;

  const shots = [0, 1].map(i => {
    const distance = room.choices[i];
    const { made, points } = resolveShot(distance);
    room.scores[i] += points;
    return { playerIndex: i, distance, made, points };
  });

  broadcast(room, { type: 'round_result', shots, scores: [...room.scores], round: room.round, phase: room.phase });

  const maxRounds = room.phase === 2 ? MAIN_ROUNDS : 999;

  if (room.phase === 2 && room.round >= maxRounds) {
    if (room.scores[0] !== room.scores[1]) {
      addTimer(room, () => endMatch(room), 9000);
    } else {
      addTimer(room, () => startPhase(room, 3), 3500);
    }
  } else if (room.phase === 3) {
    if (room.scores[0] !== room.scores[1]) {
      addTimer(room, () => endMatch(room), 9000);
    } else {
      addTimer(room, () => startRound(room), 9000);
    }
  } else {
    addTimer(room, () => startRound(room), 9000);
  }
}

function endMatch(room, forceForfeit = false) {
  if (room.finished) return;
  room.finished = true;
  if (room.stuckTimer) { clearTimeout(room.stuckTimer); room.stuckTimer = null; }
  const winner = room.forfeitWinner !== undefined ? room.forfeitWinner : (room.scores[0] > room.scores[1] ? 0 : 1);
  const playersPayload = room.players.map((p, i) => ({
    tgUserId: p.tgUserId || null,
    name: p.name || 'Player',
    score: room.scores[i],
    isWinner: i === winner,
    isBot: !!p.isBot,
  }));
  room.players.forEach((p, i) => {
    const youWon = i === winner;
    if (forceForfeit) {
      sendTo(p.ws, { type: 'match_result', youWon, scores: [...room.scores], timeout: true });
    } else {
      sendTo(p.ws, { type: 'match_result', youWon, scores: [...room.scores] });
    }
    if (p.tgUserId && !p.isBot) {
      if (!stats[p.tgUserId]) stats[p.tgUserId] = { wins: 0, losses: 0, totalPoints: 0, gamesPlayed: 0 };
      const s = stats[p.tgUserId]; s.gamesPlayed++; s.totalPoints += room.scores[i];
      if (youWon) s.wins++; else s.losses++;
    }
  });
  const mode = room.players.some((p) => p.isBot) ? 'bot' : 'pvp';
  reportMatchToCentral({
    gameKey: 'basketball',
    serverMatchId: String(room.id),
    mode: mode,
    winnerTgUserId: playersPayload[winner]?.tgUserId || null,
    players: playersPayload,
    score: { left: room.scores[0], right: room.scores[1] },
    details: {
      phase: room.phase,
      roundsPlayed: room.round,
      forceForfeit: forceForfeit,
    },
  });
  cleanupRoom(room);
}

// ============ API ============
app.get('/api/stats/:userId', (req, res) => {
  res.json(stats[req.params.userId] || { wins: 0, losses: 0, totalPoints: 0, gamesPlayed: 0 });
});
app.get('*', (req, res) => { if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ============ WS ============
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'find_game': {
        const p = { ws, name: msg.name || 'Player', tgUserId: msg.tgUserId, isBot: false };
        if (waitingPlayer && waitingPlayer.ws !== ws && waitingPlayer.ws.readyState === 1) {
          const room = createRoom(waitingPlayer, p); waitingPlayer = null; startGame(room);
        } else { waitingPlayer = p; sendTo(ws, { type: 'waiting' }); }
        break;
      }
      case 'find_bot': {
        const p = { ws, name: msg.name || 'Player', tgUserId: msg.tgUserId, isBot: false };
        const bot = { ws: { readyState: 1, send: () => {} }, name: 'BOT', isBot: true, tgUserId: null };
        startGame(createRoom(p, bot));
        break;
      }
      case 'cancel_wait': { if (waitingPlayer?.ws === ws) waitingPlayer = null; break; }
      case 'choose_distance': {
        const room = findRoomByWs(ws); if (!room) return;
        const idx = room.players.findIndex(p => p.ws === ws); if (idx === -1) return;
        handleChoice(room, idx, msg.distance);
        break;
      }
    }
  });
  ws.on('close', () => {
    if (waitingPlayer?.ws === ws) waitingPlayer = null;
    const room = findRoomByWs(ws);
    if (room && !room.finished) {
      room.finished = true;
      if (room.stuckTimer) { clearTimeout(room.stuckTimer); room.stuckTimer = null; }
      const otherIdx = room.players.findIndex(p => p.ws === ws);
      const other = room.players.findIndex(p => p.ws !== ws);
      if (other !== -1) {
        sendToIdx(room, other, { type: 'opponent_left' });
        const winnerIdx = other;
        room.forfeitWinner = winnerIdx;
        endMatch(room, true);
      } else {
        cleanupRoom(room);
      }
    }
  });
});

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => console.log(`Basketball PVP on port ${PORT}`));
