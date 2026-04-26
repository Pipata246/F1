// ==================== SUPABASE REALTIME ====================
var supabase = null;
var supabaseChannel = null;

function initSupabase() {
  var SUPABASE_URL = 'https://eolycsnxboeobasolczb.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbHljc254Ym9lb2Jhc29sY3piIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3Njg0NTQsImV4cCI6MjA5MTM0NDQ1NH0.EVU6xdTy1S_9y5fgq4-AJJQHO-WPlNu3bFHgG617eJA';
  
  if (typeof window.supabase === 'undefined') {
    console.error('Supabase library not loaded!');
    return;
  }
  
  try {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('✅ Supabase Realtime initialized for Obstacle Race');
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
  
  console.log('🔌 Starting Realtime WebSocket for obstacle race room:', roomId);
  
  var channelName = 'obstacle_race_room_' + roomId;
  
  supabaseChannel = supabase
    .channel(channelName)
    .on(
      'broadcast',
      { event: 'state_update' },
      function(payload) {
        console.log('📡 WebSocket update received:', payload);
        if (payload.payload && payload.payload.room) {
          var myTg = String(window._tgUserId || '');
          var forPlayer = payload.payload.forPlayer;
          if (!forPlayer || forPlayer === myTg) {
            applyPvpRoomState(payload.payload.room);
          }
        }
      }
    )
    .subscribe(function(status) {
      console.log('WebSocket status:', status);
      if (status === 'SUBSCRIBED') {
        console.log('✅ WebSocket connected! Fetching current state...');
        // WebSocket подключился — запрашиваем актуальное состояние ОДИН РАЗ
        // чтобы не пропустить broadcast который пришёл пока подключались
        pvpPollState();
      }
    });
}

// ==================== GAME VARIABLES ====================
let ws = null;
let playerIndex = -1;
let opponentName = '';
let myName = '';
let selectedTraps = [];
let scores = [0, 0];
let currentStep = 0;
let totalRounds = 7;
let moveChosen = false;
let timerInterval = null;
let isOvertime = false;
let trackDots = 7;

// Abilities
let myAbility = null;
let oppAbility = null;
let abilityUsed = false;
let abilityActive = false;
let revealedPoints = {};
let xrayScanMode = false;
let knownTrapsOnMyTrack = {};
let myUsedXrayThisRound = false;  // я использовал рентген в этом раунде
let oppUsedXrayThisRound = false; // соперник использовал рентген в этом раунде
let overtimePlacing = false;
let trapsConfirmed = false;
let trapTimerInterval = null;
let myOvertimeTraps = [];
let roundAnimating = false; // флаг: идёт анимация раунда, не обновляем счёт
let gameOverSoundPlayed = false; // флаг: звук конца игры уже сыгран
let tgInitData = '';
let localMatch = null;
let matchSaved = false;
let isBotMode = true;
let selectedStakeOptions = [];
let currentStakeTon = null;
const ALLOWED_STAKES = [0.1, 0.5, 1, 5, 10, 25];
let currentBalanceTon = 0;
let bottomNoticeTimer = null;
let pvpServerSkewMs = 0;
// Obstacle race server forces moves after 15s in PvP; keep UI in sync.
const TURN_MS = 15_000;
let onlineModeSelected = false;
let pvpAcceptDeadlineMs = 0;
let pvpAcceptTickInterval = null; // локальный тик таймера accept_match
let pvpWaitingFallbackTimer = null; // резерв (не используется)
let pvpRoomId = null;
let pvpPollTimer = null;
let pvpPollInFlight = false;
let pvpLastRoundMarker = 0;
let pvpLastXrayMarker = 0;
let pvpLastStartKey = '';
let pvpOpponentTgId = '';
let pvpOpponentIsBot = false;
let pvpMoveWatchdogTimer = null; // повторяющийся watchdog пока ждём round_result
const SETTINGS_KEY = "f1duel_global_settings_v1";
// Legacy constants (not used with WebSocket)
// const PVP_POLL_MS = 900;
// const PVP_POLL_FAST_MS = 500;

const OT_ROUNDS = 3;

const ABILITIES = {
    xray:     { icon: '\uD83D\uDC41', name: '\u0420\u0435\u043D\u0442\u0433\u0435\u043D', desc: '\u041F\u043E\u0434\u0441\u043C\u043E\u0442\u0440\u0438 \u043E\u0434\u043D\u0443 \u0442\u043E\u0447\u043A\u0443 \u043D\u0430 \u0434\u043E\u0440\u043E\u0436\u043A\u0435' },
    double:   { icon: '\u26A1', name: '\u0423\u0434\u0432\u043E\u0435\u043D\u0438\u0435', desc: '\u0423\u0441\u043F\u0435\u0445 = +2 \u043E\u0447\u043A\u0430. \u041F\u0440\u043E\u0432\u0430\u043B = -1 \u043E\u0447\u043A\u043E' },
    sabotage: { icon: '\uD83D\uDC80', name: '\u0421\u0430\u0431\u043E\u0442\u0430\u0436', desc: '\u041E\u0442\u043C\u0435\u043D\u0438 \u043E\u0447\u043A\u043E \u0441\u043E\u043F\u0435\u0440\u043D\u0438\u043A\u0430. \u041F\u0440\u043E\u043C\u0430\u0445 \u2014 \u0431\u0435\u0437 \u0448\u0442\u0440\u0430\u0444\u0430' }
};

const $ = (id) => document.getElementById(id);

const SFX = {};
function initSounds() {
    const files = {
        click: 'Click Or Tap.mp3',
        tap: 'Tap or Pop.mp3',
        swoosh: 'Quick_Swoosh.mp3',
        swooshBig: 'Normal_Swoosh.mp3',
        ping: 'Pi-Link.mp3',
        good: 'Positive_Reaction.mp3',
        bad: 'Negative_Reaction.mp3',
        win: 'You_Won.mp3',
        lose: 'You_Lost.mp3'
    };
    for (const [key, file] of Object.entries(files)) {
        SFX[key] = new Audio('sounds/' + file);
        SFX[key].preload = 'auto';
        SFX[key].volume = 0.5;
    }
    SFX.win.volume = 0.7;
    SFX.lose.volume = 0.7;
}

function playSound(name) {
    try {
        const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        if (settings.sound === false) return;
    } catch (e) {}
    const s = SFX[name];
    if (!s) return;
    s.currentTime = 0;
    s.play().catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
    // Initialize Supabase Realtime
    initSupabase();
    
    initSounds();
    if (window.Telegram && window.Telegram.WebApp) {
        const tg = window.Telegram.WebApp;
        tg.ready(); tg.expand();
        document.body.classList.add('tg-theme');
        const user = tg.initDataUnsafe && tg.initDataUnsafe.user;
        if (user) {
            window._tgUserId = String(user.id);
        }
        tgInitData = tg.initData || '';
    }
    // Also check URL param (passed from F1 Duel)
    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('userId')) window._tgUserId = urlParams.get('userId');

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
    startPresenceLoop();

    if ($('btn-find')) $('btn-find').onclick = () => startGame(false);
    if ($('btn-bot')) $('btn-bot').onclick = () => openDemoIntro();
    if ($('btn-demo-play')) $('btn-demo-play').onclick = () => startGame(true);
    if ($('btn-demo-back')) $('btn-demo-back').onclick = () => window.location.href = '/';
    ensureStakePicker();
    setStakePickerVisible(false);
    refreshBalanceForStakePicker();
    $('btn-cancel').onclick = cancelWait;
    $('btn-traps-ok').onclick = confirmTraps;
    $('btn-again').onclick = () => {
        // Мгновенный отклик — сразу показываем экран ожидания
        showScreen('waiting');
        setTimeout(() => startGame(isBotMode), 50);
    };
    $('btn-menu').onclick = () => window.location.href = '/';
    $('btn-run').onclick = () => makeMove('run');
    $('btn-jump').onclick = () => makeMove('jump');
    $('btn-ability').onclick = toggleAbility;
    window.addEventListener('pagehide', function() {
        presenceLeaveNet();
        if (!isBotMode && pvpRoomId && tgInitData) {
            beaconPvpLeaveRoom(pvpRoomId);
        }
    });
    window.addEventListener('beforeunload', function() {
        presenceLeaveNet();
        if (!isBotMode && pvpRoomId && tgInitData) {
            beaconPvpLeaveRoom(pvpRoomId);
        }
    });

    generateTrapTrack();
    generateGameTracks(7);

    const launchMode = String(urlParams.get('launch') || '').toLowerCase();
    if (launchMode === 'demo') {
        setTimeout(() => openDemoIntro(), 0);
    } else if (launchMode === 'play') {
        const directRoomId = urlParams.get('roomId');
        if (directRoomId) {
            // Случайная игра — подключаемся напрямую к комнате
            setTimeout(function() {
                isBotMode = false;
                pvpRoomId = String(directRoomId);
                // Восстанавливаем ставку из URL для кнопки "Играть снова"
                const stakeFromUrl = Number(urlParams.get('stake') || 0);
                if (stakeFromUrl > 0 && selectedStakeOptions.indexOf(stakeFromUrl) < 0) {
                    selectedStakeOptions = [stakeFromUrl];
                }
                syncMyNameFromServer(function() {
                    showScreen('waiting');
                    startPvpPolling();
                });
            }, 0);
        } else {
            setTimeout(() => startGame(false), 0);
        }
    } else {
        window.location.href = '/';
    }
});

function openDemoIntro() {
    showScreen('demo');
}

function connect(cb) {
    // WebSocket connection is handled by Supabase Realtime, no need for manual connection
    if (cb) cb();
}

function apiPost(payload) {
    return fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
    }).then(function(r) { return r.json(); });
}

