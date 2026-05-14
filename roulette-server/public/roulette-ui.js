/**
 * Roulette UI Manager
 * Manages all UI updates and interactions for the roulette game
 * Stage 3: Backend integration with API calls
 * VERSION: ROLLS_TMA_SOFT_AUDIO_20260513
 */

/** Должен совпадать с `cubic-bezier` у финального спина колеса */
const ROULETTE_SPIN_EASE = { x1: 0.06, y1: 0.72, x2: 0.12, y2: 1 };

/** Длина активной фазы раунда (сек); должен совпадать с `TIMER_DURATION` в api/roulette.js */
const ROULETTE_ROUND_TIMER_SECONDS = 8;

const ROULETTE_DEBUG =
  typeof localStorage !== 'undefined' && localStorage.getItem('rouletteDebug') === '1';
function rlog() {
  if (ROULETTE_DEBUG && typeof console !== 'undefined' && console.log) {
    console.log.apply(console, arguments);
  }
}

/** Прогресс eased [0..1] по линейному времени t∈[0..1] — как `transition-timing-function` у финального спина */
function rouletteSpinEasedProgress(linearT) {
  const t = Math.min(1, Math.max(0, linearT));
  const x1 = ROULETTE_SPIN_EASE.x1;
  const y1 = ROULETTE_SPIN_EASE.y1;
  const x2 = ROULETTE_SPIN_EASE.x2;
  const y2 = ROULETTE_SPIN_EASE.y2;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 14; k++) {
    const u = (lo + hi) / 2;
    const x = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3;
    if (x < t) lo = u;
    else hi = u;
  }
  const u = (lo + hi) / 2;
  return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3;
}

const ROULETTE_SUPABASE_URL = 'https://eolycsnxboeobasolczb.supabase.co';
const ROULETTE_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbHljc254Ym9lb2Jhc29sY3piIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3Njg0NTQsImV4cCI6MjA5MTM0NDQ1NH0.EVU6xdTy1S_9y5fgq4-AJJQHO-WPlNu3bFHgG617eJA';

const ROLLS_SEG_COLORS = [
  '#e91e63',
  '#f44336',
  '#ff9800',
  '#ffeb3b',
  '#00bcd4',
  '#7c4dff',
  '#26a69a',
  '#ab47bc',
];

const ROLLS_PRESET_DEFAULTS = [1, 2, 5, 7, 10];
const ROLLS_PRESET_HIGH_DEFAULTS = [15, 20, 30, 50, 100];
const ROLLS_STAKE_FINE_STEP = 0.1;

class RouletteUI {
  constructor() {
    this.elements = {
      // Status
      status: document.getElementById('rouletteStatusText'),
      potAmount: document.getElementById('roulettePotAmount'),
      timer: document.getElementById('rouletteTimer'),
      timerWrap: document.getElementById('rouletteTimerWrap'),
      
      // Donut wheel (Rolls-style)
      wheelContainer: document.getElementById('rouletteWheelContainer'),
      wheelSpinWrap: document.getElementById('rollsWheelSpinWrap'),
      wheelSpin: document.getElementById('rollsWheelSpin'),
      wheelConic: document.getElementById('rollsWheelConic'),
      wheelAvatars: document.getElementById('rollsWheelAvatars'),
      rollsHub: document.getElementById('rollsHub'),
      rollsHubText: document.getElementById('rollsHubText'),
      rollsRoundIdLabel: document.getElementById('rollsRoundIdLabel'),
      
      // Players
      playerCount: document.getElementById('roulettePlayerCount'),
      playersList: document.getElementById('roulettePlayersList'),
      
      // Actions (unified section)
      betSection: document.getElementById('rouletteBetSection'),
      betInput: document.getElementById('rouletteBetInput'),
      betBtn: document.getElementById('rouletteBetBtn'),
      betLabel: document.getElementById('rouletteBetLabel'),
      betHint: document.getElementById('rouletteBetHint'),
      currentBetInfo: document.getElementById('rouletteCurrentBetInfo'),
      yourBet: document.getElementById('rouletteYourBet'),
      yourChance: document.getElementById('rouletteYourChance'),
      
      // Winners / public history
      recentWinners: document.getElementById('rouletteRecentWinners'),
      publicHistoryList: document.getElementById('roulettePublicHistoryList'),
      winnerModal: document.getElementById('rouletteWinnerModal'),
      winnerName: document.getElementById('rouletteWinnerName'),
      winnerAmount: document.getElementById('rouletteWinnerAmount'),
    };

    // Debug: проверяем что элементы найдены
    rlog('[Roulette] Elements found:', {
      betBtn: !!this.elements.betBtn,
      betLabel: !!this.elements.betLabel,
      betHint: !!this.elements.betHint,
      currentBetInfo: !!this.elements.currentBetInfo,
      betInput: !!this.elements.betInput
    });

    this.state = {
      currentRound: null,
      players: [],
      isSpinning: false,
      isAnimating: false, // Локальная анимация колеса (нельзя трогать DOM колеса)
      myUserId: null,
      myBet: null,
      isLoading: false,
      isInRound: false, // Флаг: пользователь в раунде или нет
      lastServerTime: null, // Последнее серверное время
      lastLocalTime: null, // Последнее локальное время
      timerEndTime: null, // Время окончания таймера
      shownWinnerRoundId: null, // ID раунда, для которого уже показали модалку победителя
      lastPlayersKey: null, // Ключ для проверки изменения состава игроков
      wheelCardsHTML: '', // Готовый HTML карточек от сервера
      lastWinnerPhotoUrl: null, // Фото победителя (если пришло с сервера)
      /** Throttle для «последние победы» (не дергать DOM на каждом poll) */
      lastSidePanelsFetchAt: 0,
      _rollsSpotlightsKey: null,
      _lastPublicHistoryKey: null,
      isLoadingRound: false,
      lastTimerSecond: null,
      audioEnabled: false,
      spinSoundActive: false,
      /** Фильтр страницы общей истории: large | recent | lucky */
      publicHistoryFilter: 'recent',
      historyPageOpen: false,
      /** Защита от двух параллельных `loadActiveRound` на одном finished-раунде */
      presentingRoundId: null,
      /** Идемпотентность локального onTimerEnd (один раз на конкретный таймер) */
      timerEndedKey: null,
      /** Верхняя граница отображения секунд (с сервера, см. roulette_timer_duration_seconds) */
      rouletteTimerCap: null,
    };

    this._spinFinishTimer = null;
    this._spinSegmentRaf = null;

    this._lastStatusUi = null;
    this._lastPotText = null;
    this._lastMyBetUi = '';

    this.pollInterval = null;
    this.realtimeClient = null;
    this.realtimeChannel = null;
    this.realtimeReconnectTimer = null;
    this.realtimeReloadTimer = null;
    this.realtimeMode = false; // true => realtime основной, polling fallback
    this.timerInterval = null; // Интервал для плавного обновления таймера
    this.audioCtx = null;
    this.spinSoundNodes = null;
    this.init();
  }

  // ==================== ROUND UI RESET ====================
  clearRoundUIToWaiting(opts = {}) {
    const preserveWheel = !!opts.preserveWheelStrip;
    this.abortCaseReel();
    this._lastStatusUi = null;
    this._lastPotText = null;
    this._lastMyBetUi = '';
    // Скрываем таймер
    this.stopSmoothTimer();
    if (this.elements.timerWrap) {
      this.elements.timerWrap.classList.add('hidden');
    }
    if (this.elements.timer) {
      this.elements.timer.textContent = '0';
    }

    // Сброс текста статуса/банка/игроков
    this.updateStatus('waiting');
    this.updatePot(0);
    if (this.elements.playerCount) {
      this.elements.playerCount.textContent = '0';
    }

    // Не трогаем модалку — только базовый UI раунда
    if (this.elements.playersList) {
      this.elements.playersList.innerHTML = `<div class="rolls-empty">Пока нет игроков. Будь первым!</div>`;
    }

    if (!preserveWheel) {
      this.resetDonutToWaiting();
    }

    // Сброс внутренних ключей, чтобы следующий раунд точно перерисовался
    this.state.lastPlayersKey = null;
    if (!preserveWheel) {
      this.state.wheelCardsHTML = '';
    }
    this.state.currentRound = null;
    this.state.players = [];
    this.state.myBet = null;
    this.state.lastTimerSecond = null;
    this.stopSpinSound();
    this.updateBetButton(false);
    this.syncWheelIdleMotion();
  }

  /** Сброс полосы колеса после модалки победителя (когда ранее вызывали clearRoundUIToWaiting с preserveWheelStrip). */
  resetWheelStripToWaiting() {
    this.resetDonutToWaiting();
  }

  shouldWheelIdleSpin() {
    if (this.state.isAnimating || this.state.isSpinning) return false;
    if (this.state.historyPageOpen) return false;
    if (this.elements.winnerModal?.classList.contains('show')) return false;
    return true;
  }

  stopWheelIdle() {
    const wrap = this.elements.wheelSpinWrap;
    if (!wrap) return;
    wrap.classList.remove('rolls-wheel-spin-wrap--idle');
    try {
      wrap.getAnimations?.().forEach((a) => a.cancel());
    } catch {}
    wrap.style.transform = '';
    wrap.style.transition = '';
  }

