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
var SETTINGS_KEY = "f1duel_global_settings_v1";
var tgInitData = '';
var isBotMode = false;
var pvpRoomId = null;
var pvpPollTimer = null;
var pvpLastRoundMarker = 0;
var pvpLastGameMarker = 0;
var pvpLastSwitchMarker = 0;
var pvpLastTiebreakMarker = 0;
var pvpLastMatchMarker = 0;
var pvpLastTurnKey = '';
var pvpPendingSubmit = false;
var pvpPollInFlight = false;
var PVP_POLL_MS = 350;
var pvpRecovering = false;
var selectedStakeOptions = [];
var currentStakeTon = null;
var ALLOWED_STAKES = [1, 5, 10, 25, 50, 100];
var currentBalanceTon = 0;
var bottomNoticeTimer = null;
var onlineModeSelected = false;
var pvpAcceptDeadlineMs = 0;
var pvpOpponentTgId = '';
var pvpOpponentIsBot = false;
var gameState = {
  inMatch: false,
  botFrogCell: null,
};

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
  try{
    var settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if(settings.sound === false) return;
  }catch(e){}
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
      tgUserId = String(user.id);
    }
    tgInitData = tg.initData || '';
  }
  // Also check URL param (passed from F1 Duel)
  var urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('userId')) tgUserId = urlParams.get('userId');

  var presenceTimer = null;
  function presencePing() {
    if (!tgInitData) return;
    fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'presenceHeartbeat', initData: tgInitData }),
    }).catch(function() {});
  }
  function startPresenceLoop() {
    if (presenceTimer) clearInterval(presenceTimer);
    presencePing();
    presenceTimer = setInterval(presencePing, 9000);
  }
  function presenceLeaveNet() {
    if (!tgInitData) return;
    var payload = JSON.stringify({ action: 'presenceLeave', initData: tgInitData });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/user', new Blob([payload], { type: 'application/json' }));
      }
    } catch (e) {}
    fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(function() {});
  }
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      presencePing();
      return;
    }
    if (!isBotMode && pvpRoomId && tgInitData) {
      beaconPvpCancelQueue(pvpRoomId);
    }
  });
  window.addEventListener('focus', presencePing);

  initSounds();
  startPresenceLoop();

  if ($('btn-find')) $('btn-find').onclick = function() { startSearchOnline(); };
  if ($('btn-bot')) $('btn-bot').onclick = function() { openDemoIntro(); };
  if ($('btn-demo-play')) $('btn-demo-play').onclick = function() { startSearchBot(); };
  if ($('btn-demo-back')) $('btn-demo-back').onclick = function() { window.location.href = '/'; };
  ensureStakePicker();
  setStakePickerVisible(false);
  refreshBalanceForStakePicker();
  $('btn-cancel').onclick = function() { leavePvpQueue(); window.location.href = '/'; };
  $('btn-confirm').onclick = confirmChoice;
  $('btn-again').onclick = function() { isBotMode ? startSearchBot() : startSearchOnline(); };
  $('btn-menu').onclick = function() { window.location.href = '/'; };
  window.addEventListener('pagehide', function() { leavePvpQueue(); presenceLeaveNet(); });
  window.addEventListener('beforeunload', function() { leavePvpQueue(); presenceLeaveNet(); });

  var launchMode = String(urlParams.get('launch') || '').toLowerCase();
  if (launchMode === 'demo') {
    setTimeout(function() { openDemoIntro(); }, 0);
  } else if (launchMode === 'play') {
    setTimeout(function() { startSearchOnline(); }, 0);
  } else {
    window.location.href = '/';
  }
});

function showScreen(name) {
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
  $('screen-' + name).classList.add('active');
  if (name === 'start') {
    onlineModeSelected = false;
    setModeButtonsVisible(true);
    setStakePickerVisible(false);
  }
  if (name === 'waiting') {
    // Waiting screen is also used under accept modal.
  }
}

