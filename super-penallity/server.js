import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const CENTRAL_API_URL = process.env.CENTRAL_API_URL || '';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

const PORT = process.env.PORT || 3001;

// --- Stats storage (in-memory, resets on restart) ---
const stats = new Map(); // tgUserId -> { wins, losses, goals, saves }

function getStats(userId) {
  if (!stats.has(userId)) {
    stats.set(userId, { wins: 0, losses: 0, goals: 0, saves: 0 });
  }
  return stats.get(userId);
}

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

// --- API ---
app.use(express.json());

app.get('/api/stats/:userId', (req, res) => {
  const s = getStats(req.params.userId);
  res.json(s);
});

// --- Serve static in production ---
app.use('/super-penallity', express.static(join(__dirname, 'public')));
app.use('/super-penallity', express.static(join(__dirname, 'assets')));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) res.sendFile(join(__dirname, 'public', 'index.html'));
});

// --- Game logic ---
const rooms = new Map();
let waitingPlayer = null;
let roomIdCounter = 1;

const ZONES = [0, 1, 2, 3];
const ROUND_TIMEOUT = 10000; // 10 seconds
const BOT_DELAY_MIN = 800;
const BOT_DELAY_MAX = 2000;
const MAX_GAME_TIME = 300000; // 5 minutes max per match

function send(ws, type, data = {}) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function createRoom(p1, p2) {
  const roomId = roomIdCounter++;
  const room = {
    id: roomId,
    players: [p1, p2],
    scores: [0, 0],
    round: 0,
    maxRounds: 10, // 5 kicks per player (alternating)
    suddenDeath: false,
    choices: [null, null],
    timer: null,
    finished: false,
    history: [], // [{kickerIndex, kickerZone, keeperZone, isGoal}]
    kickerOverride: null,
    sdStart: 0, // round when sudden death started
    startTime: Date.now(),
    stuckTimer: null
  };
  rooms.set(roomId, room);
  p1.roomId = roomId;
  p2.roomId = roomId;
  p1.playerIndex = 0;
  p2.playerIndex = 1;

  room.stuckTimer = setTimeout(() => {
    if (room.finished) return;
    console.log(`[Room ${room.id}] Force ending stuck game`);
    room.forfeitWinner = room.scores[0] > room.scores[1] ? 0 : 1;
    endMatch(room, true);
  }, MAX_GAME_TIME);

  send(p1.ws, 'game_found', { opponent: p2.name, playerIndex: 0 });
  send(p2.ws, 'game_found', { opponent: p1.name, playerIndex: 1 });

  setTimeout(() => startRound(room), 500);
  return room;
}

function getKickerIndex(room) {
  if (room.suddenDeath && room.kickerOverride !== null) {
    return room.kickerOverride;
  }
  // Rounds 0,2,4,6,8 -> player 0 kicks; rounds 1,3,5,7,9 -> player 1 kicks
  return room.round % 2 === 0 ? 0 : 1;
}

function startRound(room) {
  if (room.finished) return;

  room.choices = [null, null];

  // In sudden death: strict alternation in pairs
  if (room.suddenDeath) {
    const sdRound = room.round - room.sdStart;
    const pairNum = Math.floor(sdRound / 2);
    const withinPair = sdRound % 2;
    room.kickerOverride = (pairNum + withinPair) % 2;
  }

  const kickerIdx = getKickerIndex(room);

  for (const p of room.players) {
    if (!p.isBot) {
      const role = p.playerIndex === kickerIdx ? 'kicker' : 'keeper';
      send(p.ws, 'round_start', {
        round: room.round + 1,
        maxRounds: room.maxRounds,
        role,
        scores: room.scores,
        suddenDeath: room.suddenDeath,
        history: room.history,
      });
    }
  }

  // Bot auto-choose
  for (const p of room.players) {
    if (p.isBot) {
      const role = p.playerIndex === kickerIdx ? 'kicker' : 'keeper';
      const delay = BOT_DELAY_MIN + Math.random() * (BOT_DELAY_MAX - BOT_DELAY_MIN);
      setTimeout(() => {
        if (room.finished) return;
        const zone = botChooseZone(role);
        handleChoice(room, p.playerIndex, zone);
      }, delay);
    }
  }

  // Round timeout — auto-choose for players who haven't chosen
  room.timer = setTimeout(() => {
    for (let i = 0; i < 2; i++) {
      if (room.choices[i] === null && !room.players[i].isBot) {
        const zone = ZONES[Math.floor(Math.random() * ZONES.length)];
        handleChoice(room, i, zone);
      }
    }
  }, ROUND_TIMEOUT);
}