function syncMyNameFromServer(done) {
    function fallback() {
        var u = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user;
        myName = (u && u.first_name) ? String(u.first_name).slice(0, 64) : '\u0418\u0433\u0440\u043E\u043A';
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

function ensureStakePicker() {
    var mount = $('screen-start');
    if (!mount || $('stakePickerObstacle')) return;
    var wrap = document.createElement('div');
    wrap.id = 'stakePickerObstacle';
    wrap.style.marginTop = '12px';
    wrap.style.maxWidth = '360px';
    wrap.style.marginLeft = 'auto';
    wrap.style.marginRight = 'auto';
    wrap.innerHTML =
        '<div style="font-size:12px;color:#aab1bf;margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em;text-align:center;width:100%">Выбери ставки TON</div>' +
        '<div id="stakeGridObstacle" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px"></div>' +
        '<button type="button" id="stakePlayBtnObstacle" class="btn primary" style="margin-top:10px">Играть</button>';
    mount.appendChild(wrap);
    var grid = $('stakeGridObstacle');
    ALLOWED_STAKES.forEach(function(stake) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ghost';
        b.dataset.stake = String(stake);
        b.style.aspectRatio = '1/1';
        b.style.padding = '0';
        b.style.fontWeight = '900';
        b.style.fontSize = '13px';
        b.textContent = stake + ' TON';
        b.onclick = function() {
            var n = Number(b.dataset.stake);
            if (currentBalanceTon < n) {
                showBottomNotice('У вас недостаточно денег на балансе');
                return;
            }
            if (selectedStakeOptions.indexOf(n) >= 0) selectedStakeOptions = selectedStakeOptions.filter(function(x) { return x !== n; });
            else selectedStakeOptions.push(n);
            renderStakePicker();
        };
        grid.appendChild(b);
    });
    var playBtn = $('stakePlayBtnObstacle');
    if (playBtn) playBtn.onclick = function(){ beginOnlineSearch(); };
    renderStakePicker();
}

function setStakePickerVisible(v) {
    var wrap = $('stakePickerObstacle');
    if (!wrap) return;
    wrap.style.display = v ? 'block' : 'none';
}

function renderStakePicker() {
    var grid = $('stakeGridObstacle');
    if (!grid) return;
    var nodes = grid.querySelectorAll('button[data-stake]');
    for (var i = 0; i < nodes.length; i++) {
        var b = nodes[i];
        var n = Number(b.dataset.stake);
        var on = selectedStakeOptions.indexOf(n) >= 0;
        var blocked = currentBalanceTon < n;
        b.style.borderColor = blocked ? 'rgba(248,113,113,.8)' : (on ? '#8fd1ff' : 'rgba(255,255,255,.18)');
        b.style.background = blocked ? 'rgba(239,68,68,.18)' : (on ? 'rgba(59,130,246,.25)' : 'rgba(255,255,255,.08)');
        b.style.color = blocked ? '#fecaca' : (on ? '#e6f3ff' : '#fff');
        b.style.opacity = blocked ? '0.85' : '1';
    }
}

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

function beaconPvpLeaveRoom(roomId) {
    if (!roomId || !tgInitData) return;
    var payload = JSON.stringify({ action: 'pvpLeaveRoom', initData: tgInitData, roomId: roomId });
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
    stopRealtimeSubscription();
    pvpPollTimer = null;
    pvpPollInFlight = false;
    stopMoveWatchdog();
}

function stopWaitingFallbackPolling() {}
function stopTrapsWaitPolling() {}
function startWaitingFallbackPolling() {}
function startTrapsWaitPolling() {}

function stopMoveWatchdog() {
    if (pvpMoveWatchdogTimer) { clearInterval(pvpMoveWatchdogTimer); pvpMoveWatchdogTimer = null; }
}

function startMoveWatchdog() {
    stopMoveWatchdog();
    var ticks = 0;
    pvpMoveWatchdogTimer = setInterval(function() {
        if (!moveChosen || !pvpRoomId || !tgInitData) { stopMoveWatchdog(); return; }
        ticks++;
        // Каждые 3 сек делаем fallback запрос пока ждём round_result (на случай если WebSocket не работает)
        if (ticks % 3 === 0) {
            pvpPollState();
        }
        // После 30 сек (10 тиков) — переключаемся на нормальный режим
        if (ticks >= 10) stopMoveWatchdog();
    }, 3000);
}

function startPvpPolling() {
    // Start WebSocket subscription instead of polling
    if (pvpRoomId) {
        startRealtimeSubscription(pvpRoomId);
    }
}

function startPvpPollingFast() {
    // WebSocket is already fast, no need for separate fast polling
    if (pvpRoomId && !supabaseChannel) {
        startRealtimeSubscription(pvpRoomId);
    }
}

function resetPvpMarkers() {
    pvpLastRoundMarker = 0;
    pvpLastXrayMarker = 0;
    pvpLastStartKey = '';
}

function getPvpSides(room) {
    var meIsP1 = String(room && room.player1_tg_user_id || '') === String(window._tgUserId || '');
    return {
        meIsP1: meIsP1,
        mySide: meIsP1 ? 'p1' : 'p2',
        oppSide: meIsP1 ? 'p2' : 'p1',
        playerIndex: meIsP1 ? 0 : 1
    };
}

function stopAcceptTick() {
    if (pvpAcceptTickInterval) { clearInterval(pvpAcceptTickInterval); pvpAcceptTickInterval = null; }
}

function startAcceptTick() {
    stopAcceptTick();
    function tick() {
        var nowServer = Date.now() - (Number(pvpServerSkewMs || 0));
        var remaining = Math.max(0, Math.ceil((pvpAcceptDeadlineMs - nowServer) / 1000));
        if ($('accept-timer')) $('accept-timer').textContent = remaining + 'с';
        if (remaining <= 0) {
            stopAcceptTick();
            // WebSocket принесёт следующую фазу — ничего не делаем
        }
    }
    tick();
    pvpAcceptTickInterval = setInterval(tick, 200);
}

function applyPvpRoomState(room) {
    if (!room) return;
    var s = room.state_json || {};
    var status = String(room.status || '');
    var phase = String((s || {}).phase || '');

    // ── ACCEPT MATCH ──────────────────────────────────────────────────────────
    if (status === 'active' && phase === 'accept_match') {
        var am = s.acceptMatch || {};
        pvpAcceptDeadlineMs = Number(am.deadlineMs || 0);
        if ($('accept-info')) {
            $('accept-info').textContent =
                (room.player1_name || 'Игрок 1') + ' vs ' + (room.player2_name || 'Игрок 2') +
                (room.stake_ton != null ? (' · ' + Number(room.stake_ton) + ' TON') : '');
        }
        showScreen('waiting');
        startAcceptTick();
        if ($('accept-modal')) $('accept-modal').style.display = 'flex';
        return;
    }

    // ── WAITING (ещё нет соперника) ───────────────────────────────────────────
    if (status === 'waiting') {
        stopAcceptTick();
        if ($('accept-modal')) $('accept-modal').style.display = 'none';
        pvpAcceptDeadlineMs = 0;
        showScreen('waiting');
        return;
    }

    // ── ACCEPT TIMEOUT / отмена ───────────────────────────────────────────────
    if (status === 'cancelled' || (status === 'active' && phase === 'accept_timeout')) {
        stopPvpPolling();
        pvpRoomId = null;
        pvpAcceptDeadlineMs = 0;
        if ($('accept-modal')) $('accept-modal').style.display = 'none';
        showScreen('waiting');
        showBottomNotice('Пользователь не принял матч');
        pvpFindMatch();
        return;
    }

    // ── Игра активна ──────────────────────────────────────────────────────────
    stopAcceptTick();
    if ($('accept-modal')) $('accept-modal').style.display = 'none';

    var sides = getPvpSides(room);
    playerIndex = sides.playerIndex;
    opponentName = sides.meIsP1 ? (room.player2_name || 'Соперник') : (room.player1_name || 'Соперник');
    pvpOpponentTgId = sides.meIsP1 ? String(room.player2_tg_user_id || '') : String(room.player1_tg_user_id || '');
    pvpOpponentIsBot = pvpOpponentTgId.indexOf('bot_fallback_') === 0;
    currentStakeTon = room.stake_ton != null ? Number(room.stake_ton) : null;
    pvpAcceptDeadlineMs = 0;
    if ($('opp-name-traps')) {
        $('opp-name-traps').textContent = currentStakeTon != null && isFinite(currentStakeTon)
            ? ('Дорожка: ' + opponentName + ' · ' + currentStakeTon + ' TON')
            : ('Дорожка: ' + opponentName);
    }

    // ── PLACING TRAPS ─────────────────────────────────────────────────────────
    if (phase === 'placing_traps' || phase === 'placing' || phase === 'overtime_placing') {
        // Если уже подтвердили — просто ждём, не трогаем экран
        if (trapsConfirmed) return;
        // Показываем экран ловушек только если ещё не показан
        if (!$('screen-traps').classList.contains('active')) {
            var isOt = phase === 'overtime_placing';
            overtimePlacing = isOt;
            selectedTraps = [];
            trapsConfirmed = false;
            if (isOt) {
                myOvertimeTraps = [];
                var otAbilities = s.overtimeAbilities || {};
                var myOtAbility = otAbilities[sides.mySide] || null;
                if (myOtAbility) { myAbility = myOtAbility; abilityUsed = false; }
            }
            generateTrapTrack();
            updateTrapUI();
            $('btn-traps-ok').classList.remove('hidden');
            $('btn-traps-ok').disabled = true;
            $('traps-wait').classList.add('hidden');
            showScreen('traps');
            startTrapTimer();
        }
        return;
    }

    // ── Вышли из placing — сбрасываем флаг ───────────────────────────────────
    if (trapsConfirmed) {
        trapsConfirmed = false;
        stopTrapTimer();
    }

    // ── MATCH OVER / FINISHED ─────────────────────────────────────────────────
    if (phase === 'match_over' || status === 'finished') {
        stopPvpPolling();
        pvpRoomId = null;
        if (s.endedByLeave && s.leftBy && String(s.leftBy) !== String(window._tgUserId || '')) {
            onOpponentLeft();
            return;
        }
        var fin = s.scores || {};
        var myFinalScore = Number(fin[sides.mySide] || 0);
        var oppFinalScore = Number(fin[sides.oppSide] || 0);
        var winner = null;
        if (s.winnerSide) winner = s.winnerSide === sides.mySide ? 'win' : 'lose';
        else if (myFinalScore !== oppFinalScore) winner = myFinalScore > oppFinalScore ? 'win' : 'lose';
        showGameOver(winner, [myFinalScore, oppFinalScore]);
        return;
    }

    // ── XRAY ──────────────────────────────────────────────────────────────────
    var xray = s.lastXray || {};
    var xrayMarker = Number(xray.marker || 0);
    if (xrayMarker > pvpLastXrayMarker) {
        pvpLastXrayMarker = xrayMarker;
        if (xray.bySide === sides.mySide) onXrayResult({ point: xray.point, hasTrap: !!xray.hasTrap });
        else onOppXray({ point: xray.point });
    }

    // ── ROUND RESULT ──────────────────────────────────────────────────────────
    var rr = s.lastRoundResult || {};
    var roundMarker = Number(rr.marker || 0);
    if (roundMarker > pvpLastRoundMarker) {
        pvpLastRoundMarker = roundMarker;
        var my = rr.result ? rr.result[sides.mySide] : null;
        var opp = rr.result ? rr.result[sides.oppSide] : null;
        if (my && opp) {
            var rrScores = rr.scores || {};
            onRoundResult({
                you: my,
                opponent: opp,
                step: Number(rr.step || 0),
                myScore: Number(rrScores[sides.mySide] || 0),
                oppScore: Number(rrScores[sides.oppSide] || 0),
                winner: rr.gameOver ? (rr.winnerSide === sides.mySide ? 'win' : 'lose') : null,
                gameOver: !!rr.gameOver,
                round: Number(rr.round || 0),
                totalRounds: 7,
                playerIndex: sides.playerIndex,
                overtime: !!rr.overtime,
                startOvertime: !!rr.startOvertime,
                // phaseAtMs НЕ передаём — следующий раунд придёт через WebSocket с правильным phaseAtMs
                phaseAtMs: null,
            });
            return;
        }
    }

    // ── RUNNING (новый раунд) ─────────────────────────────────────────────────
    if (phase === 'running') {
        var step = s.overtime ? Number(s.overtimeRound || 0) : Number(s.currentStep || 0);
        var startKey = String(!!s.overtime) + ':' + String(step);
        if (startKey !== pvpLastStartKey) {
            pvpLastStartKey = startKey;
            moveChosen = false;
            roundAnimating = false;
            var abilityForRound = s.overtime
                ? ((s.overtimeAbilities || {})[sides.mySide] || null)
                : ((s.abilities || {})[sides.mySide] || null);
            // phaseAtMs с сервера — для точной синхронизации таймера
            onRoundStart({ step: step, ability: abilityForRound, overtime: !!s.overtime, phaseAtMs: Number(s.phaseAtMs || 0) });
        }
        return;
    }
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
        if (typeof data.serverNowMs === 'number' && isFinite(Number(data.serverNowMs))) {
            pvpServerSkewMs = Date.now() - Number(data.serverNowMs);
        }
        if (!data.room) return;
        applyPvpRoomState(data.room);
    }).catch(function() {
        // При ошибке сети — не спамим, просто ждём следующего интервала
    }).finally(function() {
        pvpPollInFlight = false;
    });
}