function showOverlay(id) { $(id).classList.add('active'); }
function hideOverlay(id) { $(id).classList.remove('active'); }
function hideAllOverlays() {
  var ols = document.querySelectorAll('.overlay');
  for (var i = 0; i < ols.length; i++) ols[i].classList.remove('active');
}

function showBottomNotice(msg) {
  var n = $('bottomNotice');
  if (!n) {
    n = document.createElement('div');
    n.id = 'bottomNotice';
    n.style.position = 'fixed';
    n.style.left = '50%';
    n.style.bottom = '20px';
    n.style.transform = 'translateX(-50%)';
    n.style.background = 'rgba(0,0,0,.88)';
    n.style.color = '#fff';
    n.style.padding = '10px 14px';
    n.style.borderRadius = '12px';
    n.style.fontSize = '13px';
    n.style.fontWeight = '700';
    n.style.zIndex = '9999';
    n.style.display = 'none';
    document.body.appendChild(n);
  }
  n.textContent = String(msg || '');
  n.style.display = 'block';
  clearTimeout(bottomNoticeTimer);
  bottomNoticeTimer = setTimeout(function() { n.style.display = 'none'; }, 2200);
}

function ensureStakePicker() {
  var mount = $('screen-start');
  if (!mount || $('stakePickerWrap')) return;
  var wrap = document.createElement('div');
  wrap.id = 'stakePickerWrap';
  wrap.style.marginTop = '6px';
  wrap.style.width = '100%';
  wrap.style.maxWidth = '340px';
  wrap.style.marginLeft = 'auto';
  wrap.style.marginRight = 'auto';
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.alignItems = 'center';
  wrap.style.transform = 'translateY(-22px)';
  wrap.innerHTML =
    '<div style="font-size:12px;color:#9aa3b2;margin-bottom:10px;text-transform:uppercase;letter-spacing:.08em;text-align:center;width:100%">Выбери ставки TON</div>' +
    '<div id="stakeGridFrog" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:stretch;width:100%"></div>' +
    '<button type="button" id="stakePlayBtnFrog" class="btn primary" style="margin-top:12px">Играть</button>';
  mount.appendChild(wrap);
  var grid = $('stakeGridFrog');
  ALLOWED_STAKES.forEach(function(stake) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost';
    b.dataset.stake = String(stake);
    b.style.height = '74px';
    b.style.padding = '0 6px';
    b.style.fontWeight = '900';
    b.style.fontSize = '13px';
    b.style.display = 'flex';
    b.style.alignItems = 'center';
    b.style.justifyContent = 'center';
    b.style.whiteSpace = 'nowrap';
    b.style.borderRadius = '14px';
    b.textContent = stake + ' TON';
    b.onclick = function() {
      var n = Number(b.dataset.stake);
      if (currentBalanceTon < n) {
        showBottomNotice('У вас недостаточно денег на балансе');
        return;
      }
      if (selectedStakeOptions.indexOf(n) >= 0) {
        selectedStakeOptions = selectedStakeOptions.filter(function(x) { return x !== n; });
      } else {
        selectedStakeOptions.push(n);
      }
      renderStakePicker();
    };
    grid.appendChild(b);
  });
  var playBtn = $('stakePlayBtnFrog');
  if (playBtn) playBtn.onclick = function(){ beginOnlineSearch(); };
  renderStakePicker();
}

function setStakePickerVisible(v){
  var wrap = $('stakePickerWrap');
  if(!wrap) return;
  wrap.style.display = v ? 'flex' : 'none';
  var rules = document.querySelector('#screen-start .rules-block');
  if (rules) rules.style.display = v ? 'none' : '';
  var logo = document.querySelector('#screen-start .logo-container');
  if (logo) logo.style.marginBottom = v ? '14px' : '';
}

function setModeButtonsVisible(v){
  if ($('btn-find')) $('btn-find').style.display = v ? '' : 'none';
  if ($('btn-bot')) $('btn-bot').style.display = v ? '' : 'none';
}