  syncWheelIdleMotion() {
    const wrap = this.elements.wheelSpinWrap;
    if (!wrap) return;
    const want = this.shouldWheelIdleSpin();
    const has = wrap.classList.contains('rolls-wheel-spin-wrap--idle');
    // Не перезапускать анимацию при каждом poll: stop+add класс сбрасывал keyframes → рывки туда‑сюда
    if (want === has) return;
    if (want) {
      this.stopWheelIdle();
      wrap.classList.add('rolls-wheel-spin-wrap--idle');
    } else {
      this.stopWheelIdle();
    }
  }

  openPublicHistoryPage() {
    this.state.historyPageOpen = true;
    this.stopWheelIdle();
    document.getElementById('rollsMainGameView')?.classList.add('hidden');
    const hv = document.getElementById('rollsPublicHistoryView');
    if (hv) {
      hv.classList.remove('hidden');
      hv.setAttribute('aria-hidden', 'false');
    }
    this.loadPublicHistory(true).catch(() => {});
  }

  closePublicHistoryPage() {
    if (!this.state.historyPageOpen) {
      document.getElementById('rollsPublicHistoryView')?.classList.add('hidden');
      document.getElementById('rollsMainGameView')?.classList.remove('hidden');
      return;
    }
    this.state.historyPageOpen = false;
    document.getElementById('rollsPublicHistoryView')?.classList.add('hidden');
    document.getElementById('rollsPublicHistoryView')?.setAttribute('aria-hidden', 'true');
    document.getElementById('rollsMainGameView')?.classList.remove('hidden');
    this.syncWheelIdleMotion();
  }

  setPublicHistoryFilter(filter) {
    const f = String(filter || '').toLowerCase();
    if (f !== 'large' && f !== 'recent' && f !== 'lucky') return;
    this.state.publicHistoryFilter = f;
    document.querySelectorAll('.rolls-public-history__filter').forEach((btn) => {
      const on = btn.getAttribute('data-rolls-history-filter') === f;
      btn.classList.toggle('is-active', on);
    });
    this.state._lastPublicHistoryKey = null;
    this.loadPublicHistory(true).catch(() => {});
  }

  renderPublicHistory(rows) {
    const listEl = this.elements.publicHistoryList;
    if (!listEl) return;
    if (!rows || !rows.length) {
      listEl.innerHTML = `<div class="rolls-empty">Пока нет записей</div>`;
      return;
    }
    listEl.innerHTML = rows
      .map((w) => {
        const date = new Date(w.created_at || Date.now());
        const timeStr = date.toLocaleString('ru-RU', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
        const name = w.winner_display_name || 'Игрок';
        const ton = parseFloat(w.winner_amount || 0);
        const ch = parseFloat(w.winner_chance_percent || 0);
        const pot = parseFloat(w.total_pot || 0);
        const pc = Number(w.players_count || 0);
        const initial = this.escapeHtml(String(name).charAt(0).toUpperCase());
        const avatarContent = w.photo_url
          ? `<img src="${this.escapeHtml(w.photo_url)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><div style="display:none; width:100%; height:100%; align-items:center; justify-content:center; font-weight:900; font-size:14px; color:#07110c;">${initial}</div>`
          : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:14px; color:#07110c;">${initial}</div>`;
        return `
        <div class="pill" style="padding:10px 12px;">
          <div style="display:flex; align-items:center; gap:10px; flex:1;">
            <div style="width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, #fbbf24, #f59e0b); overflow:hidden; flex-shrink:0;">
              ${avatarContent}
            </div>
            <div style="flex:1; min-width:0;">
              <div style="font-weight:800; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(name)}</div>
              <div style="font-size:11px; color:var(--muted);">${timeStr} • ${pc} игроков • банк ${pot.toFixed(2)} TON</div>
            </div>
          </div>
          <div style="text-align:right; margin-top:8px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <div style="font-size:11px; color:var(--muted);">Шанс ${Number.isFinite(ch) ? ch.toFixed(1) : '—'}%</div>
            <div>
              <div style="font-size:16px; font-weight:900; color:var(--accent);">${ton.toFixed(2)}</div>
              <div style="font-size:10px; color:var(--muted);">TON выигрыш</div>
            </div>
          </div>
        </div>`;
      })
      .join('');
  }

  async loadPublicHistory(force = false) {
    const listEl = this.elements.publicHistoryList;
    if (!listEl) return;
    const filter = this.state.publicHistoryFilter || 'recent';
    if (force) {
      listEl.innerHTML = `<div class="rolls-empty">Загрузка…</div>`;
    }
    try {
      const data = await this.callAPI('getPublicRouletteHistory', { filter, limit: 45 });
      const list = data.history || [];
      const fp = `${filter}|${list.map((r) => `${r.id}|${r.created_at}`).join('~')}`;
      if (!force && fp === this.state._lastPublicHistoryKey) return;
      this.state._lastPublicHistoryKey = fp;
      this.renderPublicHistory(list);
    } catch (error) {
      console.error('Failed to load public roulette history:', error);
      listEl.innerHTML = `<div class="rolls-empty">Не удалось загрузить историю</div>`;
    }
  }

  resetDonutToWaiting() {
    this.abortCaseReel();
    const spin = this.elements.wheelSpin;
    if (spin) {
      spin.style.transition = 'none';
      spin.style.transform = 'rotate(0deg)';
    }
    this.clearWinnerWheelFlash();
    if (this.elements.wheelConic) this.applyWaitingDonut();
    if (this.elements.wheelAvatars) this.elements.wheelAvatars.innerHTML = '';
    if (this.elements.rollsHubText) {
      this.elements.rollsHubText.className = 'rolls-hub__text';
      this.elements.rollsHubText.textContent = 'Ожидание';
    }
    this.elements.rollsHub?.classList.add('rolls-hub--wait');
    this.state.wheelCardsHTML = '';
    this.syncWheelIdleMotion();
  }

  closeRouletteWinnerModal() {
    if (this._winnerModalCloseTimer) {
      clearTimeout(this._winnerModalCloseTimer);
      this._winnerModalCloseTimer = null;
    }
    this.elements.winnerModal?.classList.remove('show');
    this.resetWheelStripToWaiting();
    this.state.lastSidePanelsFetchAt = 0;
    this.loadRecentWinners(true).catch(() => {});
    this.syncWheelIdleMotion();
  }

  abortCaseReel() {
    if (this._spinFinishTimer) {
      clearTimeout(this._spinFinishTimer);
      this._spinFinishTimer = null;
    }
    this.stopSpinSegmentTickLoop();
    this.stopWheelIdle();
    const spin = this.elements.wheelSpin;
    if (spin) {
      try {
        spin.getAnimations?.().forEach((a) => a.cancel());
      } catch {}
      spin.style.transition = 'none';
    }
  }

  openBetModal() {
    const openBtn = document.getElementById('rouletteBetBtn');
    if (!openBtn || openBtn.disabled) return;
    this.primeAudioOnGesture();
    const m = document.getElementById('rouletteBetModal');
    if (!m) return;
    m.classList.add('show');
    m.setAttribute('aria-hidden', 'false');
    this.syncStakeDisplay();
    this.refreshStakeStepperLockFromBetBtn();
  }

  closeBetModal() {
    const m = document.getElementById('rouletteBetModal');
    if (!m) return;
    m.classList.remove('show');
    m.setAttribute('aria-hidden', 'true');
  }

  init() {
    // Setup event listeners
    this.elements.betBtn?.addEventListener('click', () => this.openBetModal());
    document.getElementById('rouletteBetConfirmBtn')?.addEventListener('click', () => this.handleBet());
    const betModalEl = document.getElementById('rouletteBetModal');
    document.getElementById('rouletteBetModalClose')?.addEventListener('click', () => this.closeBetModal());
    betModalEl?.addEventListener('click', (e) => {
      if (e.target === betModalEl) this.closeBetModal();
    });
    document.getElementById('rollsHistoryBackBtn')?.addEventListener('click', () => this.closePublicHistoryPage());
    document.getElementById('rollsPublicHistoryView')?.addEventListener('click', (e) => {
      const pill = e.target && e.target.closest && e.target.closest('[data-rolls-history-filter]');
      if (!pill) return;
      const f = pill.getAttribute('data-rolls-history-filter');
      if (f) this.setPublicHistoryFilter(f);
    });

    document.getElementById('rollsHistoryBtn')?.addEventListener('click', () => {
      this.openPublicHistoryPage();
    });

    this.initStakeControls();

    // Initialize with empty state
    this.updateStatus('waiting');
    this.updatePot(0);
    this.updatePlayers([]);
    this.updateBetButton(false); // Начальное состояние: не в раунде
    
    // Get Telegram user ID
    if (typeof window.Telegram !== 'undefined' && window.Telegram.WebApp) {
      const user = window.Telegram.WebApp.initDataUnsafe?.user;
      if (user) {
        this.state.myUserId = user.id;
      }
    }
    this.syncWheelIdleMotion();
  }

  // ==================== HAPTIC ====================
  hapticImpact(style = 'light') {
    return;
  }

  hapticNotify(type = 'success') {
    return;
  }

  // ==================== AUDIO (мягкие TMA-стиль, Web Audio API) ====================
  isSoundEnabled() {
    try {
      const el = document.getElementById('setSound');
      if (el) return !!el.checked;
    } catch {}
    return true;
  }

  ensureAudioContext() {
    if (this.audioCtx) return this.audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      this.audioCtx = new Ctx();
      return this.audioCtx;
    } catch {
      return null;
    }
  }