function pvpFindMatch() {
    if (!tgInitData) {
        showScreen('start');
        return;
    }
    resetPvpMarkers();
    pvpRoomId = null;
    apiPost({
        action: 'pvpFindMatch',
        initData: tgInitData,
        gameKey: 'obstacle_race',
        playerName: myName,
        stakeOptions: selectedStakeOptions
    }).then(function(data) {
        if (!data || !data.ok || !data.room) throw new Error('Matchmaking failed');
        pvpRoomId = data.room.id;
        startPvpPolling();
        applyPvpRoomState(data.room);
    }).catch(function() {
        showScreen('start');
    });
}

function pvpLeaveRoomSafe() {
    if (!pvpRoomId || !tgInitData) {
        pvpRoomId = null;
        return Promise.resolve();
    }
    var rid = pvpRoomId;
    pvpRoomId = null;
    return apiPost({
        action: 'pvpLeaveRoom',
        initData: tgInitData,
        roomId: rid
    }).catch(function() {});
}

function sendMsg(m) {
    var msg = m || {};
    if (isBotMode) {
        localServerOnClientMessage(msg);
        return;
    }
    if (!pvpRoomId || !tgInitData) return;
    if (msg.type === 'place_traps') {
        var trapAttempts = 0;
        var trapData = msg.traps || [];
        function submitTraps() {
            trapAttempts++;
            apiPost({
                action: 'pvpSubmitMove',
                initData: tgInitData,
                roomId: pvpRoomId,
                move: { traps: trapData }
            }).then(function(data) {
                if (data && data.ok && data.room) {
                    applyPvpRoomState(data.room);
                } else if (trapAttempts < 3) {
                    setTimeout(submitTraps, 800);
                } else {
                    // После 3 попыток — разблокируем и показываем ошибку
                    trapsConfirmed = false;
                    $('btn-traps-ok').classList.remove('hidden');
                    $('traps-wait').classList.add('hidden');
                    showBottomNotice('Ошибка отправки ловушек. Попробуй ещё раз.');
                }
            }).catch(function(err) {
                var errorMsg = String((err && err.message) || '');
                
                // Check if error is about waiting for opponent
                if (errorMsg.includes('Waiting for opponent') || errorMsg.includes('Room is not active')) {
                    // Show waiting message and keep trying
                    showBottomNotice('Ждем соперника...');
                    if (trapAttempts < 10) { // Increase retry limit for waiting
                        setTimeout(submitTraps, 2000); // Longer delay when waiting
                    } else {
                        trapsConfirmed = false;
                        $('btn-traps-ok').classList.remove('hidden');
                        $('traps-wait').classList.add('hidden');
                        showBottomNotice('Соперник не подключился. Попробуй ещё раз.');
                    }
                } else {
                    // Other errors - normal retry logic
                    if (trapAttempts < 3) {
                        setTimeout(submitTraps, 800);
                    } else {
                        trapsConfirmed = false;
                        $('btn-traps-ok').classList.remove('hidden');
                        $('traps-wait').classList.add('hidden');
                        showBottomNotice('Ошибка отправки ловушек. Попробуй ещё раз.');
                    }
                }
            });
        }
        submitTraps();
        return;
    }
    if (msg.type === 'xray_scan') {
        var xrayAttempts = 0;
        var xrayPoint = Number(msg.point || 0);
        function submitXray() {
            xrayAttempts++;
            apiPost({
                action: 'pvpSubmitMove',
                initData: tgInitData,
                roomId: pvpRoomId,
                move: { type: 'xray_scan', point: xrayPoint }
            }).then(function(data) {
                if (data && data.ok && data.room) {
                    applyPvpRoomState(data.room);
                } else if (xrayAttempts < 3) {
                    setTimeout(submitXray, 800);
                }
            }).catch(function() {
                if (xrayAttempts < 3) setTimeout(submitXray, 800);
            });
        }
        submitXray();
        return;
    }
    if (msg.type === 'make_move') {
        var moveAction = msg.action;
        var moveAbility = !!msg.useAbility;
        var moveAttempts = 0;

        function submitMove() {
            moveAttempts++;
            apiPost({
                action: 'pvpSubmitMove',
                initData: tgInitData,
                roomId: pvpRoomId,
                move: { action: moveAction, useAbility: moveAbility }
            }).then(function(data) {
                if (data && data.ok && data.room) {
                    applyPvpRoomState(data.room);
                } else if (moveAttempts < 3) {
                    // Retry через 800мс если ответ не ok
                    setTimeout(submitMove, 800);
                } else {
                    // После 3 попыток разблокируем кнопки
                    moveChosen = false;
                    $('btn-run').disabled = false;
                    $('btn-jump').disabled = false;
                    $('move-wait').classList.add('hidden');
                }
            }).catch(function() {
                if (moveAttempts < 3) {
                    setTimeout(submitMove, 800);
                } else {
                    moveChosen = false;
                    $('btn-run').disabled = false;
                    $('btn-jump').disabled = false;
                    $('move-wait').classList.add('hidden');
                }
            });
        }

        submitMove();

        // Переключаемся на WebSocket режим (уже активен)
        // WebSocket обеспечивает моментальные обновления

        // Watchdog: повторяем poll каждые 3 сек пока moveChosen=true
        startMoveWatchdog();
    }
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'waiting': showScreen('waiting'); break;
        case 'game_found': onGameFound(msg); break;
        case 'traps_placed': break;
        case 'traps_auto':
            showBottomNotice('Ловушки расставлены автоматически');
            break;
        case 'round_start': return onRoundStart(msg);
        case 'round_result': return onRoundResult(msg);
        case 'overtime_start': onOvertimeStart(msg); break;
        case 'xray_result': onXrayResult(msg); break;
        case 'opp_xray': onOppXray(msg); break;
        case 'opponent_left': onOpponentLeft(); break;
    }
}

function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $('screen-' + name).classList.add('active');
    if (name !== 'waiting') {
        if ($('accept-modal')) $('accept-modal').style.display = 'none';
        pvpAcceptDeadlineMs = 0;
    }
    if (name === 'start') {
        onlineModeSelected = false;
        if ($('btn-find')) $('btn-find').style.display = '';
        if ($('btn-bot')) $('btn-bot').style.display = '';
        setStakePickerVisible(false);
    }
}