function renderStakePicker() {
  var grid = $('stakeGridFrog');
  if (!grid) return;
  var nodes = grid.querySelectorAll('button[data-stake]');
  for (var i = 0; i < nodes.length; i++) {
    var b = nodes[i];
    var n = Number(b.dataset.stake);
    var on = selectedStakeOptions.indexOf(n) >= 0;
    var blocked = currentBalanceTon < n;
    b.style.borderColor = blocked ? 'rgba(248,113,113,.8)' : (on ? '#78f5b5' : 'rgba(255,255,255,.18)');
    b.style.background = blocked ? 'rgba(239,68,68,.18)' : (on ? 'rgba(35,197,94,.22)' : 'rgba(255,255,255,.08)');
    b.style.color = blocked ? '#fecaca' : (on ? '#d6ffe9' : '#fff');
    b.style.opacity = blocked ? '0.85' : '1';
  }
}

function startSearchOnline() {
  if(!onlineModeSelected){
    onlineModeSelected = true;
    isBotMode = false;
    setModeButtonsVisible(false);
    setStakePickerVisible(true);
    refreshBalanceForStakePicker();
    showBottomNotice('Выбери ставку и нажми "Играть"');
    return;
  }
  beginOnlineSearch();
}

function beginOnlineSearch() {
  isBotMode = false;
  currentStakeTon = null;
  if (!selectedStakeOptions.length) {
    showBottomNotice('Выбери минимум одну ставку');
    return;
  }
  selectedStakeOptions = selectedStakeOptions.slice().sort(function(a, b) { return a - b; });
  function proceed() {
    showScreen('waiting');
    $('hint-text').textContent = 'Идёт поиск по ставкам: ' + selectedStakeOptions.join(', ') + ' TON';
    pvpFindMatch();
  }
  syncMyNameFromServer(proceed);
}

function openDemoIntro() {
  showScreen('demo');
}

function startSearchBot() {
  onlineModeSelected = false;
  isBotMode = true;
  currentStakeTon = null;
  setModeButtonsVisible(true);
  setStakePickerVisible(false);
  function proceed() {
    showScreen('waiting');
    localStartMatch();
  }
  syncMyNameFromServer(proceed);
}

function apiPost(body) {
  return fetch('/api/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(function(r) { return r.json(); });
}

function syncMyNameFromServer(done) {
  function fallback() {
    var u = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user;
    myName = (u && u.first_name) ? String(u.first_name).slice(0, 64) : 'Игрок';
    currentBalanceTon = 0;
    renderStakePicker();
    if (done) done();
  }
  if (!tgInitData) {
    fallback();
    return;
  }
  apiPost({ action: 'authSession', initData: tgInitData })
    .then(function(data) {
      if (data && data.ok && data.user && data.user.display_name) {
        myName = String(data.user.display_name).slice(0, 64);
        currentBalanceTon = Number(data.user.balance || 0);
      } else fallback();
      renderStakePicker();
      if (done) done();
    })
    .catch(function() { fallback(); });
}

function refreshBalanceForStakePicker() {
  if (!tgInitData) return;
  apiPost({ action: 'authSession', initData: tgInitData })
    .then(function(data) {
      if (data && data.ok && data.user) {
        currentBalanceTon = Number(data.user.balance || 0);
        renderStakePicker();
      }
    })
    .catch(function() {});
}

/** Only removes queue row if still waiting (server no-ops for active matches). */
function beaconPvpCancelQueue(roomId) {
  if (!roomId || !tgInitData) return;
  var payload = JSON.stringify({ action: 'pvpCancelQueue', initData: tgInitData, roomId: roomId });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/user', new Blob([payload], { type: 'application/json' }));
    }
  } catch (e) {}
  fetch('/api/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true
  }).catch(function() {});
}

