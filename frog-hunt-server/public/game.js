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
  $('btn-cancel').onclick = function() { wsSend({ type: 'cancel_wait' }); showScreen('start'); };
  $('btn-confirm').onclick = confirmChoice;
  $('btn-again').onclick = function() { startSearch(false); };
  $('btn-menu').onclick = function() { showScreen('start'); };
});

function showScreen(name) {
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
  $('screen-' + name).classList.add('active');
}

function showOverlay(id) { $(id).classList.add('active'); }
function hideOverlay(id) { $(id).classList.remove('active'); }
function hideAllOverlays() {
  var ols = document.querySelectorAll('.overlay');
  for (var i = 0; i < ols.length; i++) ols[i].classList.remove('active');
}

function connect(cb) {
  if (ws && ws.readyState === 1) { if (cb) cb(); return; }
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  ws.onopen = function() { console.log('WS connected'); if (cb) cb(); };
  ws.onmessage = function(e) {
    try {
      var msg = JSON.parse(e.data);
      console.log('WS recv:', msg.type);
      handleMessage(msg);
    } catch(err) { console.error('WS handler error:', err); }
  };
  ws.onclose = function() {
    console.log('WS disconnected');
    // Show disconnect and return to start
    var gameScreen = $('screen-game');
    if (gameScreen && gameScreen.classList.contains('active')) {
      stopTimer();
      $('hint-text').textContent = 'Соединение потеряно...';
      setTimeout(function() { showScreen('start'); }, 2000);
    }
  };
}

function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function startSearch(vsBot) {
  myName = ($('name-input').value || '').trim() || 'Игрок';
  connect(function() {
    wsSend({ type: vsBot ? 'find_bot' : 'find_game', name: myName, tgUserId: tgUserId });
    if (!vsBot) showScreen('waiting');
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
    wsSend({ type: 'frog_hide', cell: selectedCells[0] });
    $('hint-text').textContent = 'Прячешься...';
  } else {
    if (hunterShots === 1) {
      wsSend({ type: 'hunter_shoot', cell: selectedCells[0] });
    } else {
      wsSend({ type: 'hunter_shoot', cells: selectedCells });
    }
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
    if (pct <= 0) { clearInterval(timerInterval); }
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
  showFrog(msg.cell);
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