function startGame(vsBot) {
    selectedTraps = []; scores = [0, 0]; currentStep = 0;
    moveChosen = false; isOvertime = false; trackDots = 7;
    myAbility = null; oppAbility = null; abilityUsed = false; abilityActive = false;
    revealedPoints = {}; xrayScanMode = false; knownTrapsOnMyTrack = {};
    myUsedXrayThisRound = false; oppUsedXrayThisRound = false;
    trapsConfirmed = false; myOvertimeTraps = []; stopTrapTimer();
    roundAnimating = false; gameOverSoundPlayed = false;
    clearInterval(timerInterval);
    matchSaved = false;
    stopMoveWatchdog();
    isBotMode = !!vsBot;
    if (!isBotMode && !onlineModeSelected) {
        onlineModeSelected = true;
        if ($('btn-find')) $('btn-find').style.display = 'none';
        if ($('btn-bot')) $('btn-bot').style.display = 'none';
        setStakePickerVisible(true);
        refreshBalanceForStakePicker();
        showBottomNotice('Выбери ставку и нажми "Играть"');
        return;
    }
    if (isBotMode) {
        onlineModeSelected = false;
        if ($('btn-find')) $('btn-find').style.display = '';
        if ($('btn-bot')) $('btn-bot').style.display = '';
        setStakePickerVisible(false);
    }
    currentStakeTon = null;
    if (!isBotMode) return beginOnlineSearch();
    stopPvpPolling();
    pvpRoomId = null;
    syncMyNameFromServer(function() {
        connect(function() {
            if (isBotMode) {
                sendMsg({
                    type: 'find_bot',
                    name: myName,
                    tgUserId: window._tgUserId || null
                });
                showScreen('waiting');
                return;
            }
            pvpFindMatch();
        });
    });
}

function beginOnlineSearch() {
    isBotMode = false;
    currentStakeTon = null;
    if (!selectedStakeOptions.length) {
        showBottomNotice('Выбери минимум одну ставку');
        return;
    }
    selectedStakeOptions = selectedStakeOptions.slice().sort(function(a, b) { return a - b; });
    stopPvpPolling();
    pvpRoomId = null;
    // Сразу показываем экран ожидания — не ждём ответа от сервера
    showScreen('waiting');
    syncMyNameFromServer(function() {
        connect(function() { pvpFindMatch(); });
    });
}

function cancelWait() {
    if (isBotMode) {
        localMatch = null;
        window.location.href = '/';
        return;
    }
    stopAcceptTick();
    stopPvpPolling();
    pvpLeaveRoomSafe().finally(function() { window.location.href = '/'; });
}

function onGameFound(msg) {
    playSound('ping');
    playerIndex = msg.playerIndex;
    opponentName = msg.opponent;
    $('opp-name-traps').textContent = '\u0414\u043E\u0440\u043E\u0436\u043A\u0430: ' + opponentName;
    selectedTraps = [];
    trapsConfirmed = false;
    overtimePlacing = false;
    updateTrapUI();
    $('btn-traps-ok').classList.remove('hidden');
    $('btn-traps-ok').disabled = true;
    $('traps-wait').classList.add('hidden');
    scores = [0, 0];
    currentStep = 0;
    isOvertime = false;
    showScreen('traps');
    startTrapTimer();
}

function generateTrapTrack() {
    const dots = overtimePlacing ? OT_ROUNDS : 7;
    const c = $('trap-track'); c.innerHTML = '';
    for (let i = 0; i < dots; i++) {
        const p = document.createElement('div');
        p.className = 'trap-point'; p.textContent = i + 1;
        p.dataset.index = i; p.onclick = () => toggleTrap(i);
        c.appendChild(p);
    }
    const maxTraps = overtimePlacing ? 1 : 3;
    $('trap-count').parentElement.innerHTML = '\u041B\u043E\u0432\u0443\u0448\u0435\u043A: <span id="trap-count" class="count-num">0</span> / ' + maxTraps;
}

function toggleTrap(i) {
    if (trapsConfirmed) return; // заблокировано после подтверждения
    const maxTraps = overtimePlacing ? 1 : 3;
    const idx = selectedTraps.indexOf(i);
    if (idx >= 0) selectedTraps.splice(idx, 1);
    else if (selectedTraps.length < maxTraps) selectedTraps.push(i);
    playSound('tap');
    updateTrapUI();
}

function updateTrapUI() {
    const maxTraps = overtimePlacing ? 1 : 3;
    document.querySelectorAll('.trap-point').forEach((p) => {
        const idx = parseInt(p.dataset.index);
        const isSelected = selectedTraps.includes(idx);
        p.classList.toggle('selected', isSelected);
        p.textContent = isSelected ? '\uD83D\uDEA7' : (idx + 1);
    });
    $('trap-count').textContent = selectedTraps.length;
    $('btn-traps-ok').disabled = selectedTraps.length !== maxTraps;
}

function stopTrapTimer() {
    if (trapTimerInterval) { clearInterval(trapTimerInterval); trapTimerInterval = null; }
    var timerEl = $('trap-timer');
    if (timerEl) timerEl.style.display = 'none';
}

function startTrapTimer() {
    // Не запускаем если уже подтвердили ловушки
    if (trapsConfirmed) return;
    // Не перезапускаем если таймер уже идёт
    if (trapTimerInterval) return;
    stopTrapTimer();
    var maxTraps = overtimePlacing ? 1 : 3;
    var totalSec = 20; // 20 секунд на расстановку
    var remaining = totalSec;

    // Создаём элемент таймера если нет
    var timerEl = $('trap-timer');
    if (!timerEl) {
        timerEl = document.createElement('div');
        timerEl.id = 'trap-timer';
        timerEl.style.cssText = 'text-align:center;font-size:13px;color:#aab1bf;margin-top:8px;';
        var trapsOkBtn = $('btn-traps-ok');
        if (trapsOkBtn && trapsOkBtn.parentElement) {
            trapsOkBtn.parentElement.insertBefore(timerEl, trapsOkBtn.nextSibling);
        }
    }
    timerEl.style.display = 'block';
    timerEl.textContent = 'Авто-расстановка через ' + remaining + 'с';

    trapTimerInterval = setInterval(function() {
        remaining--;
        if (timerEl) timerEl.textContent = 'Авто-расстановка через ' + remaining + 'с';
        if (remaining <= 0) {
            stopTrapTimer();
            if (trapsConfirmed) return;
            // Автоматически добираем ловушки до нужного количества
            var needed = overtimePlacing ? 1 : 3;
            var dots = overtimePlacing ? 3 : 7;
            while (selectedTraps.length < needed) {
                var r = Math.floor(Math.random() * dots);
                if (!selectedTraps.includes(r)) selectedTraps.push(r);
            }
            updateTrapUI();
            confirmTraps();
        }
    }, 1000);
}

function confirmTraps() {
    if (trapsConfirmed) return; // защита от двойного вызова
    playSound('click');
    trapsConfirmed = true;
    stopTrapTimer();
    if (overtimePlacing) myOvertimeTraps = selectedTraps.slice();
    sendMsg({ type: 'place_traps', traps: selectedTraps });
    $('btn-traps-ok').classList.add('hidden');
    $('traps-wait').classList.remove('hidden');
    document.querySelectorAll('.trap-point').forEach((p) => {
        p.onclick = null;
        p.style.pointerEvents = 'none';
        p.style.opacity = '0.6';
    });
}

function generateGameTracks(n) {
    trackDots = n;
    for (let t = 0; t < 2; t++) {
        const c = $('tpoints-' + t); c.innerHTML = '';
        for (let i = 0; i < n; i++) {
            const d = document.createElement('div');
            d.className = 'track-dot' + (n <= OT_ROUNDS ? ' ot-dot' : '');
            d.textContent = (i + 1);
            d.id = 'dot-' + t + '-' + i;
            c.appendChild(d);
        }
        // Show player's mines on opponent's track
        if (t === 1) {
            var trapsToShow = isOvertime ? myOvertimeTraps : selectedTraps;
            trapsToShow.forEach(function(trapIdx) {
                var mineDot = $('dot-1-' + trapIdx);
                if (mineDot) {
                    mineDot.classList.add('mine-placed');
                }
            });
        }
        const av = $('tavatar-' + t);
        av.style.left = '4px';
        av.className = 'track-avatar ' + (t === 0 ? 'you-color' : 'opp-color');
        av.innerHTML = '<svg viewBox="0 0 20 30" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;overflow:visible">' +
            '<circle cx="10" cy="3" r="2.5" fill="none" stroke-width="2" stroke-linecap="round"/>' +
            '<line x1="10" y1="7" x2="10" y2="19" stroke-width="2" stroke-linecap="round"/>' +
            '<g><animateTransform attributeName="transform" type="rotate" values="-30,10,7;40,10,7;-30,10,7" dur="0.7s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/><polyline points="10,7 10,12 14,12" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>' +
            '<g><animateTransform attributeName="transform" type="rotate" values="40,10,7;-30,10,7;40,10,7" dur="0.7s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/><polyline points="10,7 10,12 14,12" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>' +
            '<g><animateTransform attributeName="transform" type="rotate" values="20,10,19;-45,10,19;20,10,19" dur="0.7s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/><polyline points="10,19 10,25 5,25" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>' +
            '<g><animateTransform attributeName="transform" type="rotate" values="-45,10,19;20,10,19;-45,10,19" dur="0.7s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/><polyline points="10,19 10,25 5,25" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>' +
            '</svg>';
    }
    applyRevealedPoints();
}

function applyRevealedPoints() {
    for (var key in revealedPoints) {
        var dot = $('dot-0-' + key);
        if (dot) {
            dot.classList.add(revealedPoints[key] ? 'xray-trap' : 'xray-safe');
            if (!revealedPoints[key]) dot.textContent = '\u2713';
        }
    }
}

function highlightCurrentDot(step) {
    document.querySelectorAll('.track-dot.current').forEach((d) => d.classList.remove('current'));
    if (step < trackDots) {
        for (let t = 0; t < 2; t++) {
            const d = $('dot-' + t + '-' + step);
            if (d) d.classList.add('current');
        }
    }
}

