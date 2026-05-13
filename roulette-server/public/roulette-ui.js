/**
 * Roulette UI Manager
 * Manages all UI updates and interactions for the roulette game
 * Stage 3: Backend integration with API calls
 * VERSION: ROLLS_DONUT_20260514
 */

const ROULETTE_DEBUG =
  typeof localStorage !== 'undefined' && localStorage.getItem('rouletteDebug') === '1';
function rlog() {
  if (ROULETTE_DEBUG && typeof console !== 'undefined' && console.log) {
    console.log.apply(console, arguments);
  }
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
      
      // Winners / history modal
      recentWinners: document.getElementById('rouletteRecentWinners'),
      myHistory: document.getElementById('rouletteMyHistory'),
      historyModal: document.getElementById('rouletteHistoryModal'),
      historyCloseBtn: document.getElementById('rouletteHistoryCloseBtn'),
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
      /** Throttle для «последние победы» + «моя история» (не дергать DOM на каждом poll) */
      lastSidePanelsFetchAt: 0,
      _rollsSpotlightsKey: null,
      _lastMyHistoryKey: null,
      isLoadingRound: false,
      lastTimerSecond: null,
      audioEnabled: false,
      spinSoundActive: false,
      /** Защита от двух параллельных `loadActiveRound` на одном finished-раунде */
      presentingRoundId: null,
      /** Идемпотентность локального onTimerEnd (один раз на конкретный таймер) */
      timerEndedKey: null,
    };

    this._spinFinishTimer = null;

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
  }

  /** Сброс полосы колеса после модалки победителя (когда ранее вызывали clearRoundUIToWaiting с preserveWheelStrip). */
  resetWheelStripToWaiting() {
    this.resetDonutToWaiting();
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
    this.loadMyHistory(true).catch(() => {});
  }

  abortCaseReel() {
    if (this._spinFinishTimer) {
      clearTimeout(this._spinFinishTimer);
      this._spinFinishTimer = null;
    }
    const spin = this.elements.wheelSpin;
    if (spin) {
      try {
        spin.getAnimations?.().forEach((a) => a.cancel());
      } catch {}
      spin.style.transition = 'none';
    }
  }

  init() {
    // Setup event listeners
    this.elements.betBtn?.addEventListener('click', () => this.handleBet());
    this.elements.historyCloseBtn?.addEventListener('click', () => {
      this.elements.historyModal?.classList.remove('show');
    });
    this.elements.historyModal?.addEventListener('click', (e) => {
      if (e.target === this.elements.historyModal) {
        this.elements.historyModal.classList.remove('show');
      }
    });

    document.getElementById('rollsHistoryBtn')?.addEventListener('click', () => {
      this.elements.historyModal?.classList.add('show');
      this.loadMyHistory(true).catch(() => {});
    });

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
  }

  // ==================== HAPTIC ====================
  hapticImpact(style = 'light') {
    return;
  }

  hapticNotify(type = 'success') {
    return;
  }

  // ==================== AUDIO ====================
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

  playTone({ freq = 440, durationMs = 90, gain = 0.035, type = 'sine' } = {}) {
    return;
  }

  playClickSound() {
    this.playTone({ freq: 680, durationMs: 70, gain: 0.03, type: 'triangle' });
  }

  playTickSound() {
    this.playTone({ freq: 980, durationMs: 55, gain: 0.02, type: 'square' });
  }

  playResultSound(isWin) {
    if (isWin) {
      this.playTone({ freq: 740, durationMs: 120, gain: 0.04, type: 'triangle' });
      setTimeout(() => this.playTone({ freq: 988, durationMs: 140, gain: 0.04, type: 'triangle' }), 110);
    } else {
      this.playTone({ freq: 260, durationMs: 140, gain: 0.03, type: 'sawtooth' });
    }
  }

  startSpinSound() {
    return;
  }

  stopSpinSound() {
    this.state.spinSoundActive = false;
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
      
      if (data.round) {
        const previousStatus = this.state.currentRound?.status;
        const previousRoundId = this.state.currentRound?.id;
        
        this.state.currentRound = data.round;

        if (previousRoundId != null && String(data.round.id) !== String(previousRoundId)) {
          this.state.timerEndedKey = null;
          this.state._rollsSpotlightsKey = null;
          this.state._lastMyHistoryKey = null;
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
          const initialRemaining = Math.max(0, Math.min(
            20,
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
        betBtn.textContent = 'Войти в раунд';
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
      // +999ms дает стабильный визуальный старт с 20 на большинстве устройств.
      const remaining = Math.max(
        0,
        Math.min(20, Math.ceil((this.state.timerEndTime - estimatedServerTime + 999) / 1000))
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

      // Change color when time is running out
      if (seconds <= 5) {
        this.elements.timer.style.color = '#ff4444';
      } else if (seconds <= 10) {
        this.elements.timer.style.color = '#fbbf24';
      } else {
        this.elements.timer.style.color = '#ff5c5c';
      }

      if (seconds !== this.state.lastTimerSecond) {
        if (seconds > 0 && seconds <= 5) {
          this.playTickSound();
          this.hapticImpact('light');
        }
        this.state.lastTimerSecond = seconds;
      }
    }
    if (this.elements.rollsHubText && this.state.currentRound?.status === 'active') {
      const s = Math.max(0, Math.min(99, Number(seconds) || 0));
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
    
    // Сервер сам переводит раунд в spinning/finished; сразу тянем состояние.
    this.loadActiveRound().catch(() => {});
    this.startDataSync();
  }

  disableBetButton() {
    const betBtn = document.getElementById('rouletteBetBtn');
    const betInput = document.getElementById('rouletteBetInput');
    
    if (betBtn) {
      betBtn.disabled = true;
      betBtn.textContent = 'Идет розыгрыш...';
    }
    if (betInput) {
      betInput.disabled = true;
    }
  }

  enableBetButton() {
    const betBtn = document.getElementById('rouletteBetBtn');
    const betInput = document.getElementById('rouletteBetInput');
    
    if (betBtn) {
      betBtn.disabled = false;
    }
    if (betInput) {
      betInput.disabled = false;
    }
    
    // Восстанавливаем правильный текст кнопки
    this.updateBetButton(this.state.isInRound);
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
      const rad = 38;
      const left = 50 + Math.sin(theta) * rad;
      const top = 50 - Math.cos(theta) * rad;
      const av = p.photoUrl
        ? `<img src="${this.escapeHtml(p.photoUrl)}" alt="" onerror="this.parentElement.innerHTML='<span style=\\'display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-weight:900;font-size:12px;color:#fff\\'>${p.name.charAt(0).toUpperCase()}</span>'"/>`
        : `<span style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-weight:900;font-size:12px;color:#fff">${p.name.charAt(0).toUpperCase()}</span>`;
      html.push(
        `<div class="rolls-wheel-av" data-user-id="${this.escapeHtml(String(p.id))}" style="left:${left}%;top:${top}%">${av}</div>`
      );
    });
    this.elements.wheelAvatars.innerHTML = html.join('');
  }

  clearWinnerWheelFlash() {
    this.elements.wheelAvatars?.querySelectorAll('.rolls-wheel-av--win').forEach((el) => {
      el.classList.remove('rolls-wheel-av--win');
    });
  }

  computeDonutEndRotationDeg(players, winnerUserId, fullTurns = 7) {
    const list = this.sortPlayersForWheel(players);
    const wuid = String(winnerUserId || '');
    const weights = list.map((p) => Math.max(0.35, Number(p.chance) || 0));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let a = 0;
    let midFrac = 0.5;
    for (let i = 0; i < list.length; i++) {
      const frac = weights[i] / sum;
      if (String(list[i].id) === wuid) {
        midFrac = a + frac / 2;
        break;
      }
      a += frac;
    }
    const alphaMidDeg = midFrac * 360;
    return -alphaMidDeg + 360 * fullTurns;
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

    const endDeg = this.computeDonutEndRotationDeg(rows, round.winner_user_id, 7);
    if (hubText) {
      hubText.className = 'rolls-hub__text';
      hubText.textContent = '…';
    }
    hub?.classList.remove('rolls-hub--wait');

    await new Promise((r) => requestAnimationFrame(r));
    spin.style.transition = 'transform 9.6s cubic-bezier(0.06, 0.72, 0.12, 1)';
    spin.style.transform = `rotate(${endDeg}deg)`;

    await new Promise((r) => {
      this._spinFinishTimer = setTimeout(r, 9800);
    });
    this._spinFinishTimer = null;

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

    const playersKey = this.state.players.map((p) => `${p.id}_${p.bet.toFixed(2)}`).join('|');
    if (this.state.players.length === 0) {
      this.state.lastPlayersKey = null;
      this.applyWaitingDonut();
      if (this.elements.wheelAvatars) this.elements.wheelAvatars.innerHTML = '';
      this.syncRollsHubIdle();
      return;
    }

    if (this.state.lastPlayersKey === playersKey && this.elements.wheelAvatars?.children.length > 0) {
      rlog('[Roulette] Skipping wheel render - players unchanged');
      this.syncRollsHubIdle();
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
    const betInput = document.getElementById('rouletteBetInput');
    
    if (betBtn) {
      betBtn.disabled = true;
      betBtn.textContent = 'Отправка...';
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
      this.playClickSound();
      this.hapticImpact('light');
      
      // Показываем правильное уведомление на основе ПРЕДЫДУЩЕГО состояния
      this.showToast(wasInRound ? 'Ставка повышена!' : 'Ставка принята!');
      
      // Clear input
      if (betInput) {
        betInput.value = '';
      }
      
      // Reload round data
      await this.loadActiveRound();
      this.state.lastSidePanelsFetchAt = 0;
      this.loadRecentWinners(true).catch(() => {});
      this.loadMyHistory(true).catch(() => {});

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
    this.loadMyHistory(false).catch(() => {});
  }

  fingerprintRollsSpotlights(lastGame, topGame) {
    const L = lastGame || {};
    const T = topGame || {};
    return `${String(L.id || '')}|${String(L.created_at || '')}|${String(L.winner_amount || '')}|${String(T.id || '')}|${String(T.winner_amount || '')}`;
  }

  fingerprintMyHistory(history) {
    if (!history || !history.length) return 'empty';
    return history.map((h) =>
      `${String(h.created_at)}|${String(h.result)}|${String(h.amount_ton)}|${String(h.bet_amount)}|${String(h.chance_percent)}`
    ).join('~');
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

  async loadMyHistory(force = false) {
    try {
      const data = await this.callAPI('getMyHistory', { limit: 8 });
      const list = data.history || [];
      const fp = this.fingerprintMyHistory(list);
      if (!force && fp === this.state._lastMyHistoryKey) return;
      this.state._lastMyHistoryKey = fp;
      this.renderMyHistory(list);
    } catch (error) {
      console.error('Failed to load my roulette history:', error);
    }
  }

  renderMyHistory(history) {
    if (!this.elements.myHistory) return;

    if (!history || history.length === 0) {
      this.elements.myHistory.innerHTML = `
        <div style="text-align:center; padding:20px; color:var(--muted); font-size:13px;">
          Пока нет раундов
        </div>
      `;
      return;
    }

    this.elements.myHistory.innerHTML = history.map((h) => {
      const created = new Date(h.created_at || Date.now());
      const timeStr = created.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

      const result = String(h.result || 'pending');
      const resultText = result === 'win' ? 'Победа' : result === 'loss' ? 'Поражение' : 'В процессе';
      const resultColor = result === 'win' ? 'var(--accent)' : result === 'loss' ? '#ff7a7a' : 'var(--text2)';

      const amountNum = Number(h.amount_ton || 0);
      const amountText = result === 'pending'
        ? '—'
        : `${amountNum > 0 ? '+' : ''}${amountNum.toFixed(2)} TON`;

      return `
        <div class="pill" style="padding:10px 12px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%;">
            <div style="min-width:0;">
              <div style="font-weight:800; font-size:13px; color:${resultColor};">${resultText}</div>
              <div style="font-size:11px; color:var(--muted);">
                Ставка ${Number(h.bet_amount || 0).toFixed(2)} TON • Шанс ${Number(h.chance_percent || 0).toFixed(1)}% • ${timeStr}
              </div>
            </div>
            <div style="text-align:right; font-size:13px; font-weight:900; color:${resultColor}; white-space:nowrap;">
              ${amountText}
            </div>
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
  // Load initial data and start polling
  rouletteUI.loadActiveRound();
  rouletteUI.loadRecentWinners(true).catch(() => {});
  rouletteUI.startDataSync();
}

// Stop polling when leaving roulette tab
function stopRouletteUI() {
  if (rouletteUI) {
    rouletteUI.stopDataSync();
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
