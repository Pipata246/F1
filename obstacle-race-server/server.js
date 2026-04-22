const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const path = require('path');

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbww0p-WvGYecfdg_OHafg4ysvb5T1YE2cMbpnoStz-CkLJRccYjAg1-x8r8bd0jL17H/exec';

function postToSheets(data) {
  const payload = JSON.stringify(data);

  function doPost(urlStr, depth) {
    if (depth > 5) return;
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(payload) }
    };
    console.log('[Sheets] POST', u.hostname, 'depth=' + depth);
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        console.log('[Sheets] Status:', res.statusCode);
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          console.log('[Sheets] Redirect:', res.headers.location?.substring(0, 80));
          doPost(res.headers.location, depth + 1);
        } else {
          console.log('[Sheets] Done:', body.substring(0, 100));
        }
      });
    });
    req.on('error', (e) => console.log('[Sheets] Error:', e.message));
    req.write(payload);
    req.end();
  }

  doPost(SHEETS_URL, 0);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const CENTRAL_API_URL = process.env.CENTRAL_API_URL || '';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

async function reportMatchToCentral(payload) {
  if (!CENTRAL_API_URL || !INTERNAL_API_KEY || typeof fetch !== 'function') return;
  try {
    await fetch(`${CENTRAL_API_URL.replace(/\/+$/, '')}/api/user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': INTERNAL_API_KEY
      },
      body: JSON.stringify({
        action: 'recordMatchInternal',
        ...payload
      })
    });
  } catch (e) {}
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/test-sheets', (req, res) => {
  postToSheets({
    ability_1: 'xray',
    ability_2: 'double',
    used_1: true,
    used_2: false,
    winner_ability: 'xray',
    rounds: 5
  });
  res.send('Test data sent to Google Sheets. Check your spreadsheet in ~5 seconds.');
});

const rooms = new Map();
let waitingPlayer = null;
const MAIN_ROUNDS = 7;
const WIN_SCORE = 5;
const OT_TRAPS = 1;
const OT_ROUNDS = 3;
const MAX_GAME_TIME = 300000; // 5 minutes max per match

function genId() { return Math.random().toString(36).substring(2, 10); }

function send(ws, msg) {
  if (ws && !ws.isBot && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function randomAbility() {
  // xray 40%, sabotage 40%, double 20%
  const r = Math.random() * 5;
  if (r < 2) return 'xray';
  if (r < 4) return 'sabotage';
  return 'double';
}

function randomTraps() {
  const t = new Set();
  while (t.size < 3) t.add(Math.floor(Math.random() * 7));
  return [...t];
}

// ===== WebSocket =====
wss.on('connection', (ws) => {
  ws.id = genId();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try { onMessage(ws, JSON.parse(raw)); } catch (e) {}
  });

  ws.on('close', () => {
    if (waitingPlayer === ws) waitingPlayer = null;
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room && room.phase !== 'finished' && room.phase !== 'match_over') {
        if (room.moveTimer) clearTimeout(room.moveTimer);
        if (room.stuckTimer) clearTimeout(room.stuckTimer);
        const oppIdx = room.players.findIndex((p, i) => i !== ws.playerIndex);
        if (oppIdx !== -1) {
          const opp = room.players[oppIdx];
          if (!opp.isBot && opp.readyState === 1) {
            send(opp, { type: 'opponent_left' });
            room.forfeitWinner = oppIdx;
          }
        }
        room.phase = 'match_over';
        finishMatchWithResult(room, true);
      }
    }
  });
});

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
    case 'find_bot': ws.tgUserId = msg.tgUserId || null; findGame(ws, msg.name, true); break;
    case 'cancel_wait': if (waitingPlayer === ws) waitingPlayer = null; break;
    case 'place_traps': placeTraps(ws, msg.traps); break;
    case 'make_move': makeMove(ws, msg.action, msg.useAbility); break;
    case 'xray_scan': handleXrayScan(ws, msg.point); break;
  }
}

// ===== Xray Scan =====
function handleXrayScan(ws, point) {
  const room = rooms.get(ws.roomId);
  if (!room || room.phase !== 'running') return;
  if (room.abilityUsed[ws.playerIndex]) return;
  const currentAbility = room.overtime ? room.overtimeAbilities[ws.playerIndex] : room.abilities[ws.playerIndex];
  if (currentAbility !== 'xray') return;

  const playerIdx = ws.playerIndex;
  const oppIdx = 1 - playerIdx;
  let hasTrap;
  if (room.overtime) {
    hasTrap = room.overtimeTraps[oppIdx].includes(point);
  } else {
    hasTrap = room.traps[oppIdx].includes(point);
  }

  room.abilityUsed[playerIdx] = true;
  send(ws, { type: 'xray_result', point, hasTrap });

  const oppWs = room.players[oppIdx];
  if (oppWs) send(oppWs, { type: 'opp_xray', point });
}

// ===== Matchmaking =====
function findGame(ws, name, vsBot) {
  ws.playerName = name || '\u0418\u0433\u0440\u043E\u043A';
  if (vsBot) { createBotGame(ws); return; }
  if (waitingPlayer && waitingPlayer !== ws && waitingPlayer.readyState === 1) {
    createRoom(waitingPlayer, ws);
    waitingPlayer = null;
  } else {
    waitingPlayer = ws;
    send(ws, { type: 'waiting' });
  }
}

function randomOtAbility() {
  // В овертайме только xray и sabotage (без double)
  return Math.random() < 0.5 ? 'xray' : 'sabotage';
}

function makeRoom(p1, p2) {
  return {
    id: genId(),
    players: [p1, p2],
    names: [p1.playerName, p2.playerName],
    traps: [null, null],
    scores: [0, 0],
    currentStep: 0,
    moves: [null, null],
    phase: 'placing',
    abilities: [randomAbility(), randomAbility()],
    abilityUsed: [false, false],
    overtime: false,
    overtimeRound: 0,
    overtimeTraps: null,
    overtimeAbilities: [null, null],
    firstScorer: null,
    botAbilityRound: Math.floor(Math.random() * 7),
    reportSent: false,
    startTime: Date.now(),
    stuckTimer: null,
    trapTimer: null
  };
}

function createRoom(p1, p2) {
  const room = makeRoom(p1, p2);
  rooms.set(room.id, room);
  p1.roomId = room.id; p1.playerIndex = 0;
  p2.roomId = room.id; p2.playerIndex = 1;
  send(p1, { type: 'game_found', opponent: p2.playerName, playerIndex: 0 });
  send(p2, { type: 'game_found', opponent: p1.playerName, playerIndex: 1 });

  room.stuckTimer = setTimeout(() => {
    if (room.phase === 'match_over') return;
    console.log(`[Room ${room.id}] Force ending stuck game`);
    room.forfeitWinner = room.scores[0] > room.scores[1] ? 0 : 1;
    finishMatchWithResult(room, true);
  }, MAX_GAME_TIME);

  // Таймаут на расстановку ловушек — 30 секунд
  room.trapTimer = setTimeout(() => {
    if (room.phase !== 'placing') return;
    for (let i = 0; i < 2; i++) {
      if (!room.traps[i]) {
        room.traps[i] = randomTraps();
        send(room.players[i], { type: 'traps_auto' });
      }
    }
    checkTrapsReady(room);
  }, 30000);
}

function createBotGame(ws) {
  const bot = { isBot: true, playerName: 'Bot', playerIndex: 1, readyState: 1 };
  const room = makeRoom(ws, bot);
  rooms.set(room.id, room);
  ws.roomId = room.id; ws.playerIndex = 0;
  bot.roomId = room.id;
  send(ws, { type: 'game_found', opponent: 'Bot', playerIndex: 0 });

  room.stuckTimer = setTimeout(() => {
    if (room.phase === 'match_over') return;
    console.log(`[Room ${room.id}] Force ending stuck game`);
    room.forfeitWinner = room.scores[0] > room.scores[1] ? 0 : 1;
    finishMatchWithResult(room, true);
  }, MAX_GAME_TIME);

  setTimeout(() => {
    room.traps[1] = randomTraps();
    checkTrapsReady(room);
  }, 800 + Math.random() * 1200);
}

// ===== Traps =====
function placeTraps(ws, traps) {
  const room = rooms.get(ws.roomId);
  if (!room) return;

  if (room.phase === 'placing') {
    if (!Array.isArray(traps) || traps.length !== 3) return;
    room.traps[ws.playerIndex] = traps;
    send(ws, { type: 'traps_placed' });
    checkTrapsReady(room);
  } else if (room.phase === 'overtime_placing') {
    if (!Array.isArray(traps) || traps.length < 1 || traps.length > 2) return;
    // Accept 1 or 2 traps for backward compatibility with old client
    room.overtimeTraps[ws.playerIndex] = traps;
    send(ws, { type: 'traps_placed' });
    checkOvertimeReady(room);
  }
}

function checkTrapsReady(room) {
  if (!room.traps[0] || !room.traps[1]) return;
  if (room.trapTimer) { clearTimeout(room.trapTimer); room.trapTimer = null; }
  room.phase = 'running';
  room.currentStep = 0;
  room.players.forEach((p, i) => {
    send(p, {
      type: 'round_start', step: 0,
      ability: room.abilities[i]
    });
  });
  scheduleBotMove(room);
  scheduleMoveTimeout(room);
}

function checkOvertimeReady(room) {
  if (!room.overtimeTraps[0] || !room.overtimeTraps[1]) return;
  if (room.trapTimer) { clearTimeout(room.trapTimer); room.trapTimer = null; }
  room.phase = 'running';
  room.overtimeRound = 0;
  room.players.forEach((p, i) => {
    send(p, { type: 'overtime_start', ability: room.overtimeAbilities[i] });
  });
  scheduleBotMove(room);
  scheduleMoveTimeout(room);
}

const MOVE_TIMEOUT = 12000;

// Auto-run for players who haven't moved
function scheduleMoveTimeout(room) {
  if (room.moveTimer) clearTimeout(room.moveTimer);
  room.moveTimer = setTimeout(() => {
    if (room.phase !== 'running') return;
    for (let i = 0; i < 2; i++) {
      if (room.moves[i] === null && !room.players[i].isBot) {
        room.moves[i] = { action: 'run', useAbility: false };
      }
    }
    resolveRound(room);
  }, MOVE_TIMEOUT);
}

// ===== Moves =====
function makeMove(ws, action, useAbility) {
  const room = rooms.get(ws.roomId);
  if (!room || room.phase !== 'running') return;
  if (room.moves[ws.playerIndex] !== null) return;
  if (action !== 'run' && action !== 'jump') return;
  room.moves[ws.playerIndex] = { action, useAbility: !!useAbility };
  resolveRound(room);
}

function scheduleBotMove(room) {
  const bot = room.players.find((p) => p.isBot);
  if (!bot) return;
  setTimeout(() => {
    if (room.phase !== 'running') return;
    const step = room.overtime ? room.overtimeRound : room.currentStep;

    // Умный бот: 65% — знает где ловушки игрока
    let action;
    if (Math.random() < 0.65) {
      const playerTraps = room.overtime
        ? (room.overtimeTraps ? room.overtimeTraps[1 - bot.playerIndex] : [])
        : (room.traps ? room.traps[1 - bot.playerIndex] : []);
      const hasTrap = Array.isArray(playerTraps) && playerTraps.includes(step);
      action = hasTrap ? 'jump' : 'run';
    } else {
      action = Math.random() > 0.5 ? 'run' : 'jump';
    }

    room.moves[bot.playerIndex] = { action, useAbility: false };
    resolveRound(room);
  }, 600 + Math.random() * 1500);
}

// ===== Round resolution =====
function resolveRound(room) {
  if (room.moves[0] === null || room.moves[1] === null) return;
  if (room.moveTimer) { clearTimeout(room.moveTimer); room.moveTimer = null; }

  const results = [null, null];

  // Phase 1: base outcomes + double (xray is handled via scan, not here)
  for (let i = 0; i < 2; i++) {
    const oppIdx = 1 - i;
    const move = room.moves[i];
    let action = move.action;
    let usedAbility = null;

    // Determine trap
    let hasTrap;
    if (room.overtime) {
      hasTrap = room.overtimeTraps[oppIdx].includes(room.overtimeRound);
    } else {
      hasTrap = room.traps[oppIdx].includes(room.currentStep);
    }

    // Apply ability (double/sabotage only — xray consumed during scan phase)
    // Double can only be used until round 5 (step 0-4), и никогда в овертайме
    const currentAbility = room.overtime ? room.overtimeAbilities[i] : room.abilities[i];
    if (move.useAbility && !room.abilityUsed[i] && currentAbility) {
      if (room.overtime) {
        // В овертайме: только sabotage (xray — через scan)
        if (currentAbility === 'sabotage') {
          usedAbility = currentAbility;
          room.abilityUsed[i] = true;
        }
      } else {
        const ab = room.abilities[i];
        if (ab === 'double' && room.currentStep > 4) {
          // double blocked after round 5
        } else {
          usedAbility = ab;
          room.abilityUsed[i] = true;
        }
      }
    }

    let success = (action === 'run' && !hasTrap) || (action === 'jump' && hasTrap);
    let reason = '';
    if (action === 'run' && !hasTrap) reason = 'clear_run';
    else if (action === 'run' && hasTrap) reason = 'hit_trap';
    else if (action === 'jump' && hasTrap) reason = 'dodged_trap';
    else if (action === 'jump' && !hasTrap) reason = 'wasted_jump';

    let points = success ? 1 : 0;
    if (usedAbility === 'double') {
      points = success ? 2 : -1;
    }

    results[i] = { action, hasTrap, success, reason, points, usedAbility,
      sabotaged: false, sabotageHit: false, sabotageBackfire: false };
  }

  // Phase 2: sabotage (uses base success before sabotage modifications)
  const baseSuccess = [results[0].success, results[1].success];
  for (let i = 0; i < 2; i++) {
    if (results[i].usedAbility === 'sabotage') {
      const opp = 1 - i;
      if (baseSuccess[opp]) {
        results[opp].sabotaged = true;
        results[opp].points = 0;
        results[i].sabotageHit = true;
      } else {
        results[i].sabotageBackfire = true;
      }
    }
  }

  // Phase 3: apply scores
  for (let i = 0; i < 2; i++) {
    room.scores[i] = room.scores[i] + results[i].points;
    results[i].score = room.scores[i];
    if (results[i].points > 0 && room.firstScorer === null) {
      room.firstScorer = i;
    }
  }

  // Phase 4: advance step
  let stepPlayed;
  if (room.overtime) {
    stepPlayed = room.overtimeRound;
    room.overtimeRound++;
  } else {
    stepPlayed = room.currentStep;
    room.currentStep++;
  }

  // Phase 5: winner check
  let winner = null;
  let startOvertime = false;

  if (room.overtime) {
    // Instant win: first to pull ahead wins immediately
    if (room.scores[0] > room.scores[1]) winner = 0;
    else if (room.scores[1] > room.scores[0]) winner = 1;
    else if (room.overtimeRound >= OT_ROUNDS) startOvertime = true; // tied after all OT rounds — restart
  } else {
    if (room.scores[0] >= WIN_SCORE && room.scores[1] >= WIN_SCORE) {
      if (room.scores[0] > room.scores[1]) winner = 0;
      else if (room.scores[1] > room.scores[0]) winner = 1;
      else startOvertime = true;
    } else if (room.scores[0] >= WIN_SCORE) {
      winner = 0;
    } else if (room.scores[1] >= WIN_SCORE) {
      winner = 1;
    } else if (room.currentStep >= MAIN_ROUNDS) {
      if (room.scores[0] > room.scores[1]) winner = 0;
      else if (room.scores[1] > room.scores[0]) winner = 1;
      else startOvertime = true;
    }
  }

  if (startOvertime) {
    room.overtime = true;
    room.overtimeRound = 0;
    room.overtimeTraps = [null, null];
    // Новые способности для овертайма (только xray/sabotage)
    room.overtimeAbilities = [randomOtAbility(), randomOtAbility()];
    room.abilityUsed = [false, false];
    room.phase = 'overtime_placing';

    // Таймаут на расстановку ловушек в овертайме — 30 секунд
    room.trapTimer = setTimeout(() => {
      if (room.phase !== 'overtime_placing') return;
      for (let i = 0; i < 2; i++) {
        if (!room.overtimeTraps[i]) {
          const t = new Set();
          while (t.size < OT_TRAPS) t.add(Math.floor(Math.random() * OT_ROUNDS));
          room.overtimeTraps[i] = [...t];
          send(room.players[i], { type: 'traps_auto' });
        }
      }
      checkOvertimeReady(room);
    }, 30000);

    // Bot places OT_TRAPS random traps for overtime
    const bot = room.players.find((p) => p.isBot);
    if (bot) {
      setTimeout(() => {
        const t = new Set();
        while (t.size < OT_TRAPS) t.add(Math.floor(Math.random() * OT_ROUNDS));
        room.overtimeTraps[bot.playerIndex] = [...t];
        checkOvertimeReady(room);
      }, 800 + Math.random() * 1200);
    }
  }

  const gameOver = winner !== null;

  // Send results
  room.players.forEach((p, i) => {
    const oppIdx = 1 - i;
    send(p, {
      type: 'round_result',
      you: results[i],
      opponent: results[oppIdx],
      step: stepPlayed,
      scores: [room.scores[0], room.scores[1]],
      winner: gameOver ? (winner === i ? 'win' : 'lose') : null,
      gameOver,
      round: room.overtime ? room.overtimeRound : room.currentStep,
      totalRounds: MAIN_ROUNDS,
      playerIndex: i,
      overtime: room.overtime,
      startOvertime,
      abilityUsed: [room.abilityUsed[0], room.abilityUsed[1]]
    });
  });

  room.moves = [null, null];

  if (gameOver) {
    room.phase = 'finished';
    finishMatchWithResult(room);
  } else {
    scheduleBotMove(room);
    scheduleMoveTimeout(room);
  }
}

function finishMatchWithResult(room, forceForfeit = false) {
  if (room.stuckTimer) { clearTimeout(room.stuckTimer); room.stuckTimer = null; }
  if (room.trapTimer) { clearTimeout(room.trapTimer); room.trapTimer = null; }
  const winner = room.forfeitWinner !== undefined ? room.forfeitWinner : (room.scores[0] > room.scores[1] ? 0 : 1);
  if (!room.reportSent) {
    room.reportSent = true;
    const playersPayload = room.players.map((p, i) => ({
      tgUserId: p.tgUserId || null,
      name: room.names[i] || 'Player',
      score: room.scores[i],
      isWinner: i === winner,
      isBot: !!p.isBot
    }));
    reportMatchToCentral({
      gameKey: 'obstacle_race',
      serverMatchId: room.id,
      mode: room.players.some((p) => p.isBot) ? 'bot' : 'pvp',
      winnerTgUserId: playersPayload[winner]?.tgUserId || null,
      players: playersPayload,
      score: { left: room.scores[0], right: room.scores[1] },
      details: {
        roundsPlayed: room.currentStep + 1,
        overtime: room.overtime,
        firstScorer: room.firstScorer,
        forceForfeit: forceForfeit
      }
    });
  }
  postToSheets({
    ability_1: room.abilities[0],
    ability_2: room.abilities[1],
    used_1: room.abilityUsed[0],
    used_2: room.abilityUsed[1],
    winner_ability: room.abilities[winner],
    rounds: room.currentStep + 1
  });
  rooms.delete(room.id);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Trap Runner PvP: http://localhost:${PORT}`);
});