  /** Разблокировка AudioContext после жеста (TMA / iOS) */
  primeAudioOnGesture() {
    const ctx = this.ensureAudioContext();
    if (ctx && ctx.state === 'suspended') {
      try {
        void ctx.resume();
      } catch {}
    }
  }

  /**
   * Короткий мягкий тон. `when` — абсолютное время AudioContext (для «аккордов»).
   */
  playTone({ freq = 440, durationMs = 80, gain = 0.02, type = 'sine', when = null } = {}) {
    if (!this.isSoundEnabled()) return;
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        void ctx.resume();
      } catch {}
    }
    const now = when != null ? when : ctx.currentTime;
    const dur = Math.max(0.022, Math.min(0.42, durationMs / 1000));
    const g0 = Math.min(0.06, Math.max(0.0006, gain));
    const osc = ctx.createOscillator();
    const gn = ctx.createGain();
    osc.type = type === 'triangle' ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(freq, now);
    const a0 = 0.0001;
    gn.gain.setValueAtTime(a0, now);
    gn.gain.exponentialRampToValueAtTime(g0, now + 0.004);
    gn.gain.exponentialRampToValueAtTime(a0, now + dur);
    osc.connect(gn).connect(ctx.destination);
    try {
      osc.start(now);
      osc.stop(now + dur + 0.04);
    } catch {}
  }

  /** Тихий тик UI: шаг ставки / пресет */
  playStakeUiTick() {
    this.playTone({ freq: 605, durationMs: 22, gain: 0.013, type: 'sine' });
  }

  /** Мягкий звук при принятии ставки (вход в раунд) */
  playBetPlacedSoftSound() {
    if (!this.isSoundEnabled()) return;
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        void ctx.resume();
      } catch {}
    }
    const t0 = ctx.currentTime;
    this.playTone({ freq: 392, durationMs: 46, gain: 0.017, type: 'sine', when: t0 });
    this.playTone({ freq: 494, durationMs: 50, gain: 0.014, type: 'sine', when: t0 + 0.036 });
  }

  /** Мягкий звук при повышении ставки */
  playBetRaiseSoftSound() {
    if (!this.isSoundEnabled()) return;
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        void ctx.resume();
      } catch {}
    }
    const t0 = ctx.currentTime;
    this.playTone({ freq: 523, durationMs: 44, gain: 0.018, type: 'sine', when: t0 });
    this.playTone({ freq: 659, durationMs: 38, gain: 0.012, type: 'sine', when: t0 + 0.032 });
  }

  /** Тик при смене сектора под указателем во время финального спина */
  playSpinSegmentCrossSound() {
    this.playTone({ freq: 328, durationMs: 34, gain: 0.015, type: 'sine' });
  }

  playClickSound() {
    this.playStakeUiTick();
  }

  playTickSound() {
    this.playTone({ freq: 720, durationMs: 28, gain: 0.011, type: 'sine' });
  }

  playResultSound(isWin) {
    if (isWin) {
      this.playTone({ freq: 587, durationMs: 95, gain: 0.019, type: 'sine' });
      this.playTone({ freq: 784, durationMs: 110, gain: 0.014, type: 'sine' });
    } else {
      this.playTone({ freq: 330, durationMs: 120, gain: 0.015, type: 'sine' });
    }
  }

  startSpinSound() {
    return;
  }

  stopSpinSound() {
    this.state.spinSoundActive = false;
  }

  cumulativeSegmentDegreesForRows(rows) {
    const list = this.sortPlayersForWheel(rows);
    if (!list.length) return [0, 360];
    const weights = list.map((p) => Math.max(0.35, Number(p.chance) || 0));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const cum = [0];
    weights.forEach((w) => {
      cum.push(cum[cum.length - 1] + (w / sum) * 360);
    });
    cum[cum.length - 1] = 360;
    return cum;
  }

  pointerSectorIndexFromRotation(rotationDeg, cum) {
    const ang = ((-rotationDeg % 360) + 360) % 360;
    const eps = 1e-3;
    for (let i = 0; i < cum.length - 1; i++) {
      if (ang >= cum[i] - eps && ang < cum[i + 1] - eps) return i;
    }
    return Math.max(0, cum.length - 2);
  }

  stopSpinSegmentTickLoop() {
    if (this._spinSegmentRaf != null) {
      cancelAnimationFrame(this._spinSegmentRaf);
      this._spinSegmentRaf = null;
    }
  }

  /**
   * Звук при пересечении границы сектора игрока под указателем.
   * Угол берётся из той же easing-кривой, что и CSS `transform` спина.
   */
  startSpinSegmentTickLoop({ endDeg, durationMs, rows }) {
    this.stopSpinSegmentTickLoop();
    const cum = this.cumulativeSegmentDegreesForRows(rows);
    if (cum.length < 3) return;

    const t0 = performance.now();
    let lastIdx = -1;
    let lastSoundAt = -9999;

    const step = () => {
      const elapsed = performance.now() - t0;
      if (elapsed > durationMs + 140) {
        this._spinSegmentRaf = null;
        return;
      }
      const linear = Math.min(1, elapsed / durationMs);
      const eased = rouletteSpinEasedProgress(linear);
      const rot = eased * endDeg;
      const idx = this.pointerSectorIndexFromRotation(rot, cum);

      if (lastIdx >= 0 && idx !== lastIdx && elapsed - lastSoundAt > 38) {
        this.playSpinSegmentCrossSound();
        lastSoundAt = elapsed;
      }
      lastIdx = idx;
      this._spinSegmentRaf = requestAnimationFrame(step);
    };
    this._spinSegmentRaf = requestAnimationFrame(step);
  }

  // ==================== DATA SYNC MODE ====================
  initRealtimeClient() {
    if (this.realtimeClient) return true;
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      console.warn('[Roulette] Supabase client is unavailable in window');
      return false;
    }
    try {
      this.realtimeClient = window.supabase.createClient(
        ROULETTE_SUPABASE_URL,
        ROULETTE_SUPABASE_ANON_KEY
      );
      return true;
    } catch (e) {
      console.warn('[Roulette] Failed to create Supabase realtime client:', e?.message || e);
      return false;
    }
  }

  scheduleRealtimeReload() {
    if (this.realtimeReloadTimer) return;
    this.realtimeReloadTimer = setTimeout(() => {
      this.realtimeReloadTimer = null;
      if (this.state.isAnimating) return; // не вмешиваемся в финальную анимацию
      this.loadActiveRound().catch(() => {});
    }, 120);
  }

  startRealtime() {
    if (!this.initRealtimeClient()) return false;
    if (!this.realtimeClient || this.realtimeChannel) return true;

    const channelName = `roulette-live-${Math.random().toString(36).slice(2, 10)}`;
    this.realtimeChannel = this.realtimeClient
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'roulette_rounds' },
        () => this.scheduleRealtimeReload()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'roulette_bets' },
        () => this.scheduleRealtimeReload()
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.realtimeMode = true;
          // Polling НЕ выключаем: это страховка, если realtime-событие потерялось.
          this.startPolling();
          this.loadActiveRound().catch(() => {});
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.realtimeMode = false;
          this.startPolling(); // fallback
          this.stopRealtime();
          if (!this.realtimeReconnectTimer) {
            this.realtimeReconnectTimer = setTimeout(() => {
              this.realtimeReconnectTimer = null;
              this.startRealtime();
            }, 2500);
          }
        }
      });

    return true;
  }

  stopRealtime() {
    if (this.realtimeReconnectTimer) {
      clearTimeout(this.realtimeReconnectTimer);
      this.realtimeReconnectTimer = null;
    }
    if (this.realtimeReloadTimer) {
      clearTimeout(this.realtimeReloadTimer);
      this.realtimeReloadTimer = null;
    }
    if (this.realtimeClient && this.realtimeChannel) {
      try {
        this.realtimeClient.removeChannel(this.realtimeChannel);
      } catch {}
    }
    this.realtimeChannel = null;
  }

  startDataSync() {
    // Realtime как основной режим, polling как fallback.
    const realtimeStarted = this.startRealtime();
    if (!realtimeStarted) {
      this.startPolling();
    } else {
      // Пока не получили SUBSCRIBED, держим polling как временный fallback.
      this.startPolling();
    }
  }

  stopDataSync() {
    this.abortCaseReel();
    this.stopPolling();
    this.stopRealtime();
    this.stopSmoothTimer();
    this.stopSpinSound();
    this.realtimeMode = false;
  }

  // ==================== API CALLS ====================
  async callAPI(action, params = {}) {
    try {
      const initData = typeof window.Telegram !== 'undefined' && window.Telegram.WebApp
        ? window.Telegram.WebApp.initData
        : '';

      const response = await fetch('/api/roulette', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          initData,
          ...params
        })
      });

      // Проверяем что ответ успешный
      if (!response.ok) {
        const text = await response.text();
        console.error('[Roulette] Server error:', response.status, text);
        throw new Error(`Ошибка сервера (${response.status})`);
      }

      // Проверяем что ответ - это JSON
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.error('[Roulette] Invalid response type:', contentType, 'Body:', text.substring(0, 200));
        throw new Error('Сервер вернул некорректный ответ');
      }

      const data = await response.json();
      
      if (!data.ok) {
        throw new Error(data.error || 'API error');
      }

      return data;
    } catch (error) {
      console.error('[Roulette] API call failed:', action, error);
      
      // Если это ошибка парсинга JSON - показываем понятное сообщение
      if (error.message && error.message.includes('JSON')) {
        throw new Error('Ошибка связи с сервером');
      }
      
      throw error;
    }
  }

  generateRequestId(prefix) {
    const p = String(prefix || "rq");
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `${p}_${crypto.randomUUID()}`;
      }
    } catch {}
    return `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  rouletteTimerCapSeconds() {
    const c = this.state.rouletteTimerCap;
    if (typeof c === 'number' && Number.isFinite(c) && c > 0 && c <= 240) return c;
    return ROULETTE_ROUND_TIMER_SECONDS;
  }

  async loadActiveRound() {
    try {
      // Защита от гонок (polling + realtime одновременно).
      if (this.state.isLoadingRound) return;
      this.state.isLoadingRound = true;

      // Во время локальной анимации не трогаем UI из polling,
      // иначе можно сбросить DOM колеса и получить "пропали карточки".
      if (this.state.isAnimating) {
        this.state.isLoadingRound = false;
        return;
      }

      const data = await this.callAPI('getActiveRound');
      const td = Number(data?.roulette_timer_duration_seconds);
      if (Number.isFinite(td) && td >= 3 && td <= 240) {
        this.state.rouletteTimerCap = td;
      }
      
      if (data.round) {
        const previousStatus = this.state.currentRound?.status;
        const previousRoundId = this.state.currentRound?.id;
        
        this.state.currentRound = data.round;

        if (previousRoundId != null && String(data.round.id) !== String(previousRoundId)) {
          this.state.timerEndedKey = null;
          this.state._rollsSpotlightsKey = null;
          this.state._lastPublicHistoryKey = null;
          this._lastPotText = null;
        }

        // ВАЖНО: `isSpinning` должен означать "идёт анимация/колесо залочено",
        // а НЕ "надо остановить polling навсегда". Polling должен продолжаться,
        // чтобы увидеть `finished` и показать всем результат.
        // Update UI
        // Пока локально идет спин/анимация - держим статус "Розыгрыш..."
        const effectiveStatus = (data.round.status === 'spinning' || this.state.isSpinning || this.state.isAnimating)
          ? 'spinning'
          : data.round.status;
        this.updateStatus(effectiveStatus);
        this.updatePot(parseFloat(data.round.pot_amount));

        if (data.round && data.round.id && this.elements.rollsRoundIdLabel) {
          this.elements.rollsRoundIdLabel.textContent = `ИГРА #${String(data.round.id).slice(0, 8)}`;
        }

        // Если сервер отдал фото победителя (для finished) — запомним для модалки.
        if (data.winner && data.winner.photo_url) {
          this.state.lastWinnerPhotoUrl = data.winner.photo_url;
        } else {
          this.state.lastWinnerPhotoUrl = null;
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Если идет спин - НЕ обрабатываем игроков вообще!
        // Во время спина НЕ трогаем DOM (players list / wheel), но state.players
        // нам всё равно полезен (например для имени/аватара победителя).
        if (data.round.status !== 'spinning' && data.round.status !== 'finished' && !this.state.isAnimating && !this.state.isSpinning) {
          // Process players - ВАЖНО: проверяем что data.bets существует
          rlog('[Roulette] Processing bets:', data.bets);
          
          const players = (data.bets || []).map(bet => {
            const player = {
              id: bet.user_id,
              name: bet.display_name || 'Player',
              bet: parseFloat(bet.bet_amount) || 0,
              chance: parseFloat(bet.chance_percent) || 0,
              photoUrl: bet.photo_url || null
            };
            rlog('[Roulette] Processed player:', player);
            return player;
          }).filter(p => p.id && p.name); // Фильтруем невалидных игроков
          
          rlog('[Roulette] Total players after processing:', players.length);
          
          // DEBUG: Выводим информацию о каждом игроке
          players.forEach((p, i) => {
            rlog(`[Roulette] Player ${i}:`, p.name, 'Chance:', p.chance, 'Bet:', p.bet, 'ID:', p.id);
          });
          
          // DEBUG для TMA: показываем toast с информацией о игроках
          if (players.length > 0) {
            const debugInfo = players.map(p => `${p.name}: ${p.chance.toFixed(1)}%`).join(', ');
            rlog('[DEBUG TMA] Players:', debugInfo);
          }
          
          // Обновляем игроков (только если НЕ идет спин)
          rlog('[Roulette] Updating players, count:', players.length, 'status:', data.round.status);
          this.updatePlayers(players);
        } else {
          // Во время спина не обновляем DOM, но обновим state.players (без рендера),
          // чтобы showWinner смог найти имя/аватар.
          const players = (data.bets || []).map(bet => ({
            id: bet.user_id,
            name: bet.display_name || 'Player',
            bet: parseFloat(bet.bet_amount) || 0,
            chance: parseFloat(bet.chance_percent) || 0,
            photoUrl: bet.photo_url || null
          })).filter(p => p.id && p.name);
          this.state.players = players;
        }
        
        // Check if I'm in this round - ВАЖНО: сравниваем как строки!
        const myUserIdStr = String(this.state.myUserId);
        const myBet = data.bets.find(b => String(b.user_id) === myUserIdStr);
        
        if (myBet) {
          this.state.myBet = myBet;
          this.updateBetButton(true); // В раунде
          this.updateMyBetInfo(parseFloat(myBet.bet_amount), parseFloat(myBet.chance_percent));
        } else {
          this.state.myBet = null;
          this._lastMyBetUi = '';
          this.updateBetButton(false); // Не в раунде
          this.updateMyBetInfo(0, 0);
        }
        
        // Handle timer - используем СЕРВЕРНОЕ время из API с локальной интерполяцией
        if (effectiveStatus === 'active' && data.round.timer_ends_at) {
          const endsAt = new Date(data.round.timer_ends_at);
          const serverNow = new Date(data.serverTime);
          
          // Сохраняем синхронизацию времени
          this.state.lastServerTime = serverNow.getTime();
          this.state.lastLocalTime = Date.now();
          this.state.timerEndTime = endsAt.getTime();
          
          // Запускаем локальный таймер для плавного отображения
          this.startSmoothTimer();
          // Показать значение сразу (без ожидания первого тика interval),
          // чтобы старт был визуально одинаковым у всех.
          const cap = this.rouletteTimerCapSeconds();
          const initialRemaining = Math.max(0, Math.min(
            cap,
            Math.ceil((this.state.timerEndTime - this.state.lastServerTime + 999) / 1000)
          ));
          this.updateTimerDisplay(initialRemaining);
          
          if (this.elements.timerWrap) {
            this.elements.timerWrap.classList.remove('hidden');
          }
        } else if (effectiveStatus === 'spinning') {
          // Серверный spinning: один клиент уже мог выставить isSpinning в onTimerEnd — остальным тоже.
          if (data.round.status === 'spinning') {
            this.state.isSpinning = true;
          }
          // Раунд крутится - скрываем таймер и блокируем кнопку
          this.stopSmoothTimer();
          if (this.elements.timerWrap) {
            this.elements.timerWrap.classList.add('hidden');
          }
          this.disableBetButton();
          // НЕ запускаем pre-spin: он давал второй «накладывающийся» прокрут и сброс translateX перед финалом.
          this.startSpinSound();
        } else {
          this.stopSpinSound();
          this.stopSmoothTimer();
          if (this.elements.timerWrap) {
            this.elements.timerWrap.classList.add('hidden');
          }
        }
        
        // ВАЖНО: Если раунд только что завершился — один проход анимации + модалка.
        if (data.round.status === 'finished' &&
            data.round.winner_user_id &&
            this.state.shownWinnerRoundId !== data.round.id) {
          const finishRoundId = data.round.id;

          if (this.state.presentingRoundId !== finishRoundId) {
            this.state.presentingRoundId = finishRoundId;
            rlog('[Roulette] Round finished, starting case-opening spin');

            this.state.isSpinning = true;
            this.state.isAnimating = true;
            this.stopSpinSound();

            this.disableBetButton();
            this.updateStatus('spinning');

            try {
              rlog('[Roulette] Starting donut spin');
              const outcome = await this.playFinishedRoundReveal({
                round: data.round,
                bets: data.bets || [],
                winner: data.winner,
              });
              this.state.shownWinnerRoundId = finishRoundId;
              rlog('[Roulette] Reel settled; pointer winner:', outcome.userId);

              this.showWinner(
                outcome.displayName,
                outcome.amount,
                outcome.userId,
                outcome.photoUrl,
                outcome.chancePercent != null ? outcome.chancePercent : null
              );

              this.clearRoundUIToWaiting({ preserveWheelStrip: true });

              if (String(data.round.winner_user_id) === myUserIdStr) {
                if (window.userState && typeof window.userState.balance === 'number') {
                  window.userState.balance = window.userState.balance + parseFloat(data.round.winner_amount);
                  window.userState.prevBalance = window.userState.balance;

                  if (typeof window.refreshBalanceUiAfterHydrate === 'function') {
                    window.refreshBalanceUiAfterHydrate();
                  }
                }
              }
            } catch (e) {
              console.error('[Roulette] Case-opening spin failed:', e);
            } finally {
              this.state.presentingRoundId = null;
              this.state.isAnimating = false;
              this.state.isSpinning = false;
              this.enableBetButton();
            }
          }
        }
        
      } else {
        // No active round - это нормально после завершения
        rlog('[Roulette] No active round from API');
        
        // КРИТИЧЕСКИ ВАЖНО: Если идет спин - НЕ ТРОГАЕМ НИЧЕГО!
        if (this.state.isSpinning) {
          rlog('[Roulette] 🔒 Spin in progress - NOT clearing anything');
          return; // Полностью игнорируем отсутствие раунда
        }
        
        if (this.elements.rollsRoundIdLabel) {
          this.elements.rollsRoundIdLabel.textContent = '';
        }

        this.state.currentRound = null;
        this.state.myBet = null;
        this._lastMyBetUi = '';
        this.updateStatus('waiting');
        this.updatePot(0);
        this.updatePlayers([]);
        this.updateBetButton(false); // Не в раунде
        this.stopSmoothTimer();
        if (this.elements.timerWrap) {
          this.elements.timerWrap.classList.add('hidden');
        }
      }
      
      this.maybeRefreshRouletteSidePanels();
    } catch (error) {
      console.error('[Roulette] Failed to load active round:', error);
      // НЕ показываем toast - тихо логируем ошибку
    } finally {
      this.state.isLoadingRound = false;
      this.syncWheelIdleMotion();
    }
  }

  startPolling() {
    // Страховочный polling для гарантии авто-обновления даже при проблемах realtime.
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    
    this.pollInterval = setInterval(() => {
      // Во время спина polling ДОЛЖЕН продолжаться, чтобы увидеть `finished`.
      // UI-рендер колеса уже защищён через isSpinning (renderWheel/updatePlayers).
      if (!this.state.isAnimating) {
        this.loadActiveRound();
      }
    }, 480);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  updateBetButton(isInRound) {
    rlog('[Roulette] updateBetButton called, isInRound:', isInRound);
    this.state.isInRound = isInRound;
    
    // Ищем элементы заново (на случай если они не были найдены в конструкторе)
    const betBtn = document.getElementById('rouletteBetBtn');
    const betLabel = document.getElementById('rouletteBetLabel');
    const betHint = document.getElementById('rouletteBetHint');
    const currentBetInfo = document.getElementById('rouletteCurrentBetInfo');
    
    if (isInRound) {
      // Пользователь в раунде - показываем режим повышения
      if (betBtn) {
        betBtn.textContent = 'Повысить ставку';
      }
      if (betLabel) {
        betLabel.textContent = 'Повысить ставку';
      }
      if (betHint) {
        betHint.textContent = 'Минимальное повышение: 0.1 TON';
      }
      if (currentBetInfo) {
        currentBetInfo.classList.remove('hidden');
      }
    } else {
      // Пользователь не в раунде - показываем режим входа
      if (betBtn) {
        betBtn.textContent = 'Войти в игру';
      }
      if (betLabel) {
        betLabel.textContent = 'Сделать ставку';
      }
      if (betHint) {
        betHint.textContent = 'Минимальная ставка: 0.1 TON';
      }
      if (currentBetInfo) {
        currentBetInfo.classList.add('hidden');
      }
    }
    const confirmBtn = document.getElementById('rouletteBetConfirmBtn');
    if (confirmBtn && !confirmBtn.disabled) {
      confirmBtn.textContent = isInRound ? 'Повысить ставку' : 'Войти в раунд';
    }
  }

  updateMyBetInfo(betAmount, chancePercent) {
    const key = `${Number(betAmount).toFixed(2)}|${Number(chancePercent).toFixed(1)}`;
    if (this._lastMyBetUi === key) return;
    this._lastMyBetUi = key;
    // Ищем элементы заново
    const yourBet = document.getElementById('rouletteYourBet');
    const yourChance = document.getElementById('rouletteYourChance');
    
    if (yourBet) {
      yourBet.textContent = betAmount.toFixed(2);
    }
    if (yourChance) {
      yourChance.textContent = chancePercent.toFixed(1);
    }
  }

  // ==================== STATUS UPDATES ====================
  updateStatus(status) {
    if (this._lastStatusUi === status) return;
    const statusMap = {
      waiting: { text: 'Ожидание игроков', color: '#888' },
      active: { text: 'Идет прием ставок', color: '#8CFFC1' },
      spinning: { text: 'Розыгрыш...', color: '#fbbf24' },
      finished: { text: 'Раунд завершен', color: '#888' },
    };

    const config = statusMap[status] || statusMap.waiting;
    if (this.elements.status) {
      this.elements.status.textContent = config.text;
      this.elements.status.style.color = config.color;
    }
    if (this.elements.rollsHubText && !this.state.isAnimating) {
      if (status === 'spinning') {
        this.elements.rollsHubText.className = 'rolls-hub__text';
        this.elements.rollsHubText.textContent = 'Розыгрыш…';
        this.elements.rollsHub?.classList.remove('rolls-hub--wait');
      }
    }
    this._lastStatusUi = status;
  }

  updatePot(amount) {
    const t = Number(amount).toFixed(2);
    if (this._lastPotText === t) return;
    this._lastPotText = t;
    if (this.elements.potAmount) {
      this.elements.potAmount.textContent = t;
    }
  }

  startSmoothTimer() {
    // Останавливаем предыдущий таймер
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
    
    // Обновляем таймер каждые 100ms для плавности
    this.timerInterval = setInterval(() => {
      if (!this.state.timerEndTime || !this.state.lastServerTime || !this.state.lastLocalTime) {
        return;
      }
      
      // Вычисляем текущее серверное время на основе локального времени
      const localElapsed = Date.now() - this.state.lastLocalTime;
      const estimatedServerTime = this.state.lastServerTime + localElapsed;
      
      // Вычисляем оставшееся время
      // +999ms дает стабильный визуальный старт с полного TIMER_DURATION на большинстве устройств.
      const cap = this.rouletteTimerCapSeconds();
      const remaining = Math.max(
        0,
        Math.min(cap, Math.ceil((this.state.timerEndTime - estimatedServerTime + 999) / 1000))
      );
      
      this.updateTimerDisplay(remaining);
      
      // Если время истекло - запускаем спин
      if (remaining <= 0 && !this.state.isSpinning) {
        if (this.elements.timerWrap) {
          this.elements.timerWrap.classList.add('hidden');
        }
        this.stopSmoothTimer();
        this.onTimerEnd();
      }
    }, 100);
  }
  
  stopSmoothTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
  
  updateTimerDisplay(seconds) {
    if (this.elements.timer) {
      this.elements.timer.textContent = seconds;

      const cap = this.rouletteTimerCapSeconds();
      if (seconds <= 2) {
        this.elements.timer.style.color = '#ff4444';
      } else if (seconds <= Math.max(3, Math.ceil(cap * 0.55))) {
        this.elements.timer.style.color = '#fbbf24';
      } else {
        this.elements.timer.style.color = '#ff5c5c';
      }

      if (seconds !== this.state.lastTimerSecond) {
        if (seconds > 0 && seconds <= 2) {
          this.playTickSound();
          this.hapticImpact('light');
        }
        this.state.lastTimerSecond = seconds;
      }
    }
    if (this.elements.rollsHubText && this.state.currentRound?.status === 'active') {
      const cap = this.rouletteTimerCapSeconds();
      const s = Math.max(0, Math.min(cap, Number(seconds) || 0));
      this.elements.rollsHubText.className = 'rolls-hub__text rolls-hub__text--timer';
      this.elements.rollsHubText.textContent = `00:${String(s).padStart(2, '0')}`;
      this.elements.rollsHub?.classList.remove('rolls-hub--wait');
    }
  }

  onTimerEnd() {
    if (this.state.isSpinning) return;

    const timerKey = `${this.state.currentRound?.id ?? ''}:${this.state.timerEndTime ?? ''}`;
    if (this.state.timerEndedKey === timerKey) return;
    this.state.timerEndedKey = timerKey;

    rlog('[Roulette] ⏰ Timer ended - LOCKING WHEEL');

    this.state.isSpinning = true;
    
    // ВАЖНО: Сохраняем текущее состояние карточек чтобы их нельзя было удалить
    rlog('[Roulette] Current wheel state:', this.state.players?.length || 0, 'players');
    rlog('[Roulette] Current players:', this.state.players.length);
    
    this.updateStatus('spinning');
    this.startSpinSound();
    this.hapticImpact('medium');
    // Инициатор спина сам останавливает polling, поэтому таймер нужно скрыть прямо тут
    this.stopSmoothTimer();
    if (this.elements.timerWrap) {
      this.elements.timerWrap.classList.add('hidden');
    }
    
    // Блокируем кнопку ставки
    this.disableBetButton();
    
    this.syncWheelIdleMotion();
    // Сервер сам переводит раунд в spinning/finished; сразу тянем состояние.
    this.loadActiveRound().catch(() => {});
    this.startDataSync();
  }

  disableBetButton() {
    const betBtn = document.getElementById('rouletteBetBtn');
    const betInput = document.getElementById('rouletteBetInput');
    const confirmBtn = document.getElementById('rouletteBetConfirmBtn');

    if (betBtn) {
      betBtn.disabled = true;
      betBtn.textContent = 'Идет розыгрыш...';
    }
    if (confirmBtn) {
      confirmBtn.disabled = true;
    }
    if (betInput) {
      betInput.disabled = true;
    }
    this.setStakeStepperDisabled(true);
    this.closeBetModal();
  }

  enableBetButton() {
    const betBtn = document.getElementById('rouletteBetBtn');
    const betInput = document.getElementById('rouletteBetInput');
    const confirmBtn = document.getElementById('rouletteBetConfirmBtn');

    if (betBtn) {
      betBtn.disabled = false;
    }
    if (confirmBtn) {
      confirmBtn.disabled = false;
    }
    if (betInput) {
      betInput.disabled = false;
    }
    this.setStakeStepperDisabled(false);
    this.syncStakeDisplay();

    // Восстанавливаем правильный текст кнопки
    this.updateBetButton(this.state.isInRound);
  }

  setStakeStepperDisabled(disabled) {
    document.getElementById('rollsStakeMinus')?.toggleAttribute('disabled', !!disabled);
    document.getElementById('rollsStakePlus')?.toggleAttribute('disabled', !!disabled);
    document.getElementById('rouletteBetConfirmBtn')?.toggleAttribute('disabled', !!disabled);
    document.querySelectorAll('#rollsPresetRow button, #rollsPresetRowHigh button').forEach((b) => {
      b.disabled = !!disabled;
    });
  }

  /** После перерисовки пресетов восстановить disabled, если кнопка ставки заблокирована */
  refreshStakeStepperLockFromBetBtn() {
    if (document.getElementById('rouletteBetBtn')?.disabled) {
      this.setStakeStepperDisabled(true);
    }
  }

  roundStakeTon(x) {
    const n = Math.min(1e9, Math.max(0, Number(x) || 0));
    return Math.round(n * 10) / 10;
  }

  getPresetValues() {
    return [...ROLLS_PRESET_DEFAULTS];
  }

  presetPillsHtml(values) {
    return values
      .map(
        (v) => `
      <button type="button" class="rolls-preset-pill" data-amount="${v}" aria-label="Поставить ${v} TON">${this.escapeHtml(String(v))}</button>`
      )
      .join('');
  }

  renderPresetRow() {
    const wrap = document.getElementById('rollsPresetRow');
    const hi = document.getElementById('rollsPresetRowHigh');
    if (wrap) wrap.innerHTML = this.presetPillsHtml(this.getPresetValues());
    if (hi) hi.innerHTML = this.presetPillsHtml([...ROLLS_PRESET_HIGH_DEFAULTS]);
  }

  syncStakeDisplay() {
    const inp = this.elements.betInput;
    const el = document.getElementById('rollsStakeDisplay');
    const mi = document.getElementById('rollsStakeMinus');
    if (!inp || !el) return;
    const v = this.roundStakeTon(inp.value || 0);
    inp.value = String(v);
    el.innerHTML = `${v.toFixed(1)}<span class="rolls-stake-ton"> TON</span>`;
    if (mi && !document.getElementById('rouletteBetBtn')?.disabled) {
      mi.disabled = v <= 0;
    }
  }

  setMainStake(v) {
    if (!this.elements.betInput) return;
    const x = this.roundStakeTon(v);
    this.elements.betInput.value = String(x);
    this.syncStakeDisplay();
  }

  adjustMainStake(delta) {
    const cur = this.roundStakeTon(this.elements.betInput?.value || 0);
    const next = this.roundStakeTon(cur + delta);
    if (next < 0) return;
    this.setMainStake(next);
  }

  initStakeControls() {
    const presetRows = document.getElementById('rollsPresetRows');
    const mi = document.getElementById('rollsStakeMinus');
    const pl = document.getElementById('rollsStakePlus');
    if (!this.elements.betInput) return;

    if (!this._stakeControlsBound) {
      this._stakeControlsBound = true;
      mi?.addEventListener('click', () => {
        const cur = this.roundStakeTon(this.elements.betInput?.value || 0);
        if (cur <= 0) return;
        this.adjustMainStake(-ROLLS_STAKE_FINE_STEP);
        this.playStakeUiTick();
        this.hapticImpact('light');
      });
      pl?.addEventListener('click', () => {
        this.adjustMainStake(ROLLS_STAKE_FINE_STEP);
        this.playStakeUiTick();
        this.hapticImpact('light');
      });
      presetRows?.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        const pill = t.closest('.rolls-preset-pill');
        if (!pill || !presetRows.contains(pill)) return;
        const amt = this.roundStakeTon(pill.getAttribute('data-amount'));
        if (amt <= 0) return;
        this.setMainStake(amt);
        this.playStakeUiTick();
        this.hapticImpact('medium');
      });
    }

    this.renderPresetRow();
    this.refreshStakeStepperLockFromBetBtn();
    if (this.elements.betInput.value === '' || this.elements.betInput.value == null) {
      this.elements.betInput.value = '0';
    }
    this.syncStakeDisplay();
  }

  // ==================== PLAYERS ====================
  updatePlayers(players) {
    rlog('[Roulette] updatePlayers called with', players.length, 'players, isSpinning:', this.state.isSpinning);
    players.forEach((p, i) => {
      rlog(`  - Player ${i}: ${p.name}, chance=${p.chance}, id=${p.id}`);
    });
    
    // КРИТИЧЕСКИ ВАЖНО: Если идет спин - ПОЛНОСТЬЮ ВЫХОДИМ!
    if (this.state.isSpinning) {
      rlog('[Roulette] 🔒 BLOCKED: updatePlayers during spin - NOT TOUCHING ANYTHING');
      return; // ПОЛНОСТЬЮ блокируем
    }
    
    // Обновляем state.players
    this.state.players = players;
    
    if (this.elements.playerCount) {
      this.elements.playerCount.textContent = players.length;
    }

    // Обновляем список игроков
    this.renderPlayersList();
    
    // Рендерим колесо
    this.renderWheel();
  }

  renderPlayersList() {
    if (!this.elements.playersList) return;

    if (this.state.players.length === 0) {
      this.elements.playersList.innerHTML = `<div class="rolls-empty">Пока нет игроков. Будь первым!</div>`;
      return;
    }

    this.elements.playersList.innerHTML = this.state.players.map((player) => {
      const avatarContent = player.photoUrl
        ? `<img src="${this.escapeHtml(player.photoUrl)}" alt="" onerror="this.style.display='none'"/>`
        : `<span style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-weight:900;font-size:18px;color:#07110c;">${player.name.charAt(0).toUpperCase()}</span>`;
      return `
        <div class="rolls-pcard" data-user-id="${this.escapeHtml(String(player.id))}">
          <div class="rolls-pcard__top">
            <div class="rolls-pcard__left">
              <div class="rolls-pcard__av">${avatarContent}</div>
              <div>
                <div class="rolls-pcard__name">${this.escapeHtml(player.name)}</div>
                <div class="rolls-pcard__sub">Игрок</div>
              </div>
            </div>
            <div>
              <div class="rolls-pcard__pct">${player.chance.toFixed(2)}%</div>
              <div class="rolls-pcard__bet">${player.bet.toFixed(2)} TON</div>
            </div>
          </div>
          <div class="rolls-pcard__foot">
            <button type="button" class="rolls-diamond-btn" disabled aria-hidden="true">💎 ${player.bet.toFixed(2)}</button>
            <span class="rolls-pcard__chev">›</span>
          </div>
        </div>`;
    }).join('');
  }

  // ==================== DONUT WHEEL (Rolls) ====================

  sortPlayersForWheel(players) {
    return [...(players || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  applyWaitingDonut() {
    if (!this.elements.wheelConic) return;
    const parts = [];
    for (let i = 0; i < 8; i++) {
      const c = i % 2 === 0 ? '#3a3d46' : '#2a2d35';
      parts.push(`${c} ${(i * 100) / 8}% ${((i + 1) * 100) / 8}%`);
    }
    this.elements.wheelConic.style.background = `conic-gradient(from -90deg, ${parts.join(', ')})`;
  }

  buildDonutFromPlayers(players) {
    if (!this.elements.wheelConic || !this.elements.wheelAvatars) return;
    const list = this.sortPlayersForWheel(players);
    if (!list.length) {
      this.applyWaitingDonut();
      this.elements.wheelAvatars.innerHTML = '';
      return;
    }
    const weights = list.map((p) => Math.max(0.35, Number(p.chance) || 0));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let accPct = 0;
    const stops = [];
    list.forEach((p, i) => {
      const frac = (weights[i] / sum) * 100;
      const c = ROLLS_SEG_COLORS[i % ROLLS_SEG_COLORS.length];
      const next = accPct + frac;
      stops.push(`${c} ${accPct}% ${next}%`);
      accPct = next;
    });
    this.elements.wheelConic.style.background = `conic-gradient(from -90deg, ${stops.join(', ')})`;

    let a = 0;
    const html = [];
    list.forEach((p, i) => {
      const frac = weights[i] / sum;
      const mid = (a + a + frac) / 2;
      a += frac;
      const theta = (mid - 0.25) * 2 * Math.PI;
      const radAv = 36;
      const leftAv = 50 + Math.sin(theta) * radAv;
      const topAv = 50 - Math.cos(theta) * radAv;
      const pctLabel = `${Number(p.chance).toFixed(1)}%`;
      const initial = this.escapeHtml(String(p.name || 'P').charAt(0).toUpperCase());
      const avInner = p.photoUrl
        ? `<img src="${this.escapeHtml(p.photoUrl)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"/><span class="rolls-wheel-av__ph" style="display:none" aria-hidden="true">${initial}</span>`
        : `<span class="rolls-wheel-av__ph" aria-hidden="true">${initial}</span>`;
      html.push(
        `<div class="rolls-wheel-slot" style="left:${leftAv}%;top:${topAv}%">` +
          `<div class="rolls-wheel-av" data-user-id="${this.escapeHtml(String(p.id))}">${avInner}</div>` +
          `<div class="rolls-wheel-pct">${this.escapeHtml(pctLabel)}</div>` +
          `</div>`
      );
    });
    this.elements.wheelAvatars.innerHTML = html.join('');
  }

  clearWinnerWheelFlash() {
    this.elements.wheelAvatars?.querySelectorAll('.rolls-wheel-av--win').forEach((el) => {
      el.classList.remove('rolls-wheel-av--win');
    });
  }

  /**
   * Угол остановки под указателем (доля круга 0..1 от левой точки conic, как в buildDonutFromPlayers).
   * Если сервер передал `spin_pick` — используем только его (тот же бросок, что выбрал победителя).
   * Иначе (старые раунды) — случайная точка внутри сектора победителя.
   */
  computeDonutEndRotationDeg(players, winnerUserId, fullTurns = 7, spinPick = null) {
    const sp =
      spinPick != null && spinPick !== ''
        ? Number(spinPick)
        : null;
    if (sp != null && Number.isFinite(sp)) {
      const r = Math.min(1 - Number.EPSILON * 8, Math.max(Number.EPSILON * 8, sp));
      const degFromTopOnWheel = (r - 0.25) * 360;
      return -degFromTopOnWheel + 360 * fullTurns;
    }

    const list = this.sortPlayersForWheel(players);
    const wuid = String(winnerUserId || '');
    const weights = list.map((p) => Math.max(0.35, Number(p.chance) || 0));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let cum = 0;
    let startF = 0;
    let winFrac = 0;
    let found = false;
    for (let i = 0; i < list.length; i++) {
      const frac = weights[i] / sum;
      if (String(list[i].id) === wuid) {
        startF = cum;
        winFrac = frac;
        found = true;
        break;
      }
      cum += frac;
    }
    if (!found || winFrac <= 0) {
      return 360 * fullTurns;
    }
    const inset = Math.max(1e-4, Math.min(winFrac * 0.06, 0.02));
    const lo = startF + inset;
    const hi = startF + winFrac - inset;
    const pickFrac = hi <= lo ? startF + winFrac / 2 : lo + Math.random() * (hi - lo);
    const degFromTopOnWheel = (pickFrac - 0.25) * 360;
    return -degFromTopOnWheel + 360 * fullTurns;
  }

  betsToPlayerRows(bets) {
    return (bets || [])
      .map((b) => ({
        id: b.user_id,
        name: b.display_name || 'Player',
        bet: parseFloat(b.bet_amount) || 0,
        chance: parseFloat(b.chance_percent) || 0,
        photoUrl: b.photo_url || null,
      }))
      .filter((p) => p.id);
  }

  resolveRevealWinnerFromRound(round, bets, winnerPayload) {
    const serverUid = String(round?.winner_user_id || '');
    const bet = (bets || []).find((b) => String(b.user_id) === serverUid);
    const displayName = bet?.display_name || winnerPayload?.display_name || 'Игрок';
    const chance = bet != null ? parseFloat(bet.chance_percent || 0) : null;
    return {
      userId: serverUid,
      displayName,
      amount: parseFloat(round?.winner_amount || 0),
      photoUrl: bet?.photo_url || winnerPayload?.photo_url || this.state.lastWinnerPhotoUrl,
      chancePercent: chance,
    };
  }

  async playFinishedRoundReveal({ round, bets, winner }) {
    this.stopWheelIdle();
    const spin = this.elements.wheelSpin;
    const hub = this.elements.rollsHub;
    const hubText = this.elements.rollsHubText;
    const rows = this.betsToPlayerRows(bets);
    if (!spin || !rows.length) {
      return this.resolveRevealWinnerFromRound(round, bets, winner);
    }

    this.buildDonutFromPlayers(rows);
    this.clearWinnerWheelFlash();
    await new Promise((r) => requestAnimationFrame(r));

    spin.style.transition = 'none';
    spin.style.transform = 'rotate(0deg)';
    void spin.offsetHeight;

    const spinPickRaw = round?.spin_pick;
    const spinPick =
      spinPickRaw != null && spinPickRaw !== '' && Number.isFinite(Number(spinPickRaw))
        ? Number(spinPickRaw)
        : null;
    const endDeg = this.computeDonutEndRotationDeg(rows, round.winner_user_id, 7, spinPick);
    if (hubText) {
      hubText.className = 'rolls-hub__text rolls-hub__text--spinlabel';
      hubText.textContent = 'Розыгрыш';
    }
    hub?.classList.remove('rolls-hub--wait');

    await new Promise((r) => requestAnimationFrame(r));
    spin.style.transition = 'transform 9.6s cubic-bezier(0.06, 0.72, 0.12, 1)';
    spin.style.transform = `rotate(${endDeg}deg)`;
    this.startSpinSegmentTickLoop({ endDeg, durationMs: 9600, rows });

    await new Promise((r) => {
      this._spinFinishTimer = setTimeout(r, 9800);
    });
    this._spinFinishTimer = null;
    this.stopSpinSegmentTickLoop();

    const wuid = String(round?.winner_user_id || '');
    this.elements.wheelAvatars?.querySelectorAll('.rolls-wheel-av').forEach((el) => {
      if (String(el.getAttribute('data-user-id')) === wuid) el.classList.add('rolls-wheel-av--win');
    });

    this.stopSpinSound();
    this.hapticImpact('medium');
    await new Promise((r) => setTimeout(r, 720));
    return this.resolveRevealWinnerFromRound(round, bets, winner);
  }

  renderWheel() {
    if (!this.elements.wheelConic) return;
    if (this.state.isSpinning || this.state.isAnimating) {
      rlog('[Roulette] BLOCKED: Cannot render wheel during spin!');
      return;
    }

    const playersKey = this.state.players
      .map((p) => `${p.id}_${p.bet.toFixed(2)}_${Number(p.chance).toFixed(4)}`)
      .join('|');
    if (this.state.players.length === 0) {
      this.state.lastPlayersKey = null;
      this.applyWaitingDonut();
      if (this.elements.wheelAvatars) this.elements.wheelAvatars.innerHTML = '';
      this.syncRollsHubIdle();
      this.syncWheelIdleMotion();
      return;
    }

    if (this.state.lastPlayersKey === playersKey && this.elements.wheelAvatars?.children.length > 0) {
      rlog('[Roulette] Skipping wheel render - players unchanged');
      this.syncRollsHubIdle();
      this.syncWheelIdleMotion();
      return;
    }
    this.state.lastPlayersKey = playersKey;
    rlog('[Roulette] Rendering donut, players:', this.state.players.length);
    this.buildDonutFromPlayers(this.state.players);
    const spin = this.elements.wheelSpin;
    if (spin) {
      spin.style.transition = 'none';
      spin.style.transform = 'rotate(0deg)';
    }
    this.syncRollsHubIdle();
    this.syncWheelIdleMotion();
  }

  syncRollsHubIdle() {
    if (!this.elements.rollsHubText || this.state.isAnimating) return;
    if (this.state.isSpinning) return;
    const st = this.state.currentRound?.status;
    if (st === 'active') return;
    if (st === 'spinning') return;
    if (this.state.players?.length > 0) {
      this.elements.rollsHubText.className = 'rolls-hub__text rolls-hub__text--game';
      this.elements.rollsHubText.textContent = 'ИГРА';
      this.elements.rollsHub?.classList.remove('rolls-hub--wait');
    } else {
      this.elements.rollsHubText.className = 'rolls-hub__text';
      this.elements.rollsHubText.textContent = 'Ожидание';
      this.elements.rollsHub?.classList.add('rolls-hub--wait');
    }
  }

  updateRollsSpotlights(lastGame, topGame) {
    const setCard = (side, row) => {
      const nameEl = document.getElementById(`rollsSpot${side}Name`);
      const amtEl = document.getElementById(`rollsSpot${side}Amt`);
      const chEl = document.getElementById(`rollsSpot${side}Chance`);
      const avEl = document.getElementById(`rollsSpot${side}Av`);
      if (!nameEl || !amtEl || !chEl || !avEl) return;
      if (!row) {
        nameEl.textContent = '—';
        amtEl.textContent = '+0 TON';
        chEl.textContent = 'ШАНС —';
        avEl.innerHTML = '';
        return;
      }
      const name = row.winner_display_name || '—';
      const ton = parseFloat(row.winner_amount || 0);
      const ch = parseFloat(row.winner_chance_percent || 0);
      nameEl.textContent = name.length > 12 ? `${name.slice(0, 10)}…` : name;
      amtEl.textContent = `+${ton.toFixed(ton >= 100 ? 0 : ton >= 10 ? 1 : 2)} TON`;
      chEl.textContent = `ШАНС ${Number.isFinite(ch) ? ch.toFixed(0) : '—'}%`;
      const initial = String(name).charAt(0).toUpperCase();
      if (row.photo_url) {
        avEl.innerHTML = `<img src="${this.escapeHtml(row.photo_url)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block"/>`;
      } else {
        avEl.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:14px;color:#07110c;">${initial}</div>`;
      }
    };
    setCard('Prev', lastGame || null);
    setCard('Top', topGame || null);
  }

  // ==================== ACTIONS ====================
  async handleBet() {
    if (this.state.isLoading) return;
    
    const amount = parseFloat(this.elements.betInput?.value || 0);
    
    if (amount < 0.1) {
      this.showToast(this.state.isInRound ? 'Минимальное повышение: 0.1 TON' : 'Минимальная ставка: 0.1 TON');
      return;
    }

    this.state.isLoading = true;
    
    const betBtn = document.getElementById('rouletteBetBtn');
    const confirmBtn = document.getElementById('rouletteBetConfirmBtn');
    const betInput = document.getElementById('rouletteBetInput');
    
    if (betBtn) {
      betBtn.disabled = true;
    }
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Отправка...';
    }
    if (betInput) {
      betInput.disabled = true;
    }

    try {
      // ВАЖНО: Сохраняем состояние ДО отправки ставки
      const wasInRound = this.state.isInRound;
      
      // Выбираем действие в зависимости от того, в раунде ли пользователь
      const action = wasInRound ? 'raiseBet' : 'joinRound';
      const paramName = wasInRound ? 'raiseAmount' : 'betAmount';
      
      await this.callAPI(action, {
        [paramName]: amount,
        request_id: this.generateRequestId(action),
      });
      if (wasInRound) this.playBetRaiseSoftSound();
      else this.playBetPlacedSoftSound();
      this.hapticImpact('light');
      
      // Показываем правильное уведомление на основе ПРЕДЫДУЩЕГО состояния
      this.showToast(wasInRound ? 'Ставка повышена!' : 'Ставка принята!');
      
      this.closeBetModal();
      
      // Сброс суммы после успешной ставки
      this.setMainStake(0);
      
      // Reload round data
      await this.loadActiveRound();
      this.state.lastSidePanelsFetchAt = 0;
      this.loadRecentWinners(true).catch(() => {});

      // Refresh user balance
      if (typeof window.hydrateUserFromServer === 'function') {
        // ВАЖНО: Передаем skipBalanceIncreaseToast чтобы не показывать toast о пополнении
        await window.hydrateUserFromServer({ skipBalanceIncreaseToast: true });
        if (typeof window.refreshBalanceUiAfterHydrate === 'function') {
          window.refreshBalanceUiAfterHydrate();
        }
      }
    } catch (error) {
      console.error('[Roulette] Bet error:', error);
      // НЕ показываем toast - только логируем
      // this.showToast(error.message || 'Ошибка при обработке ставки');
    } finally {
      this.state.isLoading = false;
      if (betBtn) {
        betBtn.disabled = false;
      }
      if (confirmBtn) {
        confirmBtn.disabled = false;
      }
      if (betInput) {
        betInput.disabled = false;
      }
      // Восстанавливаем правильный текст кнопки
      this.updateBetButton(this.state.isInRound);
    }
  }

  // ==================== WINNER ====================

  showWinner(winnerName, amount, winnerUserId, winnerPhotoUrl = null, chancePercent = null) {
    if (this.elements.winnerName) {
      this.elements.winnerName.textContent = winnerName;
    }
    if (this.elements.winnerAmount) {
      this.elements.winnerAmount.textContent = amount.toFixed(2);
    }
    const winnerChance = document.getElementById('rouletteWinnerChance');
    if (winnerChance) {
      const c = Number.isFinite(Number(chancePercent)) ? Number(chancePercent) : 0;
      winnerChance.textContent = c.toFixed(1);
    }
    
    // Добавляем аватарку победителя
    const winnerAvatar = document.getElementById('rouletteWinnerAvatar');
    if (winnerAvatar && winnerUserId) {
      // Ищем фото победителя в текущих игроках
      const winnerPlayer = this.state.players.find(p => String(p.id) === String(winnerUserId));
      const photoUrl = winnerPhotoUrl || winnerPlayer?.photoUrl;
      const initial = winnerName.charAt(0).toUpperCase();
      
      // Аватар: фото или инициал
      const avatarContent = photoUrl 
        ? `<img src="${this.escapeHtml(photoUrl)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><div style="display:none; width:100%; height:100%; align-items:center; justify-content:center; font-weight:900; font-size:36px; color:#07110c;">${initial}</div>`
        : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:36px; color:#07110c;">${initial}</div>`;
      
      winnerAvatar.innerHTML = `
        <div style="width:80px; height:80px; border-radius:50%; background:linear-gradient(135deg, #8CFFC1, #4DFF9A); overflow:hidden; margin:0 auto 16px;">
          ${avatarContent}
        </div>
      `;
    }
    
    if (this.elements.winnerModal) {
      if (this._winnerModalCloseTimer) {
        clearTimeout(this._winnerModalCloseTimer);
        this._winnerModalCloseTimer = null;
      }
      this.elements.winnerModal.classList.add('show');
      const isWin = String(winnerUserId) === String(this.state.myUserId);
      this.playResultSound(isWin);
      this.hapticNotify(isWin ? 'success' : 'warning');

      // Автоматически закрываем и убираем полосу с подсветкой (полоса жила до закрытия модалки).
      this._winnerModalCloseTimer = setTimeout(() => {
        this._winnerModalCloseTimer = null;
        this.closeRouletteWinnerModal();
      }, 5200);
    }

    // Confetti effect (if available)
    if (typeof confetti !== 'undefined') {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 }
      });
    }
  }

  /** Нижние блоки (последние победы / моя история): редко и только если вкладка видна; без лишнего DOM. */
  maybeRefreshRouletteSidePanels() {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const now = Date.now();
    const cooldownMs = 45000;
    if (this.state.lastSidePanelsFetchAt && now - this.state.lastSidePanelsFetchAt < cooldownMs) return;
    this.state.lastSidePanelsFetchAt = now;
    this.loadRecentWinners(false).catch(() => {});
  }

  fingerprintRollsSpotlights(lastGame, topGame) {
    const L = lastGame || {};
    const T = topGame || {};
    return `${String(L.id || '')}|${String(L.created_at || '')}|${String(L.winner_amount || '')}|${String(T.id || '')}|${String(T.winner_amount || '')}`;
  }

  async loadRecentWinners(force = false) {
    try {
      const data = await this.callAPI('getRecentWinners', { limit: 12 });
      const list = data.winners || [];
      const lastGame = data.lastGame != null ? data.lastGame : list[0] || null;
      const topGame = data.topGame != null ? data.topGame : null;

      const fp = this.fingerprintRollsSpotlights(lastGame, topGame);
      if (!force && fp === this.state._rollsSpotlightsKey) return;
      this.state._rollsSpotlightsKey = fp;

      this.renderRecentWinnersList(list);
      this.updateRollsSpotlights(lastGame, topGame);
    } catch (error) {
      console.error('Failed to load recent winners:', error);
    }
  }

  /** Список в DOM (если контейнер есть); карточки Rolls обновляются в loadRecentWinners. */
  renderRecentWinnersList(winners) {
    if (!this.elements.recentWinners) return;

    if (!winners || winners.length === 0) {
      this.elements.recentWinners.innerHTML = `
        <div style="text-align:center; padding:20px; color:var(--muted); font-size:13px;">
          История пока пуста
        </div>
      `;
      return;
    }

    this.elements.recentWinners.innerHTML = winners.map((winner) => {
      const date = new Date(winner.created_at);
      const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

      const avatarContent = winner.photo_url
        ? `<img src="${this.escapeHtml(winner.photo_url)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><div style="display:none; width:100%; height:100%; align-items:center; justify-content:center; font-weight:900; font-size:14px; color:#07110c;">${winner.winner_display_name.charAt(0).toUpperCase()}</div>`
        : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:14px; color:#07110c;">${winner.winner_display_name.charAt(0).toUpperCase()}</div>`;

      return `
        <div class="pill" style="padding:10px 12px;">
          <div style="display:flex; align-items:center; gap:10px; flex:1;">
            <div style="width:32px; height:32px; border-radius:50%; background:linear-gradient(135deg, #fbbf24, #f59e0b); overflow:hidden; flex-shrink:0;">
              ${avatarContent}
            </div>
            <div style="flex:1; min-width:0;">
              <div style="font-weight:800; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(winner.winner_display_name)}</div>
              <div style="font-size:11px; color:var(--muted);">${timeStr} • ${winner.players_count} игроков</div>
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:16px; font-weight:900; color:var(--accent);">${parseFloat(winner.winner_amount).toFixed(2)}</div>
            <div style="font-size:10px; color:var(--muted);">TON</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ==================== UTILS ====================
  showToast(message) {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize when page loads
let rouletteUI;

// Initialize on first tab open
function initRouletteUI() {
  if (!rouletteUI) {
    rouletteUI = new RouletteUI();
  }
  window.rouletteUI = rouletteUI;
  rouletteUI.closePublicHistoryPage();
  // Load initial data and start polling
  rouletteUI.loadActiveRound();
  rouletteUI.loadRecentWinners(true).catch(() => {});
  rouletteUI.startDataSync();
}

// Stop polling when leaving roulette tab
function stopRouletteUI() {
  if (rouletteUI) {
    rouletteUI.stopDataSync();
    rouletteUI.closePublicHistoryPage();
  }
}

// Listen for tab changes
if (typeof window !== 'undefined') {
  // VERSION CHECK
  rlog('[Roulette] Script loaded - ROULETTE_UI_STATIC_PANELS_20260513');
  
  // Check if we're on roulette tab on load
  window.addEventListener('DOMContentLoaded', () => {
    const hash = window.location.hash.slice(1);
    if (hash === 'roulette') {
      initRouletteUI();
    }
  });

  // Listen for hash changes (tab switches)
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.slice(1);
    if (hash === 'roulette') {
      initRouletteUI();
    } else {
      stopRouletteUI();
    }
  });
  
  // Stop polling when page is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopRouletteUI();
    } else if (document.visibilityState === 'visible') {
      const hash = window.location.hash.slice(1);
      if (hash === 'roulette' && rouletteUI) {
        rouletteUI.loadActiveRound();
        rouletteUI.startDataSync();
      }
    }
  });
}
