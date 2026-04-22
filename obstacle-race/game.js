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
let overtimePlacing = false;
let trapsConfirmed = false;
let trapTimerInterval = null;
let myOvertimeTraps = [];
let tgInitData = '';
let localMatch = null;
let matchSaved = false;
let isBotMode = true;
let selectedStakeOptions = [];
let currentStakeTon = null;
const ALLOWED_STAKES = [0.1, 0.5, 1, 5, 10, 25];
let currentBalanceTon = 0;
let bottomNoticeTimer = null;
let onlineModeSelected = false;
let pvpAcceptDeadlineMs = 0;
let pvpRoomId = null;
let pvpPollTimer = null;
let pvpPollInFlight = false;
let pvpLastRoundMarker = 0;
let pvpLastXrayMarker = 0;
let pvpLastStartKey = '';
let pvpOpponentTgId = '';
let pvpOpponentIsBot = false;
const SETTINGS_KEY = "f1duel_global_settings_v1";
const PVP_POLL_MS = 900;

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
    $('btn-again').onclick = () => startGame(isBotMode);
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
        setTimeout(() => startGame(false), 0);
    } else {
        window.location.href = '/';
    }
});

function openDemoIntro() {
    showScreen('demo');
}

function connect(cb) {
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
        '<div style="font-size:12px;color:#aab1bf;margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em">Выбери ставки TON</div>' +
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
    if (pvpPollTimer) clearInterval(pvpPollTimer);
    pvpPollTimer = null;
    pvpPollInFlight = false;
}

