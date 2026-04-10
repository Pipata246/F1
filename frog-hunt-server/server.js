const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// CORS for F1 Duel to fetch stats
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const stats = new Map(); // tgUserId -> { wins, losses, games }

function getStats(userId) {
  if (!stats.has(userId)) stats.set(userId, { wins: 0, losses: 0, games: 0 });
  return stats.get(userId);
}

function recordResult(userId, won) {
  if (!userId) return;
  const s = getStats(userId);
  s.games++;
  if (won) s.wins++; else s.losses++;
}

// Stats API
app.get('/api/stats/:userId', (req, res) => {
  res.json(getStats(req.params.userId));
});

const rooms = new Map();
let waitingPlayer = null;

function genId() { return Math.random().toString(36).substring(2, 10); }

function send(ws, msg) {
  if (ws && !ws.isBot && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  ws.id = genId();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      console.log(`[${ws.id}] recv: ${msg.type}`);
      onMessage(ws, msg);
    } catch (e) { console.error('msg error:', e); }
  });

  ws.on('close', () => {
    if (waitingPlayer === ws) waitingPlayer = null;
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        const opp = room.players[1 - ws.playerIndex];
        if (opp && !opp.isBot) send(opp, { type: 'opponent_left' });
        clearTimeout(room.turnTimer);
        rooms.delete(ws.roomId);
      }
    }
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function onMessage(ws, msg) {
  switch (msg.type) {
    case 'find_game': ws.tgUserId = msg.tgUserId || null; findGame(ws, msg.name, false); break;
    case 'find_bot':  ws.tgUserId = msg.tgUserId || null; findGame(ws, msg.name, true);  break;
    case 'cancel_wait': if (waitingPlayer === ws) waitingPlayer = null; break;
    case 'frog_hide':   handleFrogHide(ws, msg.cell); break;
    case 'hunter_shoot': handleHunterShoot(ws, msg); break;
  }
}

function findGame(ws, name, vsBot) {
  ws.playerName = name || 'Игрок';
  if (vsBot) { createBotGame(ws); return; }
  if (waitingPlayer && waitingPlayer !== ws && waitingPlayer.readyState === 1) {
    createRoom(waitingPlayer, ws);
    waitingPlayer = null;
  } else {
    waitingPlayer = ws;
    send(ws, { type: 'waiting' });
  }
}

function makeRoom(p1, p2) {
  return {
    id: genId(),
    players: [p1, p2],
    names: [p1.playerName, p2.playerName],
    roles: [null, null],
    gameNum: 1,
    round: 1,
    totalRounds: 5,
    totalCells: 8,
    hunterShots: 1,       // how many cells hunter can pick (1 normal, 2 overtime)
    frogCell: null,
    previousFrogCell: null,
    frogMoved: null,
    phase: 'idle',
    matchScores: [0, 0],
    turnTimer: null
  };
}

function createRoom(p1, p2) {
  const room = makeRoom(p1, p2);
  rooms.set(room.id, room);
  p1.roomId = room.id; p1.playerIndex = 0;
  p2.roomId = room.id; p2.playerIndex = 1;
  send(p1, { type: 'game_found', opponent: p2.playerName, playerIndex: 0 });
  send(p2, { type: 'game_found', opponent: p1.playerName, playerIndex: 1 });
  startGame(room);
}

function createBotGame(ws) {
  const bot = { isBot: true, playerName: 'Бот 🤖', playerIndex: 1, readyState: 1 };
  const room = makeRoom(ws, bot);
  rooms.set(room.id, room);
  ws.roomId = room.id; ws.playerIndex = 0;
  bot.roomId = room.id;
  send(ws, { type: 'game_found', opponent: 'Бот 🤖', playerIndex: 0 });
  startGame(room);
}