async function onRoundStart(msg) {
    currentStep = msg.step;
    moveChosen = false;
    abilityActive = false;
    myUsedXrayThisRound = false;  // сбрасываем флаги рентгена на каждый раунд
    oppUsedXrayThisRound = false;
    // Возвращаем нормальный WebSocket режим — быстрый больше не нужен
    // WebSocket уже работает, дополнительных действий не требуется

    if (msg.overtime) isOvertime = true;

    if (msg.ability) {
        var abilityChanged = myAbility !== msg.ability;
        myAbility = msg.ability;
        if (abilityChanged || currentStep === 0) {
            oppAbility = null;
            abilityUsed = false;
        }
    } else if (isOvertime && currentStep === 0) {
        // Способность придёт из overtime_start, не сбрасываем здесь
    }

    // В овертайме способности отключены
    if (isOvertime) {
        myAbility = null;
        abilityUsed = true;
    }

    showScreen('game');

    if (currentStep === 0 && !isOvertime) {
        $('sb-name-0').textContent = myName;
        $('sb-name-1').textContent = opponentName;
        // Не обновляем счёт пока идёт анимация предыдущего раунда
        if (!roundAnimating) {
            $('sb-score-0').textContent = String(scores[0] || 0);
            $('sb-score-1').textContent = String(scores[1] || 0);
        }
        $('tname-0').textContent = myName;
        $('tname-1').textContent = opponentName;
        $('round-num').textContent = '\u0420\u0430\u0443\u043D\u0434';
        generateGameTracks(7);
        highlightCurrentDot(0);
        $('round-reveal').classList.add('hidden');
        $('round-reveal').style.opacity = '';
        var otEl = $('overtime-announce'); if (otEl) otEl.classList.add('hidden');
        var azEl = $('ability-zone'); if (azEl) azEl.classList.add('hidden');
    }

    if (currentStep === 0 && isOvertime) {
        selectedTraps = [];
        revealedPoints = {};
        knownTrapsOnMyTrack = {};
        // Способность приходит из overtime_start или round_start
        if (!myAbility) abilityUsed = true; else abilityUsed = false;
        $('sb-name-0').textContent = myName;
        $('sb-name-1').textContent = opponentName;
        $('sb-score-0').textContent = String(scores[0] || 0);
        $('sb-score-1').textContent = String(scores[1] || 0);
        $('tname-0').textContent = myName;
        $('tname-1').textContent = opponentName;
        $('round-num').textContent = '\u041E\u0432\u0435\u0440\u0442\u0430\u0439\u043C';
        $('round-val').textContent = '1/' + OT_ROUNDS;
        $('tpoints-0').innerHTML = '';
        $('tpoints-1').innerHTML = '';
        generateGameTracks(OT_ROUNDS);
        // Явно показываем ловушки которые мы поставили сопернику
        if (myOvertimeTraps && myOvertimeTraps.length > 0) {
            myOvertimeTraps.forEach(function(trapIdx) {
                var mineDot = $('dot-1-' + trapIdx);
                if (mineDot) mineDot.classList.add('mine-placed');
            });
        }
        highlightCurrentDot(0);
        $('round-reveal').classList.add('hidden');
        $('round-reveal').style.opacity = '';
        var otEl = $('overtime-announce'); if (otEl) otEl.classList.add('hidden');
        var azEl = $('ability-zone'); if (azEl) azEl.classList.add('hidden');
    }

    if (currentStep > 0) {
        $('round-num').textContent = isOvertime ? '\u041E\u0432\u0435\u0440\u0442\u0430\u0439\u043C' : '\u0420\u0430\u0443\u043D\u0434';
        $('round-val').textContent = isOvertime
            ? (Math.min(currentStep + 1, OT_ROUNDS) + '/' + OT_ROUNDS)
            : (Math.min(currentStep + 1, totalRounds) + '/' + totalRounds);
        highlightCurrentDot(currentStep);
    }

    showActionButtons();
    startTimer(msg && msg.phaseAtMs ? msg.phaseAtMs : null);
}

async function showAbilityReveal() {
    const info = ABILITIES[myAbility];
    $('arev-icon').textContent = info.icon;
    $('arev-name').textContent = info.name;
    $('arev-desc').textContent = info.desc;
    const el = $('ability-reveal');
    el.classList.remove('hidden');
    return new Promise((resolve) => {
        const dismiss = () => { el.classList.add('hidden'); resolve(); };
        el.onclick = dismiss;
        setTimeout(dismiss, 4000);
    });
}

function enterXrayScanMode() {
    xrayScanMode = true;
    document.body.classList.add('xray-mode');
    for (let i = currentStep; i < trackDots; i++) {
        var dot = $('dot-0-' + i);
        if (dot && !revealedPoints.hasOwnProperty(String(i))) {
            dot.classList.add('xray-scannable');
        }
    }
    var trackEl = $('tpoints-0');
    if (trackEl) trackEl.addEventListener('click', onXrayTrackClick);
}

function exitXrayScanMode() {
    xrayScanMode = false;
    document.body.classList.remove('xray-mode');
    for (let i = 0; i < trackDots; i++) {
        var dot = $('dot-0-' + i);
        if (dot) dot.classList.remove('xray-scannable');
    }
    var trackEl = $('tpoints-0');
    if (trackEl) trackEl.removeEventListener('click', onXrayTrackClick);
}

function onXrayTrackClick(e) {
    if (!xrayScanMode) return;
    var dot = e.target.closest('.xray-scannable');
    if (!dot) return;
    var point = parseInt(dot.id.split('-')[2]);
    if (isNaN(point)) return;
    sendMsg({ type: 'xray_scan', point: point });
    exitXrayScanMode();
    $('prompt-text').textContent = '\uD83D\uDC41 \u0421\u043A\u0430\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435...';
}

function onXrayResult(msg) {
    playSound('ping');
    revealedPoints[String(msg.point)] = msg.hasTrap;
    xrayScanMode = false;
    abilityUsed = true;
    abilityActive = false;
    myUsedXrayThisRound = true; // запоминаем что я использовал рентген в этом раунде
    document.body.classList.remove('xray-mode');

    // Scan sweep animation
    var trackLine = $('tpoints-0') ? $('tpoints-0').parentElement : null;
    if (trackLine) {
        var scanLine = document.createElement('div');
        scanLine.className = 'xray-scan-line';
        trackLine.appendChild(scanLine);
        setTimeout(function() { scanLine.remove(); }, 700);
    }

    // Delay reveal until after scan animation
    setTimeout(function() {
        var dot = $('dot-0-' + msg.point);
        if (dot) {
            dot.classList.add(msg.hasTrap ? 'xray-trap' : 'xray-safe');
            if (!msg.hasTrap) dot.textContent = '\u2713';
        }
        $('action-btns').classList.remove('hidden');
        $('ability-zone').classList.add('hidden');
        updatePromptText();
    }, 600);
}

function onOppXray(msg) {
    // Запоминаем что соперник использовал рентген — покажем на экране результата хода
    oppAbility = 'xray';
    oppUsedXrayThisRound = true; // запоминаем для toast и dotIcon

    // Scan sweep animation on opponent track (track 1)
    var trackLine = $('tpoints-1') ? $('tpoints-1').parentElement : null;
    if (trackLine) {
        var scanLine = document.createElement('div');
        scanLine.className = 'xray-scan-line';
        trackLine.appendChild(scanLine);
        setTimeout(function() { scanLine.remove(); }, 700);
    }
    // Не добавляем xray-scanned-opp на ячейку — иконка 👁 будет показана в dotIcon() при onRoundResult
}

function toggleAbility() {
    if (abilityUsed) return;
    playSound('click');
    abilityActive = !abilityActive;
    updateAbilityUI();
}

function updateAbilityUI() {
    const btn = $('btn-ability');
    const info = ABILITIES[myAbility];

    if (abilityActive) {
        btn.textContent = info.icon + ' ' + info.name + ' \u2714';
        btn.classList.add('ability-active');
        if (myAbility === 'xray') {
            $('action-btns').classList.add('hidden');
            enterXrayScanMode();
            $('prompt-text').textContent = '\uD83D\uDC41 \u0412\u044B\u0431\u0435\u0440\u0438 \u0442\u043E\u0447\u043A\u0443 \u0434\u043B\u044F \u0441\u043A\u0430\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u044F';
        }
    } else {
        btn.textContent = info.icon + ' ' + info.name;
        btn.classList.remove('ability-active');
        if (myAbility === 'xray') {
            exitXrayScanMode();
            $('action-btns').classList.remove('hidden');
            updatePromptText();
        }
    }
}

function updatePromptText() {
    if (isOvertime) {
        $('prompt-text').textContent = '\u041E\u0432\u0435\u0440\u0442\u0430\u0439\u043C! \u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u0448\u044C?';
    } else {
        $('prompt-text').textContent = '\u0422\u043E\u0447\u043A\u0430 ' + (currentStep + 1) + ' \u2014 \u0447\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u0448\u044C?';
    }
}

function showActionButtons() {
    $('action-btns').classList.remove('hidden');
    $('move-wait').classList.add('hidden');
    $('action-zone').classList.remove('hidden');
    $('btn-run').disabled = false;
    $('btn-jump').disabled = false;
    abilityActive = false;
    updatePromptText();

    // Double заблокирован после раунда 5 и в овертайме; в овертайме способности отключены полностью
    const abilityLocked = isOvertime || (myAbility === 'double' && currentStep >= 5);
    if (!abilityUsed && myAbility && !abilityLocked) {
        $('ability-zone').classList.remove('hidden');
        const info = ABILITIES[myAbility];
        $('btn-ability').textContent = info.icon + ' ' + info.name;
        $('btn-ability').classList.remove('ability-active');
        $('btn-ability').disabled = false;
        const oppStatus = $('opp-ability-status');
        if (oppStatus) {
            if (oppAbility) {
                const oInfo = ABILITIES[oppAbility];
                oppStatus.textContent = oInfo.icon + ' ' + oInfo.name;
            } else {
                oppStatus.textContent = '❓ Скрыто';
            }
        }
    } else if (!abilityUsed && myAbility && abilityLocked) {
        $('ability-zone').classList.remove('hidden');
        const info = ABILITIES[myAbility];
        $('btn-ability').textContent = '🔒 ' + info.name;
        $('btn-ability').classList.add('ability-active');
        $('btn-ability').disabled = true;
        const oppStatus = $('opp-ability-status');
        if (oppStatus) {
            if (oppAbility) {
                const oInfo = ABILITIES[oppAbility];
                oppStatus.textContent = oInfo.icon + ' ' + oInfo.name;
            } else {
                oppStatus.textContent = '❓ Скрыто';
            }
        }
    } else {
        $('ability-zone').classList.add('hidden');
    }
}

