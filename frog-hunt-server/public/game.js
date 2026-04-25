// ==================== SUPABASE REALTIME ====================
var supabase = null;
var supabaseChannel = null;

function initSupabase() {
  var SUPABASE_URL = 'https://eolycsnxboeobasolczb.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbHljc254Ym9lb2Jhc29sY3piIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3Njg0NTQsImV4cCI6MjA5MTM0NDQ1NH0.EVU6xdTy1S_9y5fgq4-AJJQHO-WPlNu3bFHgG617eJA';
  
  if (typeof window.supabase === 'undefined') {
    console.warn('Supabase library not loaded - WebSocket disabled');
    return;
  }
  
  try {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('✅ Supabase Realtime initialized');
  } catch (err) {
    console.error('Supabase init error:', err);
  }
}

function stopRealtimeSubscription() {
  if (supabaseChannel) {
    supabase.removeChannel(supabaseChannel);
    supabaseChannel = null;
    console.log('Realtime subscription stopped');
  }
}

function startRealtimeSubscription(roomId) {
  stopRealtimeSubscription();
  
  if (!supabase || !roomId) {
    console.error('Cannot start subscription: missing supabase or roomId');
    return;
  }
  
  console.log('🔌 Starting Realtime WebSocket for room:', roomId);
  
  var channelName = 'frog_hunt_room_' + roomId;
  
  supabaseChannel = supabase
    .channel(channelName)
    .on(
      'broadcast',
      { event: 'state_update' },
      function(payload) {
        console.log('📡 WebSocket update received:', payload);
        if (payload.payload && payload.payload.room) {
          var myTg = tgUserId;
          var forPlayer = payload.payload.forPlayer;
          // Only apply if this update is for me (or no filter)
          if (!forPlayer || forPlayer === myTg) {
            applyRoomState(payload.payload.room);
          }
        }
      }
    )
    .subscribe(function(status) {
      console.log('WebSocket status:', status);
      if (status === 'SUBSCRIBED') {
        console.log('✅ WebSocket connected!');
      }
    });
}

// ==================== API HELPERS ====================
var tgInitData = '';

function getTelegramInitData() {
  if (tgInitData) return tgInitData;
  if (window.Telegram && window.Telegram.WebApp) {
    tgInitData = window.Telegram.WebApp.initData || '';
  }
  return tgInitData;
}