function stopPvpPolling() {
  if (pvpPollTimer) clearInterval(pvpPollTimer);
  pvpPollTimer = null;
  pvpPollInFlight = false;
  pvpPendingSubmit = false;
}

function leavePvpQueue() {
  stopPvpPolling();
  if (!isBotMode && pvpRoomId && tgInitData) {
    try {
      if (navigator && navigator.sendBeacon) {
        var payload = JSON.stringify({ action: 'pvpLeaveRoom', initData: tgInitData, roomId: pvpRoomId });
        var blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/user', blob);
      }
    } catch(e) {}
    fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ action: 'pvpLeaveRoom', initData: tgInitData, roomId: pvpRoomId })
    }).catch(function() {});
  }
  pvpRoomId = null;
}

function resetPvpMarkers() {
  pvpLastRoundMarker = 0;
  pvpLastGameMarker = 0;
  pvpLastSwitchMarker = 0;
  pvpLastTiebreakMarker = 0;
  pvpLastMatchMarker = 0;
  pvpLastTurnKey = '';
}

function pvpFindMatch() {
  if (!tgInitData) {
    $('hint-text').textContent = 'Нет Telegram-сессии. Открой игру через бота.';
    setTimeout(function() { showScreen('start'); }, 1200);
    return;
  }
  stopPvpPolling();
  resetPvpMarkers();
  pvpRecovering = false;
  pvpRoomId = null;
  apiPost({
    action: 'pvpFindMatch',
    initData: tgInitData,
    gameKey: 'frog_hunt',
    playerName: myName,
    stakeOptions: selectedStakeOptions
  }).then(function(data) {
    if (!data || !data.ok || !data.room) throw new Error(data && data.error ? data.error : 'Matchmaking failed');
    pvpRoomId = data.room.id;
    if (String(data.room.status) === 'active' && String(((data.room.state_json || {}).phase || '')) !== 'accept_match') {
      showScreen('game');
    } else {
      showScreen('waiting');
    }
    startPvpPolling();
  }).catch(function() {
    $('hint-text').textContent = 'Не удалось найти матч. Попробуй снова.';
    setTimeout(function() { showScreen('start'); }, 1200);
  });
}

function startPvpPolling() {
  stopPvpPolling();
  pvpPollTimer = setInterval(function() {
    pvpPollState();
  }, PVP_POLL_MS);
  pvpPollState();
}

function pvpPollState() {
  if (!pvpRoomId || !tgInitData || pvpPollInFlight) return;
  pvpPollInFlight = true;
  apiPost({
    action: 'pvpGetRoomState',
    initData: tgInitData,
    roomId: pvpRoomId
  }).then(function(data) {
    if (!data || !data.ok) {
      var err = String((data && data.error) || '');
      if (err === 'ACCEPT_TIMEOUT') {
        stopPvpPolling();
        pvpRoomId = null;
        window.location.href = '/';
        return;
      }
      if (err === 'Room not found' && pvpAcceptDeadlineMs > 0) {
        pvpRoomId = null;
        pvpAcceptDeadlineMs = 0;
        showScreen('waiting');
        showBottomNotice('Пользователь не принял матч');
        pvpFindMatch();
      }
      return;
    }
    if (!data.room) return;
    applyPvpRoomState(data.room);
  }).catch(function() {}).finally(function() {
    pvpPollInFlight = false;
  });
}