function makeMove(action) {
    if (moveChosen) return;
    moveChosen = true;
    playSound('click');
    clearInterval(timerInterval);
    sendMsg({ type: 'make_move', action, useAbility: abilityActive });
    if (abilityActive) abilityUsed = true;

    $('btn-run').disabled = true;
    $('btn-jump').disabled = true;
    $('ability-zone').classList.add('hidden');

    // Keep both action buttons visually highlighted while waiting for the round result.
    $('btn-run').style.outline = '';
    $('btn-run').style.opacity = '';
    $('btn-jump').style.outline = '';
    $('btn-jump').style.opacity = '';
    $('move-wait').classList.remove('hidden');
}

function randomAbility() {
    const r = Math.random() * 5;
    if (r < 2) return 'xray';
    if (r < 4) return 'sabotage';
    return 'double';
}

function randomBotTraps(total, count) {
    const set = new Set();
    while (set.size < count) set.add(Math.floor(Math.random() * total));
    return [...set];
}

function localServerOnClientMessage(msg) {
    if (msg.type === 'find_bot' || msg.type === 'find_game') {
        localMatch = {
            tgUserId: msg.tgUserId ? String(msg.tgUserId) : null,
            names: [myName, 'Бот'],
            traps: [null, randomBotTraps(7, 3)],
            scores: [0, 0],
            currentStep: 0,
            overtime: false,
            overtimeRound: 0,
            overtimeTraps: null,
            moves: [null, null],
            abilities: [randomAbility(), randomAbility()],
            abilityUsed: [false, false],
            phase: 'placing',
            ended: false
        };
        setTimeout(() => handleMessage({ type: 'game_found', opponent: 'Бот', playerIndex: 0 }), 450);
        return;
    }
    if (!localMatch) return;
    if (msg.type === 'cancel_wait') { localMatch = null; return; }

    if (msg.type === 'place_traps') {
        const needed = localMatch.phase === 'overtime_placing' ? 1 : 3;
        if (!Array.isArray(msg.traps) || msg.traps.length !== needed) return;
        if (localMatch.phase === 'overtime_placing') {
            localMatch.overtimeTraps = [msg.traps.slice(), randomBotTraps(3, 1)];
            localMatch.overtime = true;
            localMatch.overtimeRound = 0;
            localMatch.phase = 'running';
            isOvertime = true;
            setTimeout(localStartRound, 500);
            return;
        }
        localMatch.traps[0] = msg.traps.slice();
        localMatch.phase = 'running';
        setTimeout(localStartRound, 500);
        return;
    }

    if (msg.type === 'xray_scan') {
        if (localMatch.abilityUsed[0] || localMatch.abilities[0] !== 'xray') return;
        const point = Number(msg.point || 0);
        const hasTrap = localMatch.overtime
            ? localMatch.overtimeTraps[1].includes(point)
            : localMatch.traps[1].includes(point);
        localMatch.abilityUsed[0] = true;
        handleMessage({ type: 'xray_result', point, hasTrap });
        return;
    }

    if (msg.type === 'make_move') {
        if (localMatch.ended) return;
        localMatch.moves[0] = { action: msg.action, useAbility: !!msg.useAbility };
        localChooseBotMove();
        localResolveRound();
    }
}

function localStartRound() {
    if (!localMatch || localMatch.ended) return;
    localMatch.moves = [null, null];
    const step = localMatch.overtime ? localMatch.overtimeRound : localMatch.currentStep;
    handleMessage({ type: 'round_start', step, ability: localMatch.abilities[0], overtime: localMatch.overtime });
}

function localChooseBotMove() {
    if (!localMatch) return;
    let useAbility = false;
    if (!localMatch.overtime && !localMatch.abilityUsed[1] && Math.random() < 0.3) {
        const ab = localMatch.abilities[1];
        if (ab === 'sabotage') useAbility = true;
        if (ab === 'double' && localMatch.currentStep <= 4) useAbility = true;
    }
    localMatch.moves[1] = { action: Math.random() > 0.5 ? 'run' : 'jump', useAbility };
}

function localResolveRound() {
    const m = localMatch;
    if (!m || !m.moves[0] || !m.moves[1]) return;
    const step = m.overtime ? m.overtimeRound : m.currentStep;
    const result = [null, null];

    for (let i = 0; i < 2; i++) {
        const opp = 1 - i;
        const mv = m.moves[i];
        const hasTrap = m.overtime ? m.overtimeTraps[opp].includes(step) : m.traps[opp].includes(step);
        let usedAbility = null;
        if (mv.useAbility && !m.abilityUsed[i] && !m.overtime) {
            const ab = m.abilities[i];
            if (!(ab === 'double' && step > 4)) { usedAbility = ab; m.abilityUsed[i] = true; }
        }
        const success = (mv.action === 'run' && !hasTrap) || (mv.action === 'jump' && hasTrap);
        let points = success ? 1 : 0;
        if (usedAbility === 'double') points = success ? 2 : -1;
        let reason = '';
        if (mv.action === 'run' && !hasTrap) reason = 'clear_run';
        else if (mv.action === 'run' && hasTrap) reason = 'hit_trap';
        else if (mv.action === 'jump' && hasTrap) reason = 'dodged_trap';
        else reason = 'wasted_jump';
        result[i] = { action: mv.action, hasTrap, success, reason, points, usedAbility, sabotaged: false, sabotageHit: false, sabotageBackfire: false };
    }

    const baseSuccess = [result[0].success, result[1].success];
    for (let i = 0; i < 2; i++) {
        if (result[i].usedAbility === 'sabotage') {
            const opp = 1 - i;
            if (baseSuccess[opp]) {
                result[opp].sabotaged = true;
                result[opp].points = 0;
                result[i].sabotageHit = true;
            } else result[i].sabotageBackfire = true;
        }
    }

    m.scores[0] += result[0].points;
    m.scores[1] += result[1].points;
    if (m.overtime) m.overtimeRound++;
    else m.currentStep++;

    const MAIN_ROUNDS = 7;
    const WIN_SCORE_LOCAL = 5;
    let gameOver = false;
    let winner = null;
    let startOvertime = false;

    if (m.overtime) {
        if (m.scores[0] !== m.scores[1]) {
            gameOver = true;
            winner = m.scores[0] > m.scores[1] ? 'win' : 'lose';
        } else if (m.overtimeRound >= OT_ROUNDS) startOvertime = true;
    } else {
        const p0 = m.scores[0], p1 = m.scores[1];
        // Досрочная победа если кто-то достиг WIN_SCORE
        if (p0 >= WIN_SCORE_LOCAL && p1 >= WIN_SCORE_LOCAL) {
            if (p0 > p1) { gameOver = true; winner = 'win'; }
            else if (p1 > p0) { gameOver = true; winner = 'lose'; }
            else startOvertime = true;
        } else if (p0 >= WIN_SCORE_LOCAL) {
            gameOver = true; winner = 'win';
        } else if (p1 >= WIN_SCORE_LOCAL) {
            gameOver = true; winner = 'lose';
        } else if (m.currentStep >= MAIN_ROUNDS) {
            if (p0 === p1) startOvertime = true;
            else { gameOver = true; winner = p0 > p1 ? 'win' : 'lose'; }
        }
    }

    handleMessage({
        type: 'round_result',
        you: result[0],
        opponent: result[1],
        step,
        scores: [m.scores[0], m.scores[1]],
        winner,
        gameOver,
        round: m.overtime ? m.overtimeRound : m.currentStep,
        totalRounds: MAIN_ROUNDS,
        playerIndex: 0,
        overtime: m.overtime,
        startOvertime,
        overtimeAbility: startOvertime ? (m.overtimeAbilities ? m.overtimeAbilities[0] : null) : null,
        abilityUsed: [m.abilityUsed[0], m.abilityUsed[1]]
    });

    if (startOvertime) {
        m.phase = 'overtime_placing';
        m.overtimeTraps = [null, null];
        // Назначаем способности для овертайма (xray/sabotage)
        const otAbs = ['xray', 'sabotage'];
        m.overtimeAbilities = [
            otAbs[Math.floor(Math.random() * otAbs.length)],
            otAbs[Math.floor(Math.random() * otAbs.length)]
        ];
        m.abilityUsed = [false, false];
    }
    if (gameOver) m.ended = true;
}

function startTimer(phaseAtMs) {
    const fill = $('timer-fill');
    fill.style.width = '100%';
    fill.classList.remove('urgent');
    clearInterval(timerInterval);
    const nowServer = Date.now() - (Number(pvpServerSkewMs || 0));
    const durationMs = isBotMode ? 10_000 : TURN_MS;
    const startAt = Number(phaseAtMs || 0) > 0 ? Number(phaseAtMs || 0) : nowServer;
    const endAt = startAt + durationMs;
    timerInterval = setInterval(() => {
        const nowS = Date.now() - (Number(pvpServerSkewMs || 0));
        const left = Math.max(0, endAt - nowS);
        const pct = Math.max(0, (left / durationMs) * 100);
        fill.style.width = pct + '%';
        if (pct < 30) fill.classList.add('urgent');
        if (pct <= 0) {
            clearInterval(timerInterval);
            if (!moveChosen) {
                if (xrayScanMode) exitXrayScanMode();
                abilityActive = false;
                // В боте — делаем авто-ход локально
                // В PvP — бэкенд сам сделает авто-ход по таймауту, просто блокируем UI
                if (isBotMode) {
                    makeMove(Math.random() < 0.5 ? 'run' : 'jump');
                } else {
                    // Блокируем кнопки — ждём бэкенд
                    $('btn-run').disabled = true;
                    $('btn-jump').disabled = true;
                    $('move-wait').classList.remove('hidden');
                    $('action-btns').classList.add('hidden');
                }
            }
        }
    }, 50);
}