function startGame(room) {
  // Assign roles
  if (room.gameNum === 2) {
    // Swap roles from game 1
    room.roles = [room.roles[0] === 'frog' ? 'hunter' : 'frog',
                  room.roles[1] === 'frog' ? 'hunter' : 'frog'];
  } else {
    // Game 1 or tiebreak — random
    const frogIdx = Math.random() < 0.5 ? 0 : 1;
    room.roles[frogIdx] = 'frog';
    room.roles[1 - frogIdx] = 'hunter';
  }

  room.round = 1;
  room.frogCell = null;
  room.previousFrogCell = null;
  room.frogMoved = null;

  // Tiebreak settings (game 3)
  if (room.gameNum === 3) {
    room.totalCells = 4;
    room.totalRounds = 1;
    room.hunterShots = 2;
  } else {
    room.totalCells = 8;
    room.totalRounds = 5;
    room.hunterShots = 1;
  }

  room.phase = 'role_reveal';

  room.players.forEach((p, i) => {
    send(p, {
      type: 'role_assign',
      role: room.roles[i],
      gameNum: room.gameNum,
      totalRounds: room.totalRounds,
      totalCells: room.totalCells,
      hunterShots: room.hunterShots,
      matchScores: [...room.matchScores]
    });
  });

  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    startFrogTurn(room);
  }, 3000);
}

function startFrogTurn(room) {
  room.phase = 'frog_turn';
  clearTimeout(room.turnTimer);

  const frogIdx = room.roles.indexOf('frog');
  const hunterIdx = 1 - frogIdx;
  const isFinal = room.round === room.totalRounds;

  send(room.players[frogIdx], {
    type: 'frog_turn',
    round: room.round,
    totalRounds: room.totalRounds,
    currentCell: room.frogCell,
    totalCells: room.totalCells,
    isFinal: isFinal
  });

  send(room.players[hunterIdx], {
    type: 'wait_for_frog',
    round: room.round,
    totalRounds: room.totalRounds,
    isFinal: isFinal
  });

  // Bot as frog
  const frogPlayer = room.players[frogIdx];
  if (frogPlayer.isBot) {
    setTimeout(() => {
      if (room.phase !== 'frog_turn') return;
      botFrogMove(room);
    }, 1000 + Math.random() * 2000);
  }

  // Timer 15s
  room.turnTimer = setTimeout(() => {
    if (room.phase !== 'frog_turn') return;
    // Auto random
    const cell = Math.floor(Math.random() * room.totalCells);
    doFrogHide(room, cell);
  }, 15000);
}

function botFrogMove(room) {
  let cell;
  if (room.frogCell === null) {
    cell = Math.floor(Math.random() * room.totalCells);
  } else if (Math.random() < 0.3) {
    cell = room.frogCell; // stay
  } else {
    do { cell = Math.floor(Math.random() * room.totalCells); }
    while (cell === room.frogCell);
  }
  doFrogHide(room, cell);
}

function handleFrogHide(ws, cell) {
  const room = rooms.get(ws.roomId);
  if (!room || room.phase !== 'frog_turn') return;
  if (ws.playerIndex !== room.roles.indexOf('frog')) return;
  if (cell < 0 || cell >= room.totalCells) return;
  doFrogHide(room, cell);
}

function doFrogHide(room, cell) {
  clearTimeout(room.turnTimer);
  room.previousFrogCell = room.frogCell;
  room.frogMoved = (room.previousFrogCell !== null && room.previousFrogCell !== cell);
  room.frogCell = cell;
  room.phase = 'hunter_turn';

  const frogIdx = room.roles.indexOf('frog');
  const hunterIdx = 1 - frogIdx;
  const isFinal = room.round === room.totalRounds;

  send(room.players[frogIdx], {
    type: 'frog_hidden',
    cell: cell
  });

  send(room.players[hunterIdx], {
    type: 'hunter_turn',
    round: room.round,
    totalRounds: room.totalRounds,
    totalCells: room.totalCells,
    hunterShots: room.hunterShots,
    isFinal: isFinal
  });

  // Bot as hunter
  const hunterPlayer = room.players[hunterIdx];
  if (hunterPlayer.isBot) {
    setTimeout(() => {
      if (room.phase !== 'hunter_turn') return;
      botHunterMove(room);
    }, 1500 + Math.random() * 2000);
  }

  // Timer 15s
  room.turnTimer = setTimeout(() => {
    if (room.phase !== 'hunter_turn') return;
    // Auto random shots
    const cells = pickRandomCells(room.totalCells, room.hunterShots, -1);
    doHunterShoot(room, cells);
  }, 15000);
}