async function apiPost(action, payload) {
  var body = {
    action: action,
    initData: getTelegramInitData()
  };
  for (var key in payload) {
    body[key] = payload[key];
  }
  
  var response = await fetch('/api/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  return await response.json();
}

function applyRoomState(room) {
  if (!room) return;
  
  var s = room.state_json || {};
  var status = String(room.status || '');
  
  console.log('Applying room state:', { status: status, phase: s.phase, round: s.currentRound });
  
  // Waiting for opponent
  if (status === 'waiting') {
    showScreen('waiting');
    return;
  }
  
  // Match over
  if (status === 'finished' || status === 'cancelled' || s.phase === 'match_over') {
    stopRealtimeSubscription();
    pvpRoomId = null;
    
    var myTg = tgUserId;
    var meIsP1 = String(room.player1_tg_user_id || '') === myTg;
    playerIndex = meIsP1 ? 0 : 1;
    
    var matchScoresObj = s.matchScores || { p1: 0, p2: 0 };
    matchScores = [Number(matchScoresObj.p1 || 0), Number(matchScoresObj.p2 || 0)];
    
    var youWon = false;
    if (s.winnerSide) {
      youWon = (s.winnerSide === 'p1' && meIsP1) || (s.winnerSide === 'p2' && !meIsP1);
    } else {
      youWon = matchScores[playerIndex] > matchScores[1 - playerIndex];
    }
    
    handleMessage({ type: 'match_result', youWon: youWon, matchScores: matchScores });
    return;
  }
  
  // Game active
  if (status === 'active') {
    var myTg = tgUserId;
    var meIsP1 = String(room.player1_tg_user_id || '') === myTg;
    playerIndex = meIsP1 ? 0 : 1;
    opponentName = meIsP1 ? (room.player2_name || 'Соперник') : (room.player1_name || 'Соперник');
    
    // Update game config
    totalRounds = Number(s.totalRounds || 5);
    totalCells = Number(s.totalCells || 8);
    hunterShots = Number(s.hunterShots || 1);
    gameNum = Number(s.gameNum || 1);
    
    // Get roles
    var roles = s.roles || {};
    myRole = (meIsP1 ? roles.p1 : roles.p2) || 'frog';
    
    // Check for role assignment (first time entering game)
    if (s.phase === 'turn_input' && currentRound === 1 && !$('screen-game').classList.contains('active')) {
      var matchScoresObj = s.matchScores || { p1: 0, p2: 0 };
      matchScores = [Number(matchScoresObj.p1 || 0), Number(matchScoresObj.p2 || 0)];
      
      handleMessage({
        type: 'game_found',
        playerIndex: playerIndex,
        opponent: opponentName
      });
      
      handleMessage({
        type: 'role_assign',
        role: myRole,
        gameNum: gameNum,
        totalRounds: totalRounds,
        totalCells: totalCells,
        hunterShots: hunterShots,
        matchScores: matchScores
      });
    }
    
    // Check for new round result
    var lastRound = s.lastRoundResult || {};
    var roundMarker = Number(lastRound.marker || 0);
    
    if (roundMarker > pvpLastRoundMarker && roundMarker > 0) {
      pvpLastRoundMarker = roundMarker;
      
      // Show round result
      handleMessage({
        type: 'round_result',
        hit: !!lastRound.hit,
        frogCell: Number(lastRound.frogCell || 0),
        hunterCells: Array.isArray(lastRound.hunterCells) ? lastRound.hunterCells : [Number(lastRound.frogCell || 0)],
        round: Number(lastRound.round || 1),
        totalRounds: Number(s.totalRounds || 5),
        isFinal: !!lastRound.isFinal
      });
      return;
    }
    
    // Check for game over (within match)
    var lastGame = s.lastGameResult || {};
    var gameMarker = Number(lastGame.marker || 0);
    
    if (gameMarker > pvpLastGameMarker && gameMarker > 0) {
      pvpLastGameMarker = gameMarker;
      
      var matchScoresObj = s.matchScores || { p1: 0, p2: 0 };
      matchScores = [Number(matchScoresObj.p1 || 0), Number(matchScoresObj.p2 || 0)];
      
      var winnerRole = lastGame.winnerRole || null;
      var youWonGame = (winnerRole === myRole);
      
      handleMessage({
        type: 'game_over',
        youWon: youWonGame,
        yourRole: myRole,
        matchScores: matchScores
      });
      
      // Check if we need to switch roles or start tiebreak
      if (gameNum === 1 && matchScores[0] !== matchScores[1]) {
        // Switch roles for game 2
        setTimeout(function() {
          handleMessage({ type: 'switch_roles' });
        }, 2000);
      } else if (gameNum === 2 && matchScores[0] === matchScores[1]) {
        // Tiebreak
        setTimeout(function() {
          handleMessage({ type: 'tiebreak_start' });
        }, 2000);
      }
      return;
    }
    
    // Turn input phase
    if (s.phase === 'turn_input') {
      var pending = s.pending || {};
      currentRound = Number(s.currentRound || 1);
      
      if (myRole === 'frog') {
        var frogChosen = pending.frogCell !== null && pending.frogCell !== undefined;
        var mySide = meIsP1 ? 'p1' : 'p2';
        var myPending = (mySide === 'p1' && frogChosen) || (mySide === 'p2' && frogChosen);
        
        if (!myPending && !moveChosen) {
          handleMessage({
            type: 'frog_turn',
            round: currentRound,
            totalRounds: totalRounds,
            currentCell: myFrogCell,
            isFinal: currentRound >= totalRounds
          });
        } else if (myPending && moveChosen) {
          // Frog hidden, waiting for hunter
          handleMessage({
            type: 'frog_hidden',
            cell: myFrogCell
          });
        } else {
          handleMessage({
            type: 'wait_for_frog',
            round: currentRound,
            totalRounds: totalRounds,
            isFinal: currentRound >= totalRounds
          });
        }
      } else {
        // Hunter
        var hunterChosen = Array.isArray(pending.hunterCells) && pending.hunterCells.length === hunterShots;
        
        if (!hunterChosen && !moveChosen) {
          handleMessage({
            type: 'hunter_turn',
            round: currentRound,
            totalRounds: totalRounds,
            hunterShots: hunterShots,
            isFinal: currentRound >= totalRounds
          });
        }
      }
    }
    
    // Round result phase - wait for backend to transition
    if (s.phase === 'round_result') {
      // Just wait, the lastRoundResult marker will trigger above
    }
    
    // Game over phase - wait for backend to transition
    if (s.phase === 'game_over') {
      // Just wait, the lastGameResult marker will trigger above
    }
  }
}

// ==================== GAME STATE ====================
var ws = null;
var playerIndex = -1;
var opponentName = '';
var myName = '';
var myRole = '';
var gameNum = 1;
var currentRound = 1;
var totalRounds = 5;
var totalCells = 8;
var hunterShots = 1;
var selectedCells = [];
var moveChosen = false;
var timerInterval = null;
var matchScores = [0, 0];
var myFrogCell = null;
var tgUserId = null;

// PvP state
var pvpRoomId = null;
var pvpMode = 'idle'; // 'idle', 'pvp', 'bot'
var pvpLastRoundMarker = 0;
var pvpLastGameMarker = 0;

var $ = function(id) { return document.getElementById(id); };
function setUiIcon(el, name) {
  if (!el) return;
  el.innerHTML = '<span class="ui-icon ui-icon-' + String(name || 'frog') + '"></span>';
}

var SFX = {};
function initSounds() {
  var files = {
    click: 'Click Or Tap.mp3',
    shoot: 'Arrow_Throw.mp3',
    hit: 'Arrow_Hit.mp3',
    ribbit: 'Frog_Ribbit.wav',
    miss: 'Lilypad_Missed.mp3',
    hide: 'Quick_Swoosh.mp3',
    ping: 'Pi-Link.mp3',
    win: 'You_Won.mp3',
    lose: 'You_Lost.mp3',
    good: 'Positive_Reaction.mp3',
    bad: 'Negative_Reaction.mp3'
  };
  for (var key in files) {
    SFX[key] = new Audio('sounds/' + files[key]);
    SFX[key].preload = 'auto';
    SFX[key].volume = 0.5;
  }
  SFX.win.volume = 0.7;
  SFX.lose.volume = 0.7;
}

function playSound(name) {
  var s = SFX[name];
  if (!s) return;
  s.currentTime = 0;
  s.play().catch(function() {});
}

document.addEventListener('DOMContentLoaded', function() {
  // Initialize Supabase Realtime
  initSupabase();
  
  if (window.Telegram && window.Telegram.WebApp) {
    var tg = window.Telegram.WebApp;
    tg.ready(); tg.expand();
    document.body.classList.add('tg-theme');
    var user = tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (user) {
      if (user.first_name) $('name-input').value = user.first_name;
      tgUserId = String(user.id);
    }
  }
  // Also check URL param (passed from F1 Duel)
  var urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('userId')) tgUserId = urlParams.get('userId');

  initSounds();
  $('btn-find').onclick = function() { startSearch(false); };
  $('btn-bot').onclick = function() { startSearch(true); };
  $('btn-cancel').onclick = function() { cancelSearch(); };
  $('btn-confirm').onclick = confirmChoice;
  $('btn-again').onclick = function() { startSearch(false); };
  $('btn-menu').onclick = function() { showScreen('start'); };
});