async function onRoundResult(msg) {
    clearInterval(timerInterval);
    stopMoveWatchdog(); // результат получен — watchdog больше не нужен
    roundAnimating = true; // блокируем обновление счёта в UI
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    const my = msg.you;
    const opp = msg.opponent;

    // Reveal opponent ability when they use it
    if (opp.usedAbility && !oppAbility) {
        oppAbility = opp.usedAbility;
    }

    // Показываем тост ТОЛЬКО если соперник использовал умение (не своё)
    // Рентген показывается отдельно через oppUsedXrayThisRound
    if (opp.usedAbility && opp.usedAbility !== 'xray') {
        var toastInfo = {
            double:   { icon: '⚡', text: opponentName + ' использовал Удвоение!', cls: 'double' },
            sabotage: { icon: '💀', text: opponentName + ' использовал Саботаж!', cls: 'sabotage' },
        }[opp.usedAbility];
        if (toastInfo) {
            var toast = document.createElement('div');
            toast.className = 'ability-toast ' + toastInfo.cls;
            toast.innerHTML = '<span class="ability-toast-icon">' + toastInfo.icon + '</span><span>' + toastInfo.text + '</span>';
            document.body.appendChild(toast);
            setTimeout(function() { toast.remove(); }, 2200);
        }
    }
    // Рентген соперника — показываем сразу вместе с другими тостами
    if (oppUsedXrayThisRound) {
        var xrayToast = document.createElement('div');
        xrayToast.className = 'ability-toast xray';
        xrayToast.innerHTML = '<span class="ability-toast-icon">👁</span><span>' + opponentName + ' использовал Рентген!</span>';
        document.body.appendChild(xrayToast);
        setTimeout(function() { xrayToast.remove(); }, 2200);
    }

    // Track traps discovered on my track
    knownTrapsOnMyTrack[msg.step] = my.hasTrap;

    // Hide action UI
    $('action-btns').classList.add('hidden');
    $('move-wait').classList.add('hidden');
    $('ability-zone').classList.add('hidden');
    $('btn-run').style.outline = '';
    $('btn-run').style.opacity = '';
    $('btn-jump').style.outline = '';
    $('btn-jump').style.opacity = '';

    // Show reveal
    const reveal = $('round-reveal');
    reveal.style.opacity = '';
    reveal.classList.remove('hidden');
    playSound('swoosh');

    // Action text
    function actionStr(r) {
        let s = r.action === 'run' ? '\u25B6 \u0411\u0435\u0436\u0430\u0442\u044C' : '\u25B2 \u041F\u0440\u044B\u0433\u043D\u0443\u0442\u044C';
        return s;
    }

    $('reveal-you-action').textContent = actionStr(my);
    $('reveal-opp-action').textContent = actionStr(opp);
    $('reveal-you-result').textContent = '';
    $('reveal-opp-result').textContent = '';
    $('reveal-you').querySelector('.reveal-label').textContent = myName;
    $('reveal-opp').querySelector('.reveal-label').textContent = opponentName;

    await delay(800);

    // Reveal traps on dots with bomb icon
    const myDot = $('dot-0-' + msg.step);
    const oppDot = $('dot-1-' + msg.step);

    if (myDot && my.hasTrap) { myDot.classList.add('trap-reveal'); }
    if (oppDot && opp.hasTrap) { oppDot.classList.add('trap-reveal'); }

    await delay(500);

    // Result text
    function resultStr(r) {
        if (r.sabotaged) return '0 \u0421\u0430\u0431\u043E\u0442\u0430\u0436!';
        if (r.usedAbility === 'double' && r.success) return '+2 \u0423\u0434\u0432\u043E\u0435\u043D\u0438\u0435!';
        if (r.usedAbility === 'double' && !r.success) return '-1 \u041F\u0440\u043E\u0432\u0430\u043B!';
        if (r.sabotageBackfire) return '\uD83D\uDC80 \u041F\u0440\u043E\u043C\u0430\u0445!';
        if (r.sabotageHit) return '\uD83D\uDC80 \u041F\u043E\u043F\u0430\u043B!';
        if (r.reason === 'clear_run') return '+1 \u0427\u0438\u0441\u0442\u043E!';
        if (r.reason === 'hit_trap') return '\u041B\u043E\u0432\u0443\u0448\u043A\u0430!';
        if (r.reason === 'dodged_trap') return '+1 \u041E\u0431\u043E\u0448\u0451\u043B!';
        if (r.reason === 'wasted_jump') return '\u0417\u0440\u044F \u043F\u0440\u044B\u0433\u043D\u0443\u043B!';
        return '';
    }

    function isGood(r) {
        if (r.sabotaged) return false;
        if (r.usedAbility === 'double' && !r.success) return false;
        return r.success || r.sabotageHit;
    }

    $('reveal-you-result').textContent = resultStr(my);
    $('reveal-you-result').className = 'reveal-result ' + (isGood(my) ? 'good' : 'bad');
    $('reveal-opp-result').textContent = resultStr(opp);
    $('reveal-opp-result').className = 'reveal-result ' + (isGood(opp) ? 'good' : 'bad');
    playSound(isGood(my) ? 'good' : 'bad');

        // Mark dots — enhanced with mine visuals
    // Иконки способностей вместо ✓/✗ когда способность использована
    function dotIcon(r, isOpp) {
        if (r.usedAbility === 'double') return '⚡';
        if (r.usedAbility === 'sabotage') return '💀';
        if (r.usedAbility === 'xray') return '👁';
        // Рентген не приходит в usedAbility — используем флаги
        if (!isOpp && myUsedXrayThisRound) return '👁';
        if (isOpp && oppUsedXrayThisRound) return '👁';
        if (r.sabotaged) return '💀'; // заблокировано саботажем — показываем череп
        return r.points > 0 ? '\u2713' : '\u2717';
    }
    if (myDot) {
        myDot.classList.remove('current', 'xray-trap', 'xray-safe', 'xray-scannable');
        if (my.hasTrap && my.reason === 'hit_trap') {
            myDot.classList.add('fail', 'mine-hit');
            myDot.textContent = dotIcon(my, false);
        } else if (my.hasTrap && my.reason === 'dodged_trap') {
            myDot.classList.add('success', 'mine-dodged');
            myDot.textContent = dotIcon(my, false);
        } else {
            const myOk = my.points > 0 && !my.sabotaged;
            myDot.classList.add(myOk ? 'success' : 'fail');
            myDot.textContent = dotIcon(my, false);
        }
    }
    if (oppDot) {
        oppDot.classList.remove('current', 'xray-scanned-opp');
        if (opp.hasTrap && opp.reason === 'hit_trap') {
            oppDot.classList.remove('mine-placed');
            oppDot.classList.add('fail', 'mine-exploded');
            oppDot.textContent = dotIcon(opp, true);
        } else if (opp.hasTrap && opp.reason === 'dodged_trap') {
            oppDot.classList.remove('mine-placed');
            oppDot.classList.add('mine-safe');
            oppDot.textContent = dotIcon(opp, true);
        } else {
            oppDot.classList.remove('mine-placed');
            const oppOk = opp.points > 0 && !opp.sabotaged;
            oppDot.classList.add(oppOk ? 'success' : 'fail');
            oppDot.textContent = dotIcon(opp, true);
        }
    }

    // Avatar animations
    const myAv = $('tavatar-0');
    const oppAv = $('tavatar-1');

    if (my.success && !my.sabotaged) {
        if (my.reason === 'dodged_trap') myAv.classList.add('jump-anim');
    } else { myAv.classList.add('shake'); }
    if (opp.success && !opp.sabotaged) {
        if (opp.reason === 'dodged_trap') oppAv.classList.add('jump-anim');
    } else { oppAv.classList.add('shake'); }

    await delay(300);

    moveAvatar(myAv, msg.step + 1);
    moveAvatar(oppAv, msg.step + 1);

    await delay(600);
    myAv.classList.remove('shake', 'jump-anim');
    oppAv.classList.remove('shake', 'jump-anim');

    // Update scores — берём напрямую из myScore/oppScore (уже ориентированы правильно на бэке)
    const myScoreVal = (msg.myScore !== undefined) ? msg.myScore : (() => {
        const mi2 = (msg.playerIndex !== undefined) ? msg.playerIndex : playerIndex;
        return msg.scores ? msg.scores[mi2] : scores[0];
    })();
    const oppScoreVal = (msg.oppScore !== undefined) ? msg.oppScore : (() => {
        const mi2 = (msg.playerIndex !== undefined) ? msg.playerIndex : playerIndex;
        return msg.scores ? msg.scores[1 - mi2] : scores[1];
    })();
    scores = [myScoreVal, oppScoreVal];
    const s0 = $('sb-score-0'); const s1 = $('sb-score-1');
    s0.textContent = scores[0]; s1.textContent = scores[1];
    roundAnimating = false; // разблокируем обновление счёта

    if (my.points > 0) { s0.classList.add('score-pop'); showFloat($('gtrack-0'), '+' + my.points, true); }
    else if (my.points < 0) { s0.classList.add('score-pop'); showFloat($('gtrack-0'), '' + my.points, false); }
    if (opp.points > 0) { s1.classList.add('score-pop'); showFloat($('gtrack-1'), '+' + opp.points, true); }
    else if (opp.points < 0) { s1.classList.add('score-pop'); showFloat($('gtrack-1'), '' + opp.points, false); }

    // Ability effects
    if (my.usedAbility === 'double') {
        s0.classList.add('lightning-flash');
        setTimeout(function() { s0.classList.remove('lightning-flash'); }, 800);
    }
    if (opp.usedAbility === 'double') {
        s1.classList.add('lightning-flash');
        setTimeout(function() { s1.classList.remove('lightning-flash'); }, 800);
    }
    if (my.sabotaged || opp.sabotaged) {
        showSabotageEffect();
    }

    await delay(800);
    s0.classList.remove('score-pop'); s1.classList.remove('score-pop');

    // Hide reveal with fade
    reveal.style.opacity = '0';
    await delay(300);
    reveal.classList.add('hidden');
    reveal.style.opacity = '';

    // Update round counter
    if (msg.overtime && !msg.startOvertime) {
        $('round-num').textContent = '\u041E\u0432\u0435\u0440\u0442\u0430\u0439\u043C';
        $('round-val').textContent = msg.round + '/' + OT_ROUNDS;
    } else if (!msg.overtime) {
        $('round-val').textContent = Math.min(msg.round + 1, totalRounds) + '/' + totalRounds;
    }

    // Возвращаем нормальный WebSocket режим — результат получен, быстрый больше не нужен
    // WebSocket уже работает, дополнительных действий не требуется

    if (msg.gameOver) {
        await delay(300);
        // Финальный счёт — берём из myScore/oppScore (уже ориентированы на нас)
        var finalArr = [msg.myScore !== undefined ? msg.myScore : scores[0],
                        msg.oppScore !== undefined ? msg.oppScore : scores[1]];
        showGameOver(msg.winner, finalArr);
    } else if (msg.startOvertime) {
        await showOvertimeAnnouncement();
        isOvertime = true;
        revealedPoints = {};
        knownTrapsOnMyTrack = {};
        oppAbility = null;
        if (msg.overtimeAbility) {
            myAbility = msg.overtimeAbility;
            abilityUsed = false;
        } else {
            myAbility = null;
            abilityUsed = true;
        }
        // В PvP — экран ловушек придёт через WebSocket (overtime_placing фаза)
        // В боте — показываем сразу
        if (isBotMode) {
            selectedTraps = [];
            myOvertimeTraps = [];
            trapsConfirmed = false;
            overtimePlacing = true;
            generateTrapTrack();
            showScreen('traps');
            $('opp-name-traps').textContent = '\u0414\u043E\u0440\u043E\u0436\u043A\u0430: ' + opponentName;
            updateTrapUI();
            $('btn-traps-ok').classList.remove('hidden');
            $('btn-traps-ok').disabled = true;
            $('traps-wait').classList.add('hidden');
            startTrapTimer();
        }
        // В PvP — ждём WebSocket broadcast с overtime_placing
    } else {
        // Следующий раунд — в PvP ждём WebSocket broadcast с running фазой
        // В боте — запускаем напрямую
        if (isBotMode) {
            currentStep = msg.round;
            highlightCurrentDot(msg.round);
            moveChosen = false;
            showActionButtons();
            startTimer(null);
        }
        // В PvP: WebSocket принесёт running фазу с правильным phaseAtMs
    }
}