function botChooseZone(role) {
  if (role === 'kicker') {
    // 30/30/20/20 distribution
    const r = Math.random();
    if (r < 0.3) return 0;
    if (r < 0.6) return 1;
    if (r < 0.8) return 2;
    return 3;
  }
  // Keeper: uniform random
  return ZONES[Math.floor(Math.random() * ZONES.length)];
}

function handleChoice(room, playerIndex, zone) {
  if (room.finished) return;
  if (room.choices[playerIndex] !== null) return; // already chose

  room.choices[playerIndex] = zone;

  // Notify the player their choice is locked
  const p = room.players[playerIndex];
  if (!p.isBot) {
    send(p.ws, 'zone_locked', { zone });
  }

  // Check if both have chosen
  if (room.choices[0] !== null && room.choices[1] !== null) {
    clearTimeout(room.timer);
    resolveRound(room);
  }
}

function resolveRound(room) {
  const kickerIdx = getKickerIndex(room);
  const keeperIdx = 1 - kickerIdx;
  const kickerZone = room.choices[kickerIdx];
  const keeperZone = room.choices[keeperIdx];
  const isGoal = kickerZone !== keeperZone;

  if (isGoal) {
    room.scores[kickerIdx]++;
  }

  room.history.push({ kickerIndex: kickerIdx, kickerZone, keeperZone, isGoal });
  room.round++;

  // Check if sudden death is starting NOW (before sending result)
  const wasRegularGame = !room.suddenDeath;
  const roundsPlayed = room.round;
  const maxRounds = room.maxRounds;
  const [s0, s1] = room.scores;
  const startingSuddenDeath = wasRegularGame && roundsPlayed >= maxRounds && s0 === s1;

  // Send result to both players
  for (const p of room.players) {
    if (!p.isBot) {
      send(p.ws, 'round_result', {
        kickerZone,
        keeperZone,
        isGoal,
        scores: room.scores,
        round: room.round,
        kickerIndex: kickerIdx,
        history: room.history,
        startSuddenDeath: startingSuddenDeath, // NEW: notify clients overtime is starting
      });
    }
  }

  // Check if match should end
  if (shouldEndMatch(room)) {
    setTimeout(() => endMatch(room), 2500);
  } else {
    setTimeout(() => startRound(room), 2800);
  }
}

function shouldEndMatch(room) {
  const [s0, s1] = room.scores;
  const roundsPlayed = room.round;

  // OVERTIME: End immediately when scores differ (first goal wins)
  if (room.suddenDeath) {
    // After each overtime round, check if someone scored
    const sdRounds = roundsPlayed - room.sdStart;
    // End after each complete pair (both players kicked once)
    if (sdRounds >= 2 && sdRounds % 2 === 0) {
      // If scores differ, someone won
      if (s0 !== s1) return true;
      // If still tied, continue overtime (another pair)
      return false;
    }
    // Wait for both players to kick before checking
    return false;
  }

  const maxRounds = room.maxRounds;

  // All rounds played
  if (roundsPlayed >= maxRounds) {
    if (s0 === s1) {
      // Start overtime
      room.suddenDeath = true;
      room.sdStart = roundsPlayed;
      return false;
    }
    return true;
  }

  // Early win: only check after both have kicked equal times (even round count)
  if (roundsPlayed % 2 !== 0) return false;

  let p0KicksLeft = 0;
  let p1KicksLeft = 0;
  for (let r = roundsPlayed; r < maxRounds; r++) {
    if (r % 2 === 0) p0KicksLeft++;
    else p1KicksLeft++;
  }

  if (s0 > s1 + p1KicksLeft) return true;
  if (s1 > s0 + p0KicksLeft) return true;

  return false;
}