function botHunterMove(room) {
  const cells = pickRandomCells(room.totalCells, room.hunterShots, -1);
  doHunterShoot(room, cells);
}

function pickRandomCells(totalCells, count, avoidCell) {
  const available = [];
  for (let i = 0; i < totalCells; i++) {
    if (i !== avoidCell) available.push(i);
  }
  // Shuffle and pick
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }
  return available.slice(0, count);
}

function handleHunterShoot(ws, msg) {
  const room = rooms.get(ws.roomId);
  if (!room || room.phase !== 'hunter_turn') return;
  if (ws.playerIndex !== room.roles.indexOf('hunter')) return;

  // Accept both formats: { cell: N } or { cells: [N, M] }
  let cells;
  if (Array.isArray(msg.cells)) {
    cells = msg.cells;
  } else if (typeof msg.cell === 'number') {
    cells = [msg.cell];
  } else return;

  // Validate
  if (cells.length !== room.hunterShots) return;
  const unique = new Set(cells);
  if (unique.size !== cells.length) return; // no duplicates
  for (const c of cells) {
    if (c < 0 || c >= room.totalCells) return;
  }

  doHunterShoot(room, cells);
}

function doHunterShoot(room, cells) {
  clearTimeout(room.turnTimer);
  const hit = cells.includes(room.frogCell);
  console.log(`[room ${room.id}] hunter shoots ${cells} at frog ${room.frogCell} => ${hit ? 'HIT' : 'MISS'}`);
  room.phase = 'round_result';

  room.players.forEach((p) => {
    send(p, {
      type: 'round_result',
      hit: hit,
      frogCell: room.frogCell,
      hunterCells: cells,
      round: room.round,
      totalRounds: room.totalRounds,
      frogMoved: room.frogMoved,
      previousCell: room.previousFrogCell,
      isFinal: room.round === room.totalRounds
    });
  });

  setTimeout(() => {
    if (!rooms.has(room.id)) return;

    if (hit) {
      endCurrentGame(room, 'hunter');
    } else if (room.round >= room.totalRounds) {
      endCurrentGame(room, 'frog');
    } else {
      room.round++;
      startFrogTurn(room);
    }
  }, 3000);
}

function endCurrentGame(room, winnerRole) {
  room.phase = 'game_over';
  const winnerIdx = room.roles.indexOf(winnerRole);
  room.matchScores[winnerIdx]++;

  room.players.forEach((p, i) => {
    send(p, {
      type: 'game_over',
      winner: winnerRole,
      youWon: (i === winnerIdx),
      gameNum: room.gameNum,
      matchScores: [...room.matchScores],
      yourRole: room.roles[i]
    });
  });

  setTimeout(() => {
    if (!rooms.has(room.id)) return;

    if (room.gameNum === 1) {
      room.players.forEach((p) => send(p, { type: 'switch_roles' }));
      setTimeout(() => {
        if (!rooms.has(room.id)) return;
        room.gameNum = 2;
        startGame(room);
      }, 3000);
    } else if (room.gameNum === 2) {
      if (room.matchScores[0] === room.matchScores[1]) {
        room.players.forEach((p) => send(p, { type: 'tiebreak_start' }));
        setTimeout(() => {
          if (!rooms.has(room.id)) return;
          room.gameNum = 3;
          startGame(room);
        }, 3000);
      } else {
        endMatch(room);
      }
    } else {
      endMatch(room);
    }
  }, 3000);
}

function endMatch(room) {
  room.phase = 'match_over';
  room.players.forEach((p, i) => {
    const won = room.matchScores[i] > room.matchScores[1 - i];
    send(p, {
      type: 'match_result',
      youWon: won,
      matchScores: [...room.matchScores],
      playerIndex: i
    });
    // Record stats
    if (p.tgUserId) recordResult(p.tgUserId, won);
  });
  setTimeout(() => rooms.delete(room.id), 10000);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Frog Hunt PvP: http://localhost:${PORT}`);
});