function onOvertimeStart(msg) {
    isOvertime = true;
    currentStep = 0;
    // В овертайме способности отключены
    myAbility = null;
    abilityUsed = true;
    oppAbility = null;
    selectedTraps = [];
    revealedPoints = {};
    knownTrapsOnMyTrack = {};
    showScreen('game');
    $('tpoints-0').innerHTML = '';
    $('tpoints-1').innerHTML = '';
    generateGameTracks(OT_ROUNDS);
    // Явно показываем ловушки которые мы поставили сопернику
    if (myOvertimeTraps && myOvertimeTraps.length > 0) {
        myOvertimeTraps.forEach(function(trapIdx) {
            var mineDot = $('dot-1-' + trapIdx);
            if (mineDot) mineDot.classList.add('mine-placed');
        });
    }
    highlightCurrentDot(0);
    $('round-num').textContent = '\u041E\u0432\u0435\u0440\u0442\u0430\u0439\u043C';
    $('round-val').textContent = '1/' + OT_ROUNDS;
    $('sb-name-0').textContent = myName;
    $('sb-name-1').textContent = opponentName;
    $('sb-score-0').textContent = String(scores[0] || 0);
    $('sb-score-1').textContent = String(scores[1] || 0);
    $('tname-0').textContent = myName;
    $('tname-1').textContent = opponentName;
    moveChosen = false;
    overtimePlacing = false;
    $('round-reveal').classList.add('hidden');
    $('round-reveal').style.opacity = '';
    var otEl = $('overtime-announce'); if (otEl) otEl.classList.add('hidden');
    var azEl = $('ability-zone'); if (azEl) azEl.classList.add('hidden');
    showActionButtons();
    startTimer(msg && msg.phaseAtMs ? msg.phaseAtMs : null);
}

async function showOvertimeAnnouncement() {
    playSound('swooshBig');
    const el = $('overtime-announce');
    el.classList.remove('hidden');
    return new Promise((resolve) => {
        setTimeout(() => { el.classList.add('hidden'); resolve(); }, 2500);
    });
}

function moveAvatar(avatar, step) {
    const trackLine = avatar.parentElement;
    const trackWidth = trackLine.offsetWidth;
    const dotWidth = 36;
    const numDots = trackDots;
    if (numDots <= 1) return;
    const spacing = (trackWidth - dotWidth) / (numDots - 1);
    const targetLeft = Math.min(step, numDots - 1) * spacing + (dotWidth - 28) / 2;
    avatar.style.left = targetLeft + 'px';
}

function showFloat(container, text, good) {
    const el = document.createElement('div');
    el.className = 'float-text';
    el.textContent = text;
    el.style.color = good ? 'var(--success)' : 'var(--danger)';
    el.style.left = '50%'; el.style.top = '0';
    container.style.position = 'relative';
    container.appendChild(el);
    setTimeout(() => el.remove(), 900);
}

function showSabotageEffect() {
    var gameWrap = document.querySelector('.game-wrap');
    if (!gameWrap) return;
    var overlay = document.createElement('div');
    overlay.className = 'sabotage-flash';
    gameWrap.appendChild(overlay);
    setTimeout(function() { overlay.remove(); }, 800);
}

function showGameOver(winner, scoresArr) {
    // scoresArr = [myScore, oppScore] — уже ориентированы на текущего игрока
    const myScore = Array.isArray(scoresArr) ? scoresArr[0] : 0;
    const oppScore = Array.isArray(scoresArr) ? scoresArr[1] : 0;

    if (winner === 'win') {
        if (!gameOverSoundPlayed) { playSound('win'); gameOverSoundPlayed = true; }
        $('result-emoji').textContent = '\uD83D\uDC51';
        $('result-title').textContent = '\u041F\u041E\u0411\u0415\u0414\u0410!';
        $('result-title').style.color = 'var(--success)';
        $('result-sub').textContent = '\u0422\u044B \u043E\u043A\u0430\u0437\u0430\u043B\u0441\u044F \u0445\u0438\u0442\u0440\u0435\u0435!';
    } else if (winner === 'lose') {
        if (!gameOverSoundPlayed) { playSound('lose'); gameOverSoundPlayed = true; }
        $('result-emoji').textContent = '\uD83D\uDE14';
        $('result-title').textContent = '\u041F\u041E\u0420\u0410\u0416\u0415\u041D\u0418\u0415';
        $('result-title').style.color = 'var(--danger)';
        $('result-sub').textContent = '\u0412 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0440\u0430\u0437 \u043F\u043E\u0432\u0435\u0437\u0451\u0442!';
    } else {
        $('result-emoji').textContent = '\uD83E\uDD1D';
        $('result-title').textContent = '\u041D\u0418\u0427\u042C\u042F';
        $('result-title').style.color = 'var(--warn)';
        $('result-sub').textContent = '\u0420\u0430\u0432\u043D\u044B\u0435 \u0441\u043E\u043F\u0435\u0440\u043D\u0438\u043A\u0438!';
    }
    if (!isBotMode && Number.isFinite(Number(currentStakeTon)) && Number(currentStakeTon) > 0) {
        var stake = Number(currentStakeTon);
        if (winner === 'win') {
            $('result-sub').textContent = 'TON итог: +' + formatTonCompact(stake * 2) + ' TON';
            $('result-sub').style.color = 'var(--success)';
        } else if (winner === 'lose') {
            $('result-sub').textContent = 'TON итог: -' + formatTonCompact(stake) + ' TON';
            $('result-sub').style.color = 'var(--danger)';
        } else {
            $('result-sub').textContent = 'TON итог: 0 TON';
            $('result-sub').style.color = 'var(--warn)';
        }
    }

    $('fs-name-0').textContent = myName;
    $('fs-val-0').textContent = myScore;
    $('fs-name-1').textContent = opponentName;
    $('fs-val-1').textContent = oppScore;
    showScreen('result');
    if (isBotMode) saveMatchToBackend(winner, myScore, oppScore);
}

function formatTonCompact(n) {
    var x = Number(n || 0);
    if (!isFinite(x)) return '0';
    return x.toFixed(9).replace(/\.?0+$/, '');
}

function onOpponentLeft() {
    clearInterval(timerInterval);
    $('result-emoji').textContent = '🏆';
    $('result-title').textContent = 'ПОБЕДА!';
    $('result-title').style.color = 'var(--success)';
    // Показываем выигрыш если была ставка
    if (!isBotMode && Number.isFinite(Number(currentStakeTon)) && Number(currentStakeTon) > 0) {
        var stake = Number(currentStakeTon);
        $('result-sub').textContent = 'Соперник вышел · +' + formatTonCompact(stake * 2) + ' TON';
        $('result-sub').style.color = 'var(--success)';
    } else {
        $('result-sub').textContent = 'Соперник вышел из игры';
        $('result-sub').style.color = 'var(--warn)';
    }
    $('fs-name-0').textContent = myName;
    $('fs-val-0').textContent = scores[0];
    $('fs-name-1').textContent = opponentName;
    $('fs-val-1').textContent = scores[1];
    if (!gameOverSoundPlayed) { playSound('win'); gameOverSoundPlayed = true; }
    showScreen('result');
}

function saveMatchToBackend(winner, myScore, oppScore) {
    if (matchSaved || !tgInitData || !window.fetch) return;
    matchSaved = true;
    const youWon = winner === 'win';
    const tgUserId = window._tgUserId ? String(window._tgUserId) : null;
    fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'recordMatch',
            initData: tgInitData,
            payload: {
                gameKey: 'obstacle_race',
                mode: 'bot',
                winnerTgUserId: youWon ? tgUserId : null,
                players: [
                    { tgUserId, name: myName || 'Игрок', score: myScore || 0, isWinner: !!youWon, isBot: false },
                    { tgUserId: null, name: opponentName || 'Бот 🤖', score: oppScore || 0, isWinner: !youWon, isBot: true }
                ],
                score: { left: myScore || 0, right: oppScore || 0 },
                details: { overtime: !!isOvertime, rounds: currentStep + 1 }
            }
        })
    }).catch(() => { matchSaved = false; });
}