function endMatch(room, forceForfeit = false) {
  if (room.finished) return;
  room.finished = true;
  if (room.timer) clearTimeout(room.timer);
  if (room.stuckTimer) { clearTimeout(room.stuckTimer); room.stuckTimer = null; }

  const [s0, s1] = room.scores;
  const winnerIdx = room.forfeitWinner !== undefined ? room.forfeitWinner : (s0 > s1 ? 0 : 1);
  const playersPayload = room.players.map((p, i) => ({
    tgUserId: p.tgUserId || null,
    name: p.name || 'Player',
    score: room.scores[i],
    isWinner: i === winnerIdx,
    isBot: !!p.isBot,
  }));

  for (const p of room.players) {
    const won = p.playerIndex === winnerIdx;

    if (!p.isBot) {
      send(p.ws, 'match_result', { youWon: won, scores: room.scores, timeout: forceForfeit || undefined });
    }

    if (p.tgUserId && !p.isBot) {
      const st = getStats(p.tgUserId);
      if (won) st.wins++;
      else st.losses++;

      st.goals += room.scores[p.playerIndex];
      const oppIdx = 1 - p.playerIndex;
      let myKicks = 0;
      let oppKicks = 0;
      for (let r = 0; r < room.round; r++) {
        if (r % 2 === 0) {
          if (p.playerIndex === 0) myKicks++;
          else oppKicks++;
        } else {
          if (p.playerIndex === 1) myKicks++;
          else oppKicks++;
        }
      }
      st.saves += oppKicks - room.scores[oppIdx];
    }
  }

  reportMatchToCentral({
    gameKey: 'super_penalty',
    serverMatchId: String(room.id),
    mode: room.players.some((p) => p.isBot) ? 'bot' : 'pvp',
    winnerTgUserId: playersPayload[winnerIdx]?.tgUserId || null,
    players: playersPayload,
    score: { left: s0, right: s1 },
    details: {
      roundsPlayed: room.round,
      suddenDeath: room.suddenDeath,
      historySize: room.history.length,
      forceForfeit: forceForfeit,
    },
  });

  rooms.delete(room.id);
}

function cleanupPlayer(player) {
  if (player.roomId) {
    const room = rooms.get(player.roomId);
    if (room && !room.finished) {
      room.finished = true;
      if (room.timer) clearTimeout(room.timer);
      if (room.stuckTimer) { clearTimeout(room.stuckTimer); room.stuckTimer = null; }
      const opponent = room.players.find(p => p !== player);
      if (opponent) {
        if (!opponent.isBot) {
          send(opponent.ws, 'opponent_left');
        }
        room.forfeitWinner = opponent.playerIndex;
      }
      endMatch(room, true);
    }
  }
  if (waitingPlayer === player) {
    waitingPlayer = null;
  }
}

// --- WebSocket ---
wss.on('connection', (ws) => {
  const player = { ws, name: 'Player', tgUserId: null, roomId: null, playerIndex: -1, isBot: false };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'find_game': {
        player.name = msg.name || 'Player';
        player.tgUserId = msg.tgUserId || null;

        if (waitingPlayer && waitingPlayer.ws.readyState === 1) {
          const opponent = waitingPlayer;
          waitingPlayer = null;
          createRoom(opponent, player);
        } else {
          waitingPlayer = player;
          send(ws, 'waiting');
        }
        break;
      }

      case 'find_bot': {
        player.name = msg.name || 'Player';
        player.tgUserId = msg.tgUserId || null;

        const bot = {
          ws: { readyState: 1, send: () => {} },
          name: 'Bot 🤖',
          tgUserId: null,
          roomId: null,
          playerIndex: -1,
          isBot: true,
        };

        // Randomly decide who kicks first
        if (Math.random() < 0.5) {
          createRoom(player, bot);
        } else {
          createRoom(bot, player);
        }
        break;
      }

      case 'cancel_wait': {
        if (waitingPlayer === player) {
          waitingPlayer = null;
        }
        break;
      }

      case 'choose_zone': {
        if (player.roomId === null) return;
        const room = rooms.get(player.roomId);
        if (!room || room.finished) return;
        const zone = parseInt(msg.zone);
        if (!ZONES.includes(zone)) return;
        handleChoice(room, player.playerIndex, zone);
        break;
      }
    }
  });

  ws.on('close', () => cleanupPlayer(player));
  ws.on('error', () => cleanupPlayer(player));

  // Heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat interval
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// --- Start ---
server.listen(PORT, () => {
  console.log(`SuperPenallity server running on port ${PORT}`);
});