function startPvpPolling() {
    stopPvpPolling();
    pvpPollTimer = setInterval(function() { pvpPollState(); }, PVP_POLL_MS);
    pvpPollState();
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

function applyPvpRoomState(room) {
    if (!room) return;
    var s = room.state_json || {};
    if (String(room.status) === 'active' && String((s || {}).phase || '') === 'accept_match') {
        var am = s.acceptMatch || {};
        pvpAcceptDeadlineMs = Number(am.deadlineMs || 0);
        if ($('accept-info')) {
            $('accept-info').textContent =
                (room.player1_name || 'Игрок 1') + ' vs ' + (room.player2_name || 'Игрок 2') +
                (room.stake_ton != null ? (' · ' + Number(room.stake_ton) + ' TON') : '');
        }
        showScreen('waiting');
        if ($('accept-timer')) $('accept-timer').textContent = Math.max(0, Math.ceil((pvpAcceptDeadlineMs - Date.now()) / 1000)) + 'с';
        if ($('accept-modal')) $('accept-modal').style.display = 'flex';
        return;
    }
    if (String(room.status) === 'waiting') {
        if ($('accept-modal')) $('accept-modal').style.display = 'none';
        pvpAcceptDeadlineMs = 0;
        showScreen('waiting');
        return;
    }
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

    // Если фаза placing/overtime_placing — показываем экран ловушек (только один раз)
    if ((s.phase === 'placing_traps' || s.phase === 'placing' || s.phase === 'overtime_placing') &&
        !$('screen-traps').classList.contains('active') &&
        !trapsConfirmed) {
        var isOt = s.phase === 'overtime_placing';
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
        $('opp-name-traps').textContent = currentStakeTon != null && isFinite(currentStakeTon)
            ? ('Дорожка: ' + opponentName + ' · ' + currentStakeTon + ' TON')
            : ('Дорожка: ' + opponentName);
        showScreen('traps');
        startTrapTimer();
        return;
    }

    // Если уже подтвердили ловушки — просто ждём, не трогаем экран
    if ((s.phase === 'placing_traps' || s.phase === 'placing' || s.phase === 'overtime_placing') && trapsConfirmed) {
        return;
    }

    var xray = s.lastXray || {};
    var xrayMarker = Number(xray.marker || 0);
    if (xrayMarker > pvpLastXrayMarker) {
        pvpLastXrayMarker = xrayMarker;
        if (xray.bySide === sides.mySide) onXrayResult({ point: xray.point, hasTrap: !!xray.hasTrap });
        else onOppXray({ point: xray.point });
    }

    var rr = s.lastRoundResult || {};
    var roundMarker = Number(rr.marker || 0);
    if (roundMarker > pvpLastRoundMarker) {
        pvpLastRoundMarker = roundMarker;
        var my = rr.result ? rr.result[sides.mySide] : null;
        var opp = rr.result ? rr.result[sides.oppSide] : null;
        if (my && opp) {
            onRoundResult({
                you: my,
                opponent: opp,
                step: Number(rr.step || 0),
                scores: [Number((rr.scores || {}).p1 || 0), Number((rr.scores || {}).p2 || 0)],
                winner: rr.gameOver ? (rr.winnerSide === sides.mySide ? 'win' : 'lose') : null,
                gameOver: !!rr.gameOver,
                round: Number(rr.round || 0),
                totalRounds: 7,
                playerIndex: sides.playerIndex,
                overtime: !!rr.overtime,
                startOvertime: !!rr.startOvertime
            });
            return;
        }
    }

    if (s.phase === 'running') {
        var step = s.overtime ? Number(s.overtimeRound || 0) : Number(s.currentStep || 0);
        var startKey = String(!!s.overtime) + ':' + String(step);
        if (startKey !== pvpLastStartKey) {
            pvpLastStartKey = startKey;
            var abilityForRound = s.overtime
                ? ((s.overtimeAbilities || {})[sides.mySide] || null)
                : ((s.abilities || {})[sides.mySide] || null);
            onRoundStart({ step: step, ability: abilityForRound, overtime: !!s.overtime });
            return;
        }
    }

    if (s.phase === 'match_over' || String(room.status) === 'finished' || String(room.status) === 'cancelled') {
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
        if (s.endedByLeave && s.leftBy && String(s.leftBy) !== String(window._tgUserId || '')) {
            onOpponentLeft();
            return;
        }
        var fin = s.scores || {};
        var finalScores = [Number(fin.p1 || 0), Number(fin.p2 || 0)];
        var winner = null;
        if (s.winnerSide) winner = s.winnerSide === sides.mySide ? 'win' : 'lose';
        else if (finalScores[0] !== finalScores[1]) winner = (sides.meIsP1 ? finalScores[0] > finalScores[1] : finalScores[1] > finalScores[0]) ? 'win' : 'lose';
        showGameOver(winner, finalScores);
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
        if (!data.room) return;
        applyPvpRoomState(data.room);
    }).catch(function() {}).finally(function() {
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
        // Применяем состояние сразу — applyPvpRoomState покажет нужный экран
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
        apiPost({
            action: 'pvpSubmitMove',
            initData: tgInitData,
            roomId: pvpRoomId,
            move: { traps: msg.traps || [] }
        }).then(function(data) {
            if (data && data.ok && data.room) applyPvpRoomState(data.room);
        }).catch(function() {});
        return;
    }
    if (msg.type === 'xray_scan') {
        apiPost({
            action: 'pvpSubmitMove',
            initData: tgInitData,
            roomId: pvpRoomId,
            move: { type: 'xray_scan', point: Number(msg.point || 0) }
        }).then(function(data) {
            if (data && data.ok && data.room) applyPvpRoomState(data.room);
        }).catch(function() {});
        return;
    }
    if (msg.type === 'make_move') {
        apiPost({
            action: 'pvpSubmitMove',
            initData: tgInitData,
            roomId: pvpRoomId,
            move: { action: msg.action, useAbility: !!msg.useAbility }
        }).then(function(data) {
            if (data && data.ok && data.room) applyPvpRoomState(data.room);
        }).catch(function() {
            moveChosen = false;
            $('btn-run').disabled = false;
            $('btn-jump').disabled = false;
            $('move-wait').classList.add('hidden');
        });
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
    trapsConfirmed = false; myOvertimeTraps = []; stopTrapTimer();
    clearInterval(timerInterval);
    matchSaved = false;
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
    syncMyNameFromServer(function() {
        connect(function() { pvpFindMatch(); });
    });
}

function cancelWait() {
    if (isBotMode) {
        localMatch = null;
        showScreen('start');
        return;
    }
    stopPvpPolling();
    pvpLeaveRoomSafe().finally(function() { showScreen('start'); });
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
    stopTrapTimer();
    var maxTraps = overtimePlacing ? 1 : 3;
    var totalSec = 30;
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
    playSound('click');
    trapsConfirmed = true;
    stopTrapTimer();
    if (overtimePlacing) myOvertimeTraps = selectedTraps.slice();
    sendMsg({ type: 'place_traps', traps: selectedTraps });
    $('btn-traps-ok').classList.add('hidden');
    $('traps-wait').classList.remove('hidden');
    // Блокируем точки после подтверждения
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

    showScreen('game');

    if (currentStep === 0 && !isOvertime) {
        $('sb-name-0').textContent = myName;
        $('sb-name-1').textContent = opponentName;
        $('sb-score-0').textContent = String(scores[0] || 0);
        $('sb-score-1').textContent = String(scores[1] || 0);
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
    startTimer();
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
    // Reveal opponent ability
    oppAbility = 'xray';

    // Scan sweep animation on opponent track (track 1)
    var trackLine = $('tpoints-1') ? $('tpoints-1').parentElement : null;
    if (trackLine) {
        var scanLine = document.createElement('div');
        scanLine.className = 'xray-scan-line';
        trackLine.appendChild(scanLine);
        setTimeout(function() { scanLine.remove(); }, 700);
    }

    // Highlight the scanned dot on opponent's track
    setTimeout(function() {
        var dot = $('dot-1-' + msg.point);
        if (dot) {
            dot.classList.add('xray-scanned-opp');
        }
    }, 600);
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

    // Double заблокирован после раунда 5 и в овертайме
    const abilityLocked = myAbility === 'double' && (currentStep >= 5 || isOvertime);
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
    let gameOver = false;
    let winner = null;
    let startOvertime = false;

    if (m.overtime) {
        if (m.scores[0] !== m.scores[1]) {
            gameOver = true;
            winner = m.scores[0] > m.scores[1] ? 'win' : 'lose';
        } else if (m.overtimeRound >= OT_ROUNDS) startOvertime = true;
    } else {
        if (m.currentStep >= MAIN_ROUNDS) {
            if (m.scores[0] === m.scores[1]) startOvertime = true;
            else {
                gameOver = true;
                winner = m.scores[0] > m.scores[1] ? 'win' : 'lose';
            }
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

function startTimer() {
    const fill = $('timer-fill');
    fill.style.width = '100%';
    fill.classList.remove('urgent');
    clearInterval(timerInterval);
    const start = Date.now();
    const duration = 10000;
    timerInterval = setInterval(() => {
        const pct = Math.max(0, 100 - ((Date.now() - start) / duration) * 100);
        fill.style.width = pct + '%';
        if (pct < 30) fill.classList.add('urgent');
        if (pct <= 0) {
            clearInterval(timerInterval);
            if (!moveChosen) {
                if (xrayScanMode) exitXrayScanMode();
                abilityActive = false;
                makeMove(Math.random() < 0.5 ? 'run' : 'jump');
            }
        }
    }, 50);
}

async function onRoundResult(msg) {
    clearInterval(timerInterval);
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    const my = msg.you;
    const opp = msg.opponent;

    // Reveal opponent ability when they use it
    if (opp.usedAbility && !oppAbility) {
        oppAbility = opp.usedAbility;
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
        if (r.usedAbility === 'double') s = '\u26A1 ' + s;
        if (r.usedAbility === 'sabotage') s = '\uD83D\uDC80 ' + s;
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
    if (myDot) {
        myDot.classList.remove('current', 'xray-trap', 'xray-safe', 'xray-scannable');
        if (my.hasTrap && my.reason === 'hit_trap') {
            // Ran into a trap — fail indicator, bomb floats above
            myDot.classList.add('fail', 'mine-hit');
            myDot.textContent = '\u2717';
        } else if (my.hasTrap && my.reason === 'dodged_trap') {
            // Jumped over a trap — success indicator, bomb floats above
            myDot.classList.add('success', 'mine-dodged');
            myDot.textContent = '\u2713';
        } else {
            const myOk = my.points > 0 && !my.sabotaged;
            myDot.classList.add(myOk ? 'success' : 'fail');
            myDot.textContent = myOk ? '\u2713' : '\u2717';
        }
    }
    if (oppDot) {
        oppDot.classList.remove('current');
        if (opp.hasTrap && opp.reason === 'hit_trap') {
            // Opponent hit our mine — dot red, bomb becomes explosion above
            oppDot.classList.remove('mine-placed');
            oppDot.classList.add('fail', 'mine-exploded');
            oppDot.textContent = '\u2717';
        } else if (opp.hasTrap && opp.reason === 'dodged_trap') {
            // Opponent dodged — dot green, dimmed bomb + checkmark above
            oppDot.classList.remove('mine-placed');
            oppDot.classList.add('mine-safe');
            oppDot.textContent = '\u2713';
        } else {
            oppDot.classList.remove('mine-placed');
            const oppOk = opp.points > 0 && !opp.sabotaged;
            oppDot.classList.add(oppOk ? 'success' : 'fail');
            oppDot.textContent = oppOk ? '\u2713' : '\u2717';
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

    // Update scores
    const mi = playerIndex;
    scores = [msg.scores[mi], msg.scores[1 - mi]];
    const s0 = $('sb-score-0'); const s1 = $('sb-score-1');
    s0.textContent = scores[0]; s1.textContent = scores[1];

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

    if (msg.gameOver) {
        await delay(300);
        showGameOver(msg.winner, msg.scores);
    } else if (msg.startOvertime) {
        await showOvertimeAnnouncement();
        isOvertime = true;
        revealedPoints = {};
        knownTrapsOnMyTrack = {};
        oppAbility = null;
        // Способность для овертайма — из msg.overtimeAbility (бот) или придёт через applyPvpRoomState (pvp)
        if (msg.overtimeAbility) {
            myAbility = msg.overtimeAbility;
            abilityUsed = false;
        } else {
            myAbility = null;
            abilityUsed = true;
        }
        // Show trap placement for overtime (1 trap on 3-dot track)
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
    } else {
        currentStep = msg.round;
        highlightCurrentDot(msg.round);
        moveChosen = false;
        showActionButtons();
        startTimer();
    }
}

function onOvertimeStart(msg) {
    isOvertime = true;
    currentStep = 0;
    // Получаем способность из overtime_start
    if (msg && msg.ability) {
        myAbility = msg.ability;
        abilityUsed = false;
    } else {
        myAbility = null;
        abilityUsed = true;
    }
    oppAbility = null;
    selectedTraps = [];
    revealedPoints = {};
    knownTrapsOnMyTrack = {};
    showScreen('game');
    $('tpoints-0').innerHTML = '';
    $('tpoints-1').innerHTML = '';
    generateGameTracks(OT_ROUNDS);
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
    startTimer();
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

function showGameOver(winner, serverScores) {
    const mi = playerIndex;
    const myScore = serverScores[mi];
    const oppScore = serverScores[1 - mi];

    if (winner === 'win') {
        playSound('win');
        $('result-emoji').textContent = '\uD83D\uDC51';
        $('result-title').textContent = '\u041F\u041E\u0411\u0415\u0414\u0410!';
        $('result-title').style.color = 'var(--success)';
        $('result-sub').textContent = '\u0422\u044B \u043E\u043A\u0430\u0437\u0430\u043B\u0441\u044F \u0445\u0438\u0442\u0440\u0435\u0435!';
    } else if (winner === 'lose') {
        playSound('lose');
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
    $('result-emoji').textContent = '\uD83D\uDEB6';
    $('result-title').textContent = '\u0421\u043E\u043F\u0435\u0440\u043D\u0438\u043A \u0443\u0448\u0451\u043B';
    $('result-title').style.color = 'var(--warn)';
    $('result-sub').textContent = '\u0418\u0433\u0440\u0430 \u043F\u0440\u0435\u0440\u0432\u0430\u043D\u0430';
    $('fs-name-0').textContent = ''; $('fs-val-0').textContent = '';
    $('fs-name-1').textContent = ''; $('fs-val-1').textContent = '';
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