function showScreen(name) {
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
  $('screen-' + name).classList.add('active');
}

function cancelSearch() {
  if (pvpMode === 'pvp' && pvpRoomId) {
    apiPost('pvpCancelQueue', { roomId: pvpRoomId }).catch(function() {});
    stopRealtimeSubscription();
  }
  pvpMode = 'idle';
  pvpRoomId = null;
  showScreen('start');
}

function showOverlay(id) { $(id).classList.add('active'); }
function hideOverlay(id) { $(id).classList.remove('active'); }
function hideAllOverlays() {
  var ols = document.querySelectorAll('.overlay');
  for (var i = 0; i < ols.length; i++) ols[i].classList.remove('active');
}

function startSearch(vsBot) {
  myName = ($('name-input').value || '').trim() || 'Игрок';
  pvpMode = vsBot ? 'bot' : 'pvp';
  pvpLastRoundMarker = 0;
  pvpLastGameMarker = 0;
  
  showScreen('waiting');
  
  apiPost('pvpFindMatch', {
    gameKey: 'frog_hunt',
    playerName: myName,
    stakeOptions: [0.1] // Minimal stake for now
  }).then(function(data) {
    if (!data || !data.ok || !data.room) {
      throw new Error(data.error || 'Failed to find match');
    }
    
    pvpRoomId = data.room.id;
    console.log('Room created:', pvpRoomId);
    
    // Start Realtime WebSocket subscription (secure broadcast)
    startRealtimeSubscription(pvpRoomId);
    
    // Initial state
    if (data.room) {
      applyRoomState(data.room);
    }
  }).catch(function(err) {
    console.error('Find match error:', err);
    alert('Ошибка поиска: ' + (err.message || 'Неизвестная ошибка'));
    showScreen('start');
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'waiting':        showScreen('waiting'); break;
    case 'game_found':     onGameFound(msg); break;
    case 'role_assign':    onRoleAssign(msg); break;
    case 'frog_turn':      onFrogTurn(msg); break;
    case 'wait_for_frog':  onWaitForFrog(msg); break;
    case 'frog_hidden':    onFrogHidden(msg); break;
    case 'hunter_turn':    onHunterTurn(msg); break;
    case 'round_result':   onRoundResult(msg); break;
    case 'game_over':      onGameOver(msg); break;
    case 'switch_roles':   onSwitchRoles(); break;
    case 'tiebreak_start': onTiebreakStart(); break;
    case 'match_result':   onMatchResult(msg); break;
    case 'opponent_left':  onOpponentLeft(); break;
  }
}

function generateLilypads(count) {
  var container = $('lilypads');
  container.innerHTML = '';
  container.classList.toggle('overtime', count <= 4);

  for (var i = 0; i < count; i++) {
    var pad = document.createElement('div');
    pad.className = 'lilypad';
    pad.dataset.cell = i;

    pad.innerHTML =
      '<svg class="pad-svg" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M30 10 C30 10 26 10 24 12 C16 8 4 16 4 32 C4 48 18 54 30 54 C42 54 56 48 56 32 C56 16 44 8 36 12 C34 10 30 10 30 10 Z" fill="#1a6a30"/>' +
        '<path d="M30 13 C30 13 27 13 25 15 C18 11 7 18 7 32 C7 46 19 51 30 51 C41 51 53 46 53 32 C53 18 42 11 35 15 C33 13 30 13 30 13 Z" fill="#228a3c"/>' +
        '<path d="M30 18 C30 18 28 18 27 19 C22 16 14 22 14 32 C14 42 22 46 30 46 C38 46 46 42 46 32 C46 22 38 16 33 19 C32 18 30 18 30 18 Z" fill="#2aaa48" opacity="0.3"/>' +
        '<line x1="30" y1="32" x2="10" y2="42" stroke="#1a6a30" stroke-width="0.7" opacity="0.3"/>' +
        '<line x1="30" y1="32" x2="50" y2="42" stroke="#1a6a30" stroke-width="0.7" opacity="0.3"/>' +
        '<line x1="30" y1="32" x2="14" y2="20" stroke="#1a6a30" stroke-width="0.7" opacity="0.3"/>' +
        '<line x1="30" y1="32" x2="46" y2="20" stroke="#1a6a30" stroke-width="0.7" opacity="0.3"/>' +
        '<line x1="30" y1="32" x2="30" y2="52" stroke="#1a6a30" stroke-width="0.7" opacity="0.3"/>' +
      '</svg>' +
      '<span class="pad-icon frog-icon"><span class="frog-face"><span class="frog-eye left"><span class="frog-pupil"></span></span><span class="frog-eye right"><span class="frog-pupil"></span></span><span class="frog-mouth"></span></span></span>' +
      '<span class="pad-icon trail-icon"><span class="ui-icon ui-icon-trail"></span></span>' +
      '<span class="pad-icon shot-icon"><span class="ui-icon ui-icon-burst"></span></span>';

    pad.addEventListener('click', (function(idx) {
      return function() { onPadClick(idx); };
    })(i));

    container.appendChild(pad);
  }
}

function getPad(cell) {
  return document.querySelector('.lilypad[data-cell="' + cell + '"]');
}

function clearPadStates() {
  var pads = document.querySelectorAll('.lilypad');
  for (var i = 0; i < pads.length; i++) {
    pads[i].classList.remove('selected-frog', 'selected-hunter', 'has-trail', 'shot', 'hit', 'has-frog');
    // Hide icons
    var icons = pads[i].querySelectorAll('.pad-icon');
    for (var j = 0; j < icons.length; j++) icons[j].style.display = '';
  }
  selectedCells = [];
  moveChosen = false;
  $('btn-confirm').disabled = true;
}

function showFrog(cell) {
  hideAllFrogs();
  var pad = getPad(cell);
  if (pad) pad.classList.add('has-frog');
}

function hideAllFrogs() {
  var pads = document.querySelectorAll('.lilypad.has-frog');
  for (var i = 0; i < pads.length; i++) pads[i].classList.remove('has-frog');
}

function showTrail(cell) {
  var pad = getPad(cell);
  if (pad) pad.classList.add('has-trail');
}

function showShot(cell) {
  var pad = getPad(cell);
  if (pad) pad.classList.add('shot');
}

function onPadClick(cell) {
  if (moveChosen) return;
  var pond = document.querySelector('.pond');
  if (!pond) return;

  if (myRole === 'frog' && pond.classList.contains('choosing-frog')) {
    // Frog: select one pad
    playSound('click');
    var pads = document.querySelectorAll('.lilypad');
    for (var i = 0; i < pads.length; i++) pads[i].classList.remove('selected-frog');
    selectedCells = [cell];
    var pad = getPad(cell);
    if (pad) pad.classList.add('selected-frog');
    $('btn-confirm').disabled = false;

  } else if (myRole === 'hunter' && pond.classList.contains('choosing-hunter')) {
    // Hunter: select hunterShots pads
    var idx = selectedCells.indexOf(cell);
    if (idx >= 0) {
      // Deselect
      selectedCells.splice(idx, 1);
      var p = getPad(cell);
      if (p) p.classList.remove('selected-hunter');
    } else {
      playSound('click');
      // If already at max, remove the oldest selection
      if (selectedCells.length >= hunterShots) {
        var removed = selectedCells.shift();
        var rp = getPad(removed);
        if (rp) rp.classList.remove('selected-hunter');
      }
      // Select new
      selectedCells.push(cell);
      var p2 = getPad(cell);
      if (p2) p2.classList.add('selected-hunter');
    }
    $('btn-confirm').disabled = (selectedCells.length !== hunterShots);
  }
}

function confirmChoice() {
  if (moveChosen) return;
  if (selectedCells.length === 0) return;
  moveChosen = true;
  $('btn-confirm').disabled = true;
  stopTimer();

  var pond = document.querySelector('.pond');
  pond.classList.remove('choosing-frog', 'choosing-hunter');

  if (myRole === 'frog') {
    var cell = selectedCells[0];
    myFrogCell = cell;
    
    apiPost('pvpSubmitMove', {
      roomId: pvpRoomId,
      move: { frogCell: cell }
    }).then(function(data) {
      if (data && data.ok && data.room) {
        applyRoomState(data.room);
      }
    }).catch(function(err) {
      console.error('Submit frog move error:', err);
    });
    
    $('hint-text').textContent = 'Прячешься...';
    
    // Show frog on new position
    hideAllFrogs();
    showFrog(cell);
    playSound('hide');
    
  } else {
    var cells = selectedCells.slice();
    
    apiPost('pvpSubmitMove', {
      roomId: pvpRoomId,
      move: { hunterCells: cells }
    }).then(function(data) {
      if (data && data.ok && data.room) {
        applyRoomState(data.room);
      }
    }).catch(function(err) {
      console.error('Submit hunter move error:', err);
    });
    
    $('hint-text').textContent = 'Выстрел!';
  }
}

function startTimer(ms) {
  stopTimer();
  var bar = $('timer-bar');
  bar.style.width = '100%';
  bar.classList.remove('urgent');
  var start = Date.now();

  timerInterval = setInterval(function() {
    var pct = Math.max(0, 1 - (Date.now() - start) / ms) * 100;
    bar.style.width = pct + '%';
    if (pct < 25) bar.classList.add('urgent');
    if (pct <= 0) {
      clearInterval(timerInterval);
      if (!moveChosen) {
        if (myRole === 'frog') {
          selectedCells = [Math.floor(Math.random() * Math.max(1, totalCells))];
        } else {
          var need = Math.max(1, Number(hunterShots || 1));
          var pick = [];
          var maxCell = Math.max(1, totalCells);
          while (pick.length < need) {
            var n = Math.floor(Math.random() * maxCell);
            if (pick.indexOf(n) === -1) pick.push(n);
          }
          selectedCells = pick;
        }
        confirmChoice();
      }
    }
  }, 50);
}

function stopTimer() {
  clearInterval(timerInterval);
  var bar = $('timer-bar');
  if (bar) { bar.style.width = '0%'; bar.classList.remove('urgent'); }
}

function setFinalRound(isFinal) {
  var layout = document.querySelector('.game-layout');
  if (layout) layout.classList.toggle('final-round', !!isFinal);
}

function onGameFound(msg) {
  playerIndex = msg.playerIndex;
  opponentName = msg.opponent;
  matchScores = [0, 0];
  gameNum = 1;
  playSound('ping');
  showScreen('game');
  hideAllOverlays();
}

function onRoleAssign(msg) {
  myRole = msg.role;
  gameNum = msg.gameNum;
  totalRounds = msg.totalRounds;
  totalCells = msg.totalCells;
  hunterShots = msg.hunterShots || 1;
  if (msg.matchScores) matchScores = msg.matchScores;
  myFrogCell = null;
  currentRound = 1;

  generateLilypads(totalCells);
  clearPadStates();
  hideAllFrogs();
  setFinalRound(false);
  updateHeader();

  // Role reveal overlay
  var icon = $('role-icon');
  var title = $('role-title');
  var desc = $('role-desc');

  if (myRole === 'frog') {
    setUiIcon(icon, 'frog');
    title.textContent = 'Ты — Жаба!';
    desc.textContent = 'Прячься на кувшинках. Переживи ' + totalRounds + ' ходов!';
  } else {
    setUiIcon(icon, 'hunter');
    title.textContent = 'Ты — Охотник!';
    if (hunterShots > 1) {
      desc.textContent = 'Найди жабу! ' + hunterShots + ' выстрела за ход!';
    } else {
      desc.textContent = 'Найди жабу! У тебя ' + totalRounds + ' попыток.';
    }
  }

  showOverlay('overlay-role');
  setTimeout(function() { hideOverlay('overlay-role'); }, 2800);
}

function onFrogTurn(msg) {
  currentRound = msg.round;
  totalRounds = msg.totalRounds;
  updateHeader();
  clearPadStates();
  setFinalRound(msg.isFinal);
  moveChosen = false; // Reset for new turn

  var pond = document.querySelector('.pond');
  pond.classList.add('choosing-frog');

  // Show frog on current position so player sees where they are
  if (msg.currentCell != null) myFrogCell = msg.currentCell;
  hideAllFrogs();
  if (myFrogCell != null) {
    showFrog(myFrogCell);
  }

  $('hint-text').textContent = msg.isFinal
    ? 'ФИНАЛЬНЫЙ ХОД! Куда прячешься?'
    : 'Выбери кувшинку!';

  startTimer(15000);
}

function onWaitForFrog(msg) {
  currentRound = msg.round;
  totalRounds = msg.totalRounds;
  updateHeader();
  clearPadStates();
  hideAllFrogs();
  setFinalRound(msg.isFinal);
  $('hint-text').textContent = 'Жаба прячется...';
  $('btn-confirm').disabled = true;
  stopTimer();
}

function onFrogHidden(msg) {
  var oldCell = myFrogCell;
  myFrogCell = msg.cell;
  moveChosen = true;
  stopTimer();
  $('btn-confirm').disabled = true;

  var pond = document.querySelector('.pond');
  pond.classList.remove('choosing-frog');

  // Clear selection
  var pads = document.querySelectorAll('.lilypad.selected-frog');
  for (var i = 0; i < pads.length; i++) pads[i].classList.remove('selected-frog');

  // Show frog on new position for frog player
  hideAllFrogs();
  if (msg.cell !== null && msg.cell !== undefined) {
    showFrog(msg.cell);
  }
  playSound('hide');

  $('hint-text').textContent = 'Охотник целится...';
}

function onHunterTurn(msg) {
  currentRound = msg.round;
  totalRounds = msg.totalRounds;
  hunterShots = msg.hunterShots || 1;
  updateHeader();
  clearPadStates();
  setFinalRound(msg.isFinal);
  hideAllFrogs();
  myFrogCell = null;
  moveChosen = false; // Reset for new turn

  var pond = document.querySelector('.pond');
  pond.classList.add('choosing-hunter');

  // No hints — clean slate every round
  $('hint-text').textContent = msg.isFinal
    ? 'ФИНАЛЬНЫЙ ХОД! Куда стрелять?'
    : 'Куда стрелять?';

  if (hunterShots > 1) {
    $('hint-text').textContent += ' (выбери ' + hunterShots + ')';
  }

  startTimer(15000);
}

function onRoundResult(msg) {
  stopTimer();
  moveChosen = true;
  $('btn-confirm').disabled = true;

  var pond = document.querySelector('.pond');
  pond.classList.remove('choosing-frog', 'choosing-hunter');

  // Show hunter shots (sink animation)
  playSound('shoot');
  for (var i = 0; i < msg.hunterCells.length; i++) {
    showShot(msg.hunterCells[i]);
  }

  if (myRole === 'frog') {
    $('hint-text').textContent = 'Выстрел...';
  } else {
    $('hint-text').textContent = 'Твой выстрел...';
  }

  // After delay: show result
  setTimeout(function() {
    if (msg.hit) {
      // Show frog on hit cell
      var hitCell = msg.frogCell;
      var hitPad = getPad(hitCell);
      if (hitPad) hitPad.classList.add('hit');
      showFrog(hitCell);
      playSound('hit');
      $('hint-text').textContent = 'Попадание!';
    } else {
      // Reveal frog position on miss for both players
      showFrog(msg.frogCell);
      playSound('ribbit');
      playSound('miss');
      if (myRole === 'frog') {
        $('hint-text').textContent = '😌 Промах! Ты выжила!';
      } else {
        $('hint-text').textContent = 'Промах!';
      }
    }

    // Show overlay
    setTimeout(function() {
      if (msg.hit) {
        showRoundOverlay('burst', 'Попадание!', 'Жаба поймана!');
      } else if (msg.isFinal) {
        showRoundOverlay('frog', 'Жаба выжила!', 'Все ' + msg.totalRounds + ' ходов пройдены!');
      } else {
        showRoundOverlay('trail', 'Промах!', 'Ход ' + msg.round + '/' + msg.totalRounds + ' пройден');
      }
    }, 1200);
  }, 1000);
}

function showRoundOverlay(icon, title, desc) {
  setUiIcon($('rr-icon'), icon);
  $('rr-title').textContent = title;
  $('rr-desc').textContent = desc;
  showOverlay('overlay-round-result');
  setTimeout(function() { hideOverlay('overlay-round-result'); }, 1200);
}

function onGameOver(msg) {
  stopTimer();
  matchScores = msg.matchScores;

  var icon = $('go-icon');
  var title = $('go-title');
  var desc = $('go-desc');
  var score = $('go-score');

  if (msg.youWon) {
    setUiIcon(icon, 'trophy');
    title.textContent = 'Ты победил!';
    desc.textContent = msg.yourRole === 'hunter' ? 'Отличный выстрел!' : 'Жаба выжила!';
  } else {
    setUiIcon(icon, 'lose');
    title.textContent = 'Поражение';
    desc.textContent = msg.yourRole === 'hunter' ? 'Жаба ускользнула...' : 'Тебя нашли!';
  }

  score.textContent = 'Счёт матча: ' + matchScores[playerIndex] + ' : ' + matchScores[1 - playerIndex];

  showOverlay('overlay-game-over');
  setTimeout(function() { hideOverlay('overlay-game-over'); }, 1500);
}

function onSwitchRoles() {
  hideAllOverlays();
  hideAllFrogs();
  showOverlay('overlay-switch');
  setTimeout(function() { hideOverlay('overlay-switch'); }, 2000);
}

function onTiebreakStart() {
  hideAllOverlays();
  hideAllFrogs();
  showOverlay('overlay-tiebreak');
  setTimeout(function() { hideOverlay('overlay-tiebreak'); }, 2000);
}

function onMatchResult(msg) {
  hideAllOverlays();
  hideAllFrogs();
  matchScores = msg.matchScores;
  showScreen('result');

  var icon = $('final-icon');
  var title = $('final-title');
  var score = $('final-score');

  if (msg.youWon) {
    setUiIcon(icon, 'crown');
    title.textContent = 'ПОБЕДА!';
    title.className = 'final-title won';
    playSound('win');
  } else {
    setUiIcon(icon, 'lose');
    title.textContent = 'Поражение';
    title.className = 'final-title lost';
    playSound('lose');
  }

  score.textContent = matchScores[playerIndex] + ' : ' + matchScores[1 - playerIndex];
}

function onOpponentLeft() {
  stopTimer();
  hideAllOverlays();
  $('hint-text').textContent = 'Соперник отключился';
  setTimeout(function() { showScreen('start'); }, 2000);
}

function updateHeader() {
  if (gameNum === 3) {
    $('game-label').textContent = 'Тайбрейк';
  } else {
    $('game-label').textContent = 'Игра ' + gameNum + '/2';
  }
  $('match-score').textContent = matchScores[playerIndex] + ' : ' + matchScores[1 - playerIndex];
  $('round-label').textContent = 'Ход ' + currentRound + '/' + totalRounds;
  $('role-label').textContent = myRole === 'frog' ? 'Жаба' : 'Охотник';
}
