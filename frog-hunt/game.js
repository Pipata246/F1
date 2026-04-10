var playerIndex = 0;
var opponentName = 'Бот 🤖';
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
var tgInitData = '';
var gameState = {
  inMatch: false,
  botFrogCell: null,
};

var $ = function(id) { return document.getElementById(id); };

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
    tgInitData = tg.initData || '';
  }
  // Also check URL param (passed from F1 Duel)
  var urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('userId')) tgUserId = urlParams.get('userId');

  initSounds();
  $('btn-find').onclick = function() { startSearch(true); };
  $('btn-bot').onclick = function() { startSearch(true); };
  $('btn-cancel').onclick = function() { showScreen('start'); };
  $('btn-confirm').onclick = confirmChoice;
  $('btn-again').onclick = function() { startSearch(true); };
  $('btn-menu').onclick = function() { window.location.href = '/'; };
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

function startSearch(vsBot) {
  if (!vsBot) {
    $('hint-text').textContent = 'Сейчас доступен режим против бота';
  }
  myName = ($('name-input').value || '').trim() || 'Игрок';
  showScreen('waiting');
  setTimeout(function() {
    localStartMatch();
  }, 650);
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
      '<span class="pad-icon frog-icon">🐸</span>' +
      '<span class="pad-icon trail-icon">💧</span>' +
      '<span class="pad-icon shot-icon">💥</span>';

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
    pads[i].classList.remove('selected-frog', 'selected-hunter', 'has-trail', 'shot', 'hit');
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
    localResolveFrogTurn(selectedCells[0]);
  } else {
    localResolveHunterTurn(selectedCells.slice());
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
    icon.textContent = '🐸';
    title.textContent = 'Ты — Жаба!';
    desc.textContent = 'Прячься на кувшинках. Переживи ' + totalRounds + ' ходов!';
  } else {
    icon.textContent = '🏹';
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
    ? '🔥 ФИНАЛЬНЫЙ ХОД! Куда прячешься?'
    : 'Выбери кувшинку!';

  startTimer(15000);
}

function animateFrogJump(fromCell, toCell, onDone) {
  var fromPad = getPad(fromCell);
  var toPad = getPad(toCell);
  if (!fromPad || !toPad) { onDone(); return; }

  hideAllFrogs();
  var pond = document.querySelector('.pond');
  var pondRect = pond.getBoundingClientRect();
  var fromRect = fromPad.getBoundingClientRect();
  var toRect = toPad.getBoundingClientRect();

  var flyer = document.createElement('div');
  flyer.className = 'frog-flyer';
  flyer.textContent = '🐸';
  flyer.style.position = 'absolute';
  flyer.style.left = (fromRect.left - pondRect.left + fromRect.width / 2) + 'px';
  flyer.style.top = (fromRect.top - pondRect.top + fromRect.height / 2) + 'px';
  flyer.style.transform = 'translate(-50%, -50%)';
  pond.appendChild(flyer);

  requestAnimationFrame(function() {
    flyer.style.left = (toRect.left - pondRect.left + toRect.width / 2) + 'px';
    flyer.style.top = (toRect.top - pondRect.top + toRect.height / 2) + 'px';
  });

  setTimeout(function() {
    flyer.remove();
    onDone();
  }, 400);
}

function onHunterTurn(msg) {
  currentRound = msg.round;
  totalRounds = msg.totalRounds;
  hunterShots = msg.hunterShots || 1;
  updateHeader();
  clearPadStates();
  setFinalRound(msg.isFinal);

  var pond = document.querySelector('.pond');
  pond.classList.add('choosing-hunter');

  // No hints — clean slate every round
  $('hint-text').textContent = msg.isFinal
    ? '🔥 ФИНАЛЬНЫЙ ХОД! Куда стрелять?'
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
    $('hint-text').textContent = '🏹 Выстрел...';
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
      $('hint-text').textContent = '💥 Попадание!';
    } else {
      // Reveal frog position on miss for both players
      showFrog(msg.frogCell);
      playSound('ribbit');
      playSound('miss');
      if (myRole === 'frog') {
        $('hint-text').textContent = '😌 Промах! Ты выжила!';
      } else {
        $('hint-text').textContent = '💨 Промах!';
      }
    }

    // Show overlay
    setTimeout(function() {
      if (msg.hit) {
        showRoundOverlay('💥', 'Попадание!', 'Жаба поймана!');
      } else if (msg.isFinal) {
        showRoundOverlay('🐸', 'Жаба выжила!', 'Все ' + msg.totalRounds + ' ходов пройдены!');
      } else {
        showRoundOverlay('💨', 'Промах!', 'Ход ' + msg.round + '/' + msg.totalRounds + ' пройден');
      }
    }, 1200);
  }, 1000);
}