function applyPvpRoomState(room) {
  if (!room) return;
  var s = room.state_json || {};
  if (String(room.status) === 'cancelled' || String(room.status) === 'finished') {
    if (String((s || {}).phase || '') === 'accept_match' || String((s || {}).phase || '') === 'accept_timeout') {
      stopPvpPolling();
      pvpRoomId = null;
      pvpAcceptDeadlineMs = 0;
      if ($('accept-modal')) $('accept-modal').style.display = 'none';
      showScreen('waiting');
      showBottomNotice('Пользователь не принял матч');
      pvpFindMatch();
      return;
    }
    stopPvpPolling();
    if (s.leftBy && String(s.leftBy) !== String(tgUserId)) {
      onOpponentLeftVictory(room);
    } else if (String(room.winner_tg_user_id || '') === String(tgUserId) && !!s.endedByLeave) {
      onOpponentLeftVictory(room);
    } else if (!s.endedByLeave) {
      var meIsP1Done = String(room.player1_tg_user_id) === String(tgUserId);
      var myDoneSide = meIsP1Done ? 'p1' : 'p2';
      var oppDoneSide = meIsP1Done ? 'p2' : 'p1';
      var myDoneScore = Number((s.matchScores || {})[myDoneSide] || 0);
      var oppDoneScore = Number((s.matchScores || {})[oppDoneSide] || 0);
      onMatchResult({
        youWon: myDoneScore > oppDoneScore,
        matchScores: [myDoneScore, oppDoneScore]
      });
    } else {
      if (!pvpRecovering) {
        pvpRecovering = true;
        showScreen('waiting');
        setTimeout(function() {
          pvpRecovering = false;
          pvpFindMatch();
        }, 200);
      }
    }
    return;
  }
  if (String(room.status) === 'waiting') {
    if (Array.isArray(selectedStakeOptions) && selectedStakeOptions.length) {
      $('hint-text').textContent = 'Поиск соперника (' + selectedStakeOptions.join(', ') + ' TON)';
    }
    if ($('accept-modal')) $('accept-modal').style.display = 'none';
    pvpAcceptDeadlineMs = 0;
    showScreen('waiting');
    return;
  }
  if (String(room.status) === 'active' && String((s || {}).phase || '') === 'accept_match') {
    var am = s.acceptMatch || {};
    pvpAcceptDeadlineMs = Number(am.deadlineMs || 0);
    if ($('accept-info')) {
      $('accept-info').textContent =
        (room.player1_name || 'Игрок 1') + ' vs ' + (room.player2_name || 'Игрок 2') +
        (room.stake_ton != null ? (' · ' + Number(room.stake_ton) + ' TON') : '');
    }
    $('hint-text').textContent = 'Подтверди матч';
    showScreen('waiting');
    if ($('accept-timer')) $('accept-timer').textContent = Math.max(0, Math.ceil((pvpAcceptDeadlineMs - Date.now()) / 1000)) + 'с';
    if ($('accept-modal')) $('accept-modal').style.display = 'flex';
    return;
  }
  if ($('accept-modal')) $('accept-modal').style.display = 'none';
  var meIsP1 = String(room.player1_tg_user_id) === String(tgUserId);
  var mySide = meIsP1 ? 'p1' : 'p2';
  var oppSide = meIsP1 ? 'p2' : 'p1';
  pvpOpponentTgId = meIsP1 ? String(room.player2_tg_user_id || '') : String(room.player1_tg_user_id || '');
  pvpOpponentIsBot = pvpOpponentTgId.indexOf('bot_fallback_') === 0;
  var myScore = Number((s.matchScores || {})[mySide] || 0);
  var oppScore = Number((s.matchScores || {})[oppSide] || 0);
  matchScores = [myScore, oppScore];
  playerIndex = 0;
  opponentName = meIsP1 ? (room.player2_name || 'Соперник') : (room.player1_name || 'Соперник');
  currentStakeTon = room.stake_ton != null ? Number(room.stake_ton) : null;
  pvpAcceptDeadlineMs = 0;
  if (currentStakeTon != null && isFinite(currentStakeTon)) {
    $('hint-text').textContent = 'Матч на сумму ' + currentStakeTon + ' TON';
  }
  myRole = (s.roles || {})[mySide] || myRole;
  gameNum = Number(s.gameNum || 1);
  currentRound = Number(s.currentRound || 1);
  totalRounds = Number(s.totalRounds || 5);
  totalCells = Number(s.totalCells || 8);
  hunterShots = Number(s.hunterShots || 1);

  showScreen('game');

  var roleAssignedMarker = String(gameNum) + ':' + String(totalRounds) + ':' + String(totalCells) + ':' + String(hunterShots) + ':' + myRole;
  if (window.__pvpRoleMarker !== roleAssignedMarker) {
    window.__pvpRoleMarker = roleAssignedMarker;
    onRoleAssign({
      role: myRole,
      gameNum: gameNum,
      totalRounds: totalRounds,
      totalCells: totalCells,
      hunterShots: hunterShots,
      matchScores: matchScores.slice()
    });
  } else {
    updateHeader();
  }

  if (s.phase === 'turn_input') {
    var turnKey = String(gameNum) + ':' + String(currentRound) + ':' + String(myRole);
    if (turnKey !== pvpLastTurnKey) {
      pvpPendingSubmit = false;
      pvpLastTurnKey = turnKey;
      if (myRole === 'frog') {
        onFrogTurn({
          round: currentRound,
          totalRounds: totalRounds,
          currentCell: s.frogCell,
          isFinal: currentRound === totalRounds
        });
      } else {
        onHunterTurn({
          round: currentRound,
          totalRounds: totalRounds,
          hunterShots: hunterShots,
          isFinal: currentRound === totalRounds
        });
      }
    } else if (moveChosen || pvpPendingSubmit) {
      $('hint-text').textContent = 'Ждём ход соперника...';
    }
    return;
  }

  if (s.phase === 'round_result' && s.lastRoundResult && Number(s.lastRoundResult.marker) > pvpLastRoundMarker) {
    pvpLastRoundMarker = Number(s.lastRoundResult.marker);
    onRoundResult({
      hit: !!s.lastRoundResult.hit,
      frogCell: Number(s.lastRoundResult.frogCell),
      hunterCells: s.lastRoundResult.hunterCells || [],
      round: Number(s.lastRoundResult.round || currentRound),
      totalRounds: Number(s.lastRoundResult.totalRounds || totalRounds),
      isFinal: !!s.lastRoundResult.isFinal
    });
    return;
  }

  if (s.phase === 'game_over' && Number((s.markers || {}).game || 0) > pvpLastGameMarker) {
    pvpLastGameMarker = Number((s.markers || {}).game || 0);
    var winnerRole = (s.lastRoundResult && s.lastRoundResult.winnerRole) || (s.roundHit ? 'hunter' : 'frog');
    var youWon = (myRole === winnerRole);
    onGameOver({
      youWon: youWon,
      yourRole: myRole,
      gameNum: gameNum,
      matchScores: matchScores.slice()
    });
    return;
  }

  if (s.phase === 'switch_roles' && Number((s.markers || {}).switch || 0) > pvpLastSwitchMarker) {
    pvpLastSwitchMarker = Number((s.markers || {}).switch || 0);
    onSwitchRoles();
    return;
  }

  if (s.phase === 'tiebreak_start' && Number((s.markers || {}).tiebreak || 0) > pvpLastTiebreakMarker) {
    pvpLastTiebreakMarker = Number((s.markers || {}).tiebreak || 0);
    onTiebreakStart();
    return;
  }

  if (s.phase === 'match_over' && Number((s.markers || {}).match || 0) > pvpLastMatchMarker) {
    pvpLastMatchMarker = Number((s.markers || {}).match || 0);
    stopPvpPolling();
    if (s.endedByLeave && s.leftBy && String(s.leftBy) !== String(tgUserId)) {
      onOpponentLeftVictory(room);
      return;
    }
    if (s.endedByLeave && s.leftBy && String(s.leftBy) === String(tgUserId)) {
      showScreen('start');
      return;
    }
    onMatchResult({
      youWon: myScore > oppScore,
      matchScores: [myScore, oppScore]
    });
  }
}

function onOpponentLeftVictory(room) {
  hideAllOverlays();
  hideAllFrogs();
  stopTimer();
  showScreen('result');
  var icon = $('final-icon');
  var title = $('final-title');
  var score = $('final-score');
  setUiIcon(icon, 'trophy');
  title.textContent = 'Пользователь покинул игру, вы победили';
  title.className = 'final-title won';
  var s = (room && room.state_json) || {};
  var meIsP1 = String(room && room.player1_tg_user_id || '') === String(tgUserId);
  var mySide = meIsP1 ? 'p1' : 'p2';
  var oppSide = meIsP1 ? 'p2' : 'p1';
  var myScore = Number((s.matchScores || {})[mySide] || 0);
  var oppScore = Number((s.matchScores || {})[oppSide] || 0);
  var baseScoreText = myScore + ' : ' + oppScore;
  if (!isBotMode && Number.isFinite(Number(currentStakeTon)) && Number(currentStakeTon) > 0) {
    var payout = formatTonCompact(Number(currentStakeTon) * 2);
    score.innerHTML = baseScoreText + '<br><span style="font-size:14px;color:#7bf3b0">TON итог: +' + payout + ' TON</span>';
  } else {
    score.textContent = baseScoreText;
  }
  playSound('win');
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

  if (!isBotMode) {
    if (pvpPendingSubmit || !pvpRoomId) return;
    pvpPendingSubmit = true;
    $('hint-text').textContent = 'Ход отправлен. Ждём соперника...';
    var move = myRole === 'frog'
      ? { frogCell: selectedCells[0] }
      : { hunterCells: selectedCells.slice() };
    apiPost({
      action: 'pvpSubmitMove',
      initData: tgInitData,
      roomId: pvpRoomId,
      move: move
    }).then(function(data) {
      pvpPendingSubmit = false;
      if (data && data.ok && data.room) applyPvpRoomState(data.room);
    }).catch(function() {
      pvpPendingSubmit = false;
      moveChosen = false;
      $('btn-confirm').disabled = false;
      $('hint-text').textContent = 'Ошибка отправки хода. Попробуй ещё раз.';
    });
    return;
  }

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
    setUiIcon(icon, 'trophy');
    title.textContent = 'Ты победил!';
    desc.textContent = msg.yourRole === 'hunter' ? 'Отличный выстрел!' : 'Жаба выжила!';
  } else {
    setUiIcon(icon, 'sad');
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
    setUiIcon(icon, 'crown');
    title.textContent = 'ПОБЕДА!';
    title.className = 'final-title won';
    playSound('win');
  } else {
    setUiIcon(icon, 'frog');
    title.textContent = 'Поражение';
    title.className = 'final-title lost';
    playSound('lose');
  }

  var baseScoreText = matchScores[playerIndex] + ' : ' + matchScores[1 - playerIndex];
  if (!isBotMode && Number.isFinite(Number(currentStakeTon)) && Number(currentStakeTon) > 0) {
    var stake = Number(currentStakeTon);
    var tonDelta = msg.youWon ? ('+' + formatTonCompact(stake * 2)) : ('-' + formatTonCompact(stake));
    var tonColor = msg.youWon ? '#7bf3b0' : '#ff8b8b';
    score.innerHTML = baseScoreText + '<br><span style="font-size:14px;color:' + tonColor + '">TON итог: ' + tonDelta + ' TON</span>';
  } else {
    score.textContent = baseScoreText;
  }
  if (isBotMode) saveMatchToBackend(msg.youWon);
}

function formatTonCompact(n) {
  var x = Number(n || 0);
  if (!isFinite(x)) return '0';
  var s = x.toFixed(9).replace(/\.?0+$/, '');
  return s;
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
  playSound('hide');
  $('hint-text').textContent = 'Охотник целится...';

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
    afterShoot();
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
  resolveFn();
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
  $('role-label').textContent = myRole === 'frog' ? 'Жаба' : 'Охотник';
}