function showRoundOverlay(icon, title, desc) {
  $('rr-icon').textContent = icon;
  $('rr-title').textContent = title;
  $('rr-desc').textContent = desc;
  showOverlay('overlay-round-result');
  setTimeout(function() { hideOverlay('overlay-round-result'); }, 2000);
}

function onGameOver(msg) {
  stopTimer();
  matchScores = msg.matchScores;

  var icon = $('go-icon');
  var title = $('go-title');
  var desc = $('go-desc');
  var score = $('go-score');

  if (msg.youWon) {
    icon.textContent = '🏆';
    title.textContent = 'Ты победил!';
    desc.textContent = msg.yourRole === 'hunter' ? 'Отличный выстрел!' : 'Жаба выжила!';
  } else {
    icon.textContent = '😔';
    title.textContent = 'Поражение';
    desc.textContent = msg.yourRole === 'hunter' ? 'Жаба ускользнула...' : 'Тебя нашли!';
  }

  score.textContent = 'Счёт матча: ' + matchScores[playerIndex] + ' : ' + matchScores[1 - playerIndex];

  hideOverlay('overlay-round-result');
  showOverlay('overlay-game-over');
  setTimeout(function() { hideOverlay('overlay-game-over'); }, 2800);
}

function onSwitchRoles() {
  hideAllOverlays();
  hideAllFrogs();
  showOverlay('overlay-switch');
  setTimeout(function() { hideOverlay('overlay-switch'); }, 2800);
}

function onTiebreakStart() {
  hideAllOverlays();
  hideAllFrogs();
  showOverlay('overlay-tiebreak');
  setTimeout(function() { hideOverlay('overlay-tiebreak'); }, 2800);
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
    icon.textContent = '👑';
    title.textContent = 'ПОБЕДА!';
    title.className = 'final-title won';
    playSound('win');
  } else {
    icon.textContent = '🐸';
    title.textContent = 'Поражение';
    title.className = 'final-title lost';
    playSound('lose');
  }

  score.textContent = matchScores[playerIndex] + ' : ' + matchScores[1 - playerIndex];
  saveMatchToBackend(msg.youWon);
}

function onOpponentLeft() {
  stopTimer();
  hideAllOverlays();
  $('hint-text').textContent = 'Соперник отключился';
  setTimeout(function() { showScreen('start'); }, 2000);
}

function localStartMatch() {
  gameState.inMatch = true;
  matchScores = [0, 0];
  gameNum = 1;
  var frogFirst = Math.random() < 0.5;
  myRole = frogFirst ? 'frog' : 'hunter';
  onGameFound({ playerIndex: 0, opponent: opponentName });
  localBeginGame();
}

function localBeginGame() {
  if (gameNum === 3) {
    totalRounds = 1;
    totalCells = 4;
    hunterShots = 2;
  } else {
    totalRounds = 5;
    totalCells = 8;
    hunterShots = 1;
  }
  currentRound = 1;
  gameState.botFrogCell = null;
  onRoleAssign({
    role: myRole,
    gameNum: gameNum,
    totalRounds: totalRounds,
    totalCells: totalCells,
    hunterShots: hunterShots,
    matchScores: matchScores.slice(),
  });
  setTimeout(localStartRound, 900);
}

function localStartRound() {
  if (myRole === 'frog') {
    onFrogTurn({
      round: currentRound,
      totalRounds: totalRounds,
      currentCell: myFrogCell,
      isFinal: currentRound === totalRounds,
    });
  } else {
    onHunterTurn({
      round: currentRound,
      totalRounds: totalRounds,
      hunterShots: hunterShots,
      isFinal: currentRound === totalRounds,
    });
  }
}

function pickRandomCell(max, exclude) {
  var cell = Math.floor(Math.random() * max);
  if (typeof exclude === 'number' && max > 1) {
    while (cell === exclude) cell = Math.floor(Math.random() * max);
  }
  return cell;
}

function pickRandomCells(max, count) {
  var set = {};
  while (Object.keys(set).length < count) {
    set[pickRandomCell(max)] = true;
  }
  return Object.keys(set).map(function(k) { return Number(k); });
}

function localResolveFrogTurn(cell) {
  var oldCell = myFrogCell;
  myFrogCell = cell;
  hideAllFrogs();
  showFrog(cell);
  playSound('hide');
  $('hint-text').textContent = '🏹 Охотник целится...';

  setTimeout(function() {
    var shots = pickRandomCells(totalCells, hunterShots);
    var moved = oldCell != null && oldCell !== cell;
    var afterShoot = function() {
      onRoundResult({
        hit: shots.indexOf(cell) >= 0,
        frogCell: cell,
        hunterCells: shots,
        round: currentRound,
        totalRounds: totalRounds,
        frogMoved: moved,
        previousCell: oldCell,
        isFinal: currentRound === totalRounds,
      });
      setTimeout(function() {
        localAfterRound(shots.indexOf(cell) >= 0);
      }, 2600);
    };
    if (moved && oldCell != null) animateFrogJump(oldCell, cell, afterShoot);
    else afterShoot();
  }, 700);
}

function localResolveHunterTurn(cells) {
  var oldCell = gameState.botFrogCell;
  var botCell;
  if (oldCell == null) botCell = pickRandomCell(totalCells);
  else botCell = Math.random() < 0.35 ? oldCell : pickRandomCell(totalCells, oldCell);
  gameState.botFrogCell = botCell;
  $('hint-text').textContent = 'Выстрел!';
  var moved = oldCell != null && oldCell !== botCell;

  var resolveFn = function() {
    onRoundResult({
      hit: cells.indexOf(botCell) >= 0,
      frogCell: botCell,
      hunterCells: cells,
      round: currentRound,
      totalRounds: totalRounds,
      frogMoved: moved,
      previousCell: oldCell,
      isFinal: currentRound === totalRounds,
    });
    setTimeout(function() {
      localAfterRound(cells.indexOf(botCell) >= 0);
    }, 2600);
  };
  if (moved && oldCell != null) animateFrogJump(oldCell, botCell, resolveFn);
  else resolveFn();
}

function localAfterRound(hit) {
  if (hit) {
    localEndGame('hunter');
    return;
  }
  if (currentRound >= totalRounds) {
    localEndGame('frog');
    return;
  }
  currentRound += 1;
  setTimeout(localStartRound, 900);
}

function localEndGame(winnerRole) {
  var myWon = myRole === winnerRole;
  var winnerIdx = myWon ? 0 : 1;
  matchScores[winnerIdx] += 1;
  onGameOver({
    winner: winnerRole,
    youWon: myWon,
    gameNum: gameNum,
    matchScores: matchScores.slice(),
    yourRole: myRole,
  });

  setTimeout(function() {
    if (gameNum === 1) {
      onSwitchRoles();
      myRole = myRole === 'frog' ? 'hunter' : 'frog';
      gameNum = 2;
      setTimeout(localBeginGame, 1100);
      return;
    }
    if (gameNum === 2 && matchScores[0] === matchScores[1]) {
      onTiebreakStart();
      myRole = Math.random() < 0.5 ? 'frog' : 'hunter';
      gameNum = 3;
      setTimeout(localBeginGame, 1100);
      return;
    }
    onMatchResult({
      youWon: matchScores[0] > matchScores[1],
      matchScores: matchScores.slice(),
      playerIndex: 0,
    });
  }, 1300);
}

function saveMatchToBackend(youWon) {
  if (!tgInitData || !tgUserId || !window.fetch) return;
  fetch('/api/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'recordMatch',
      initData: tgInitData,
      payload: {
        gameKey: 'frog_hunt',
        mode: 'bot',
        winnerTgUserId: youWon ? String(tgUserId) : null,
        players: [
          {
            tgUserId: String(tgUserId),
            name: myName || 'Игрок',
            score: matchScores[0] || 0,
            isWinner: !!youWon,
            isBot: false
          },
          {
            tgUserId: null,
            name: 'Бот 🤖',
            score: matchScores[1] || 0,
            isWinner: !youWon,
            isBot: true
          }
        ],
        score: { left: matchScores[0] || 0, right: matchScores[1] || 0 },
        details: { totalCells: totalCells, totalRounds: totalRounds, gameNum: gameNum }
      }
    })
  }).catch(function() {});
}

function updateHeader() {
  if (gameNum === 3) {
    $('game-label').textContent = 'Тайбрейк';
  } else {
    $('game-label').textContent = 'Игра ' + gameNum + '/2';
  }
  $('match-score').textContent = matchScores[playerIndex] + ' : ' + matchScores[1 - playerIndex];
  $('round-label').textContent = 'Ход ' + currentRound + '/' + totalRounds;
  $('role-label').textContent = myRole === 'frog' ? '🐸 Жаба' : '🏹 Охотник';
}
