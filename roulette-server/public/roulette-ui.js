/**
 * Roulette UI Manager
 * Manages all UI updates and interactions for the roulette game
 * Stage 3: Backend integration with API calls
 * VERSION: AVATARS20260508 - AVATARS WITH 2 SECOND TIMEOUT
 */

const ROULETTE_SUPABASE_URL = 'https://eolycsnxboeobasolczb.supabase.co';
const ROULETTE_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbHljc254Ym9lb2Jhc29sY3piIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3Njg0NTQsImV4cCI6MjA5MTM0NDQ1NH0.EVU6xdTy1S_9y5fgq4-AJJQHO-WPlNu3bFHgG617eJA';

class RouletteUI {
  constructor() {
    this.elements = {
      // Status
      status: document.getElementById('rouletteStatusText'),
      potAmount: document.getElementById('roulettePotAmount'),
      timer: document.getElementById('rouletteTimer'),
      timerWrap: document.getElementById('rouletteTimerWrap'),
      
      // Wheel
      wheelContainer: document.getElementById('rouletteWheelContainer'),
      strip: document.getElementById('rouletteStrip'),
      
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
      
      // Winners
      recentWinners: document.getElementById('rouletteRecentWinners'),
      myHistory: document.getElementById('rouletteMyHistory'),
      openHistoryBtn: document.getElementById('rouletteOpenHistoryBtn'),
      historyModal: document.getElementById('rouletteHistoryModal'),
      historyCloseBtn: document.getElementById('rouletteHistoryCloseBtn'),
      winnerModal: document.getElementById('rouletteWinnerModal'),
      winnerName: document.getElementById('rouletteWinnerName'),
      winnerAmount: document.getElementById('rouletteWinnerAmount'),
    };

    // Debug: проверяем что элементы найдены
    console.log('[Roulette] Elements found:', {
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
      lastWinnersLoadAt: 0, // throttling для истории победителей
      lastMyHistoryLoadAt: 0,
      isPreSpinning: false, // ранняя анимация для non-initiator при status=spinning
      preSpinRafId: null,
      preSpinLastTs: 0,
      preSpinOffsetPx: 0,
      preSpinAnim: null,
      preSpinServerAnchorMs: 0,
      preSpinLocalAnchorMs: 0,
      preSpinStartMs: 0,
      isLoadingRound: false,
      lastTimerSecond: null,
      audioEnabled: false,
      spinSoundActive: false,
      spinTickTimer: null,
    };

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
  clearRoundUIToWaiting() {
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
      this.elements.playersList.innerHTML = `
        <div style="text-align:center; padding:24px; color:var(--muted); font-size:13px;">
          Пока нет игроков. Будь первым!
        </div>
      `;
    }

    if (this.elements.strip) {
      this.elements.strip.style.transition = 'none';
      this.elements.strip.style.transform = 'translateX(0)';
      this.elements.strip.innerHTML = `
        <div style="padding:0 20px; text-align:center; color:var(--muted); font-size:13px;">
          Ожидание игроков...
        </div>
      `;
    }

    // Сброс внутренних ключей, чтобы следующий раунд точно перерисовался
    this.state.lastPlayersKey = null;
    this.state.wheelCardsHTML = '';
    this.state.currentRound = null;
    this.state.players = [];
    this.state.myBet = null;
    this.state.lastTimerSecond = null;
    this.stopSpinSound();
    this.updateBetButton(false);
  }

  init() {
    // Setup event listeners
    this.elements.betBtn?.addEventListener('click', () => this.handleBet());
    this.elements.openHistoryBtn?.addEventListener('click', () => {
      this.elements.historyModal?.classList.add('show');
      this.loadMyHistory().catch(() => {});
    });
    this.elements.historyCloseBtn?.addEventListener('click', () => {
      this.elements.historyModal?.classList.remove('show');
    });
    this.elements.historyModal?.addEventListener('click', (e) => {
      if (e.target === this.elements.historyModal) {
        this.elements.historyModal.classList.remove('show');
      }
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
    if (this.state.spinTickTimer) clearInterval(this.state.spinTickTimer);
    this.state.spinTickTimer = null;
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
    this.stopPolling();
    this.stopRealtime();
    this.stopPreSpinAnimation();
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
 
        // ВАЖНО: `isSpinning` должен означать "идёт анимация/колесо залочено",
        // а НЕ "надо остановить polling навсегда". Polling должен продолжаться,
        // чтобы увидеть `finished` и показать всем результат.
        if (data.round.status === 'spinning' && !this.state.isSpinning) {
          console.log('[Roulette] Round is spinning - locking wheel (but keep polling)');
          this.state.isSpinning = true;
        }
        
        // Update UI
        // Пока локально идет спин/анимация - держим статус "Розыгрыш..."
        const effectiveStatus = (this.state.isSpinning || this.state.isAnimating)
          ? 'spinning'
          : data.round.status;
        this.updateStatus(effectiveStatus);
        this.updatePot(parseFloat(data.round.pot_amount));

        // Всегда сохраняем HTML карточек, даже если идет спин.
        if (data.wheelCardsHTML && data.wheelCardsHTML.length > 0) {
          this.state.wheelCardsHTML = data.wheelCardsHTML;
          // Если DOM пустой (например пользователь зашёл во время спина) — восстановим карточки.
          if (this.elements.strip && this.elements.strip.querySelectorAll('.roulette-card').length === 0) {
            console.log('[Roulette] Restoring wheel HTML during spin/page-enter');
            this.elements.strip.innerHTML = this.state.wheelCardsHTML;
          }
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
        if (!this.state.isSpinning) {
          // Process players - ВАЖНО: проверяем что data.bets существует
          console.log('[Roulette] Processing bets:', data.bets);
          
          const players = (data.bets || []).map(bet => {
            const player = {
              id: bet.user_id,
              name: bet.display_name || 'Player',
              bet: parseFloat(bet.bet_amount) || 0,
              chance: parseFloat(bet.chance_percent) || 0,
              photoUrl: bet.photo_url || null
            };
            console.log('[Roulette] Processed player:', player);
            return player;
          }).filter(p => p.id && p.name); // Фильтруем невалидных игроков
          
          console.log('[Roulette] Total players after processing:', players.length);
          
          // DEBUG: Выводим информацию о каждом игроке
          players.forEach((p, i) => {
            console.log(`[Roulette] Player ${i}:`, p.name, 'Chance:', p.chance, 'Bet:', p.bet, 'ID:', p.id);
          });
          
          // DEBUG для TMA: показываем toast с информацией о игроках
          if (players.length > 0) {
            const debugInfo = players.map(p => `${p.name}: ${p.chance.toFixed(1)}%`).join(', ');
            console.log('[DEBUG TMA] Players:', debugInfo);
          }
          
          // Обновляем игроков (только если НЕ идет спин)
          console.log('[Roulette] Updating players, count:', players.length, 'status:', data.round.status);
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
          this.updateBetButton(false); // Не в раунде
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
          // Раунд крутится - скрываем таймер и блокируем кнопку
          this.stopSmoothTimer();
          if (this.elements.timerWrap) {
            this.elements.timerWrap.classList.add('hidden');
          }
          this.disableBetButton();
          // Важно: не запускаем pre-spin, иначе визуально получается "двойной спин".
          this.stopPreSpinAnimation();
          this.startSpinSound();
        } else {
          this.stopPreSpinAnimation();
          this.stopSpinSound();
          this.stopSmoothTimer();
          if (this.elements.timerWrap) {
            this.elements.timerWrap.classList.add('hidden');
          }
        }
        
        // ВАЖНО: Если раунд только что завершился - показываем победителя
        // Проверяем что модалку для этого раунда ещё не показывали
        if (data.round.status === 'finished' && 
            data.round.winner_user_id && 
            this.state.shownWinnerRoundId !== data.round.id) {
          
          // Отмечаем что модалку для этого раунда показали
          this.state.shownWinnerRoundId = data.round.id;
          
          console.log('[Roulette] Round finished via polling, showing animation');

          // КРИТИЧЕСКИ ВАЖНО: на время анимации выключаем polling и блокируем любые DOM-обновления
          this.state.isSpinning = true;
          this.state.isAnimating = true;
          this.stopPolling();
          this.stopPreSpinAnimation();
          this.stopSpinSound();
          
          // Найти имя победителя из ставок (или из data.winner, если сервер прислал)
          const winnerBet = (data.bets || []).find(b => String(b.user_id) === String(data.round.winner_user_id));
          const winnerName = data.winner?.display_name || (winnerBet ? winnerBet.display_name : 'Игрок');
          
          // Блокируем UI
          this.disableBetButton();
          this.updateStatus('spinning');
          
          // ВАЖНО: Сначала запускаем анимацию вращения
          console.log('[Roulette] Starting animation for winner:', data.round.winner_user_id);
      await this.spinWheelAnimation(data.round.winner_user_id, data.round.id, data.winner_card_index);
          console.log('[Roulette] Animation completed via polling');
          
          // ТОЛЬКО ПОСЛЕ анимации показываем победителя
          this.showWinner(
            winnerName,
            parseFloat(data.round.winner_amount),
            data.round.winner_user_id,
            data.winner?.photo_url || this.state.lastWinnerPhotoUrl,
            winnerBet ? parseFloat(winnerBet.chance_percent || 0) : null
          );

          // Сразу очищаем UI старого раунда (чтобы он не висел под модалкой)
          this.clearRoundUIToWaiting();
          
          // Обновить баланс ТОЛЬКО если я победил (тихо, без toast)
          if (String(data.round.winner_user_id) === myUserIdStr) {
            if (window.userState && typeof window.userState.balance === 'number') {
              window.userState.balance = window.userState.balance + parseFloat(data.round.winner_amount);
              window.userState.prevBalance = window.userState.balance;
              
              if (typeof window.refreshBalanceUiAfterHydrate === 'function') {
                window.refreshBalanceUiAfterHydrate();
              }
            }
          }
          
          // Сбросить флаги и вернуть основной режим синхронизации (realtime+fallback)
          this.state.isAnimating = false;
          this.state.isSpinning = false;
          this.enableBetButton();
          this.startDataSync();
        }
        
      } else {
        // No active round - это нормально после завершения
        console.log('[Roulette] No active round from API');
        
        // КРИТИЧЕСКИ ВАЖНО: Если идет спин - НЕ ТРОГАЕМ НИЧЕГО!
        if (this.state.isSpinning) {
          console.log('[Roulette] 🔒 Spin in progress - NOT clearing anything');
          return; // Полностью игнорируем отсутствие раунда
        }
        
        this.state.currentRound = null;
        this.state.myBet = null;
        this.stopPreSpinAnimation();
        this.updateStatus('waiting');
        this.updatePot(0);
        this.updatePlayers([]);
        this.updateBetButton(false); // Не в раунде
        this.stopSmoothTimer();
        if (this.elements.timerWrap) {
          this.elements.timerWrap.classList.add('hidden');
        }
      }
      
      // Историю победителей грузим неблокирующе и не на каждом poll.
      const now = Date.now();
      if (!this.state.lastWinnersLoadAt || now - this.state.lastWinnersLoadAt > 10000) {
        this.state.lastWinnersLoadAt = now;
        this.loadRecentWinners().catch(() => {});
      }
      if (!this.state.lastMyHistoryLoadAt || now - this.state.lastMyHistoryLoadAt > 10000) {
        this.state.lastMyHistoryLoadAt = now;
        this.loadMyHistory().catch(() => {});
      }
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
    }, 350);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  updateBetButton(isInRound) {
    console.log('[Roulette] updateBetButton called, isInRound:', isInRound);
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
  }

  updatePot(amount) {
    if (this.elements.potAmount) {
      this.elements.potAmount.textContent = amount.toFixed(2);
    }
  }

  // ==================== PRE-SPIN (for non-initiator) ====================
  startPreSpinAnimation(timerEndsAtIso, serverTimeIso) {
    if (!this.elements.strip || this.state.isAnimating) return;
    // Всегда перезапускаем pre-spin на свежем серверном якоре времени.
    this.stopPreSpinAnimation();
    const cards = this.elements.strip.querySelectorAll('.roulette-card');
    if (!cards.length) return;

    const spinStartMs = new Date(timerEndsAtIso || 0).getTime();
    const serverNowMs = new Date(serverTimeIso || Date.now()).getTime();
    if (!Number.isFinite(spinStartMs) || !Number.isFinite(serverNowMs)) return;

    this.state.isPreSpinning = true;
    this.state.preSpinStartMs = spinStartMs;
    this.state.preSpinServerAnchorMs = serverNowMs;
    this.state.preSpinLocalAnchorMs = Date.now();
    this.elements.strip.style.transition = 'none';
    this.elements.strip.style.transform = 'translateX(0)';

    const cardWidth = 102;
    const cyclePx = Math.max(cardWidth, cards.length * cardWidth);
    const speedPxPerSec = 540;
    const tick = () => {
      if (!this.state.isPreSpinning || !this.elements.strip) return;
      const estServerNow = this.state.preSpinServerAnchorMs + (Date.now() - this.state.preSpinLocalAnchorMs);
      const elapsedMs = Math.max(0, estServerNow - this.state.preSpinStartMs);
      const traveled = (elapsedMs / 1000) * speedPxPerSec;
      const offset = traveled % cyclePx;
      this.elements.strip.style.transform = `translateX(${-offset}px)`;
      this.state.preSpinRafId = requestAnimationFrame(tick);
    };
    this.state.preSpinRafId = requestAnimationFrame(tick);
  }

  stopPreSpinAnimation() {
    this.state.isPreSpinning = false;
    if (this.state.preSpinRafId) {
      cancelAnimationFrame(this.state.preSpinRafId);
      this.state.preSpinRafId = null;
    }
    this.state.preSpinLastTs = 0;
    this.state.preSpinOffsetPx = 0;
    this.state.preSpinServerAnchorMs = 0;
    this.state.preSpinLocalAnchorMs = 0;
    this.state.preSpinStartMs = 0;
    if (this.elements.strip) {
      this.elements.strip.style.transition = 'none';
      this.elements.strip.style.transform = 'translateX(0)';
    }
  }

  // ==================== TIMER ====================
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
  }

  onTimerEnd() {
    // Защита от повторного вызова
    if (this.state.isSpinning) return;
    
    console.log('[Roulette] ⏰ Timer ended - LOCKING WHEEL');
    
    // КРИТИЧЕСКИ ВАЖНО: Устанавливаем флаг ПЕРЕД любыми действиями
    this.state.isSpinning = true;
    
    // ВАЖНО: Сохраняем текущее состояние карточек чтобы их нельзя было удалить
    console.log('[Roulette] Current cards count:', this.elements.strip?.children.length || 0);
    console.log('[Roulette] Current players:', this.state.players.length);
    
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
    
    // Не запускаем spin с клиента.
    // Сервер сам автозапустит spin при истечении timer_ends_at.
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
    console.log('[Roulette] updatePlayers called with', players.length, 'players, isSpinning:', this.state.isSpinning);
    players.forEach((p, i) => {
      console.log(`  - Player ${i}: ${p.name}, chance=${p.chance}, id=${p.id}`);
    });
    
    // КРИТИЧЕСКИ ВАЖНО: Если идет спин - ПОЛНОСТЬЮ ВЫХОДИМ!
    if (this.state.isSpinning) {
      console.log('[Roulette] 🔒 BLOCKED: updatePlayers during spin - NOT TOUCHING ANYTHING');
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
      this.elements.playersList.innerHTML = `
        <div style="text-align:center; padding:24px; color:var(--muted); font-size:13px;">
          Пока нет игроков. Будь первым!
        </div>
      `;
      return;
    }

    this.elements.playersList.innerHTML = this.state.players.map(player => {
      // Аватар: фото или инициал
      const avatarContent = player.photoUrl 
        ? `<img src="${this.escapeHtml(player.photoUrl)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><div style="display:none; width:100%; height:100%; align-items:center; justify-content:center; font-weight:900; font-size:16px; color:#07110c;">${player.name.charAt(0).toUpperCase()}</div>`
        : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:16px; color:#07110c;">${player.name.charAt(0).toUpperCase()}</div>`;
      
      return `
        <div class="pill" style="padding:10px 12px;">
          <div style="display:flex; align-items:center; gap:10px; flex:1;">
            <div style="width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, #8CFFC1, #4DFF9A); overflow:hidden; flex-shrink:0;">
              ${avatarContent}
            </div>
            <div style="flex:1; min-width:0;">
              <div style="font-weight:800; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(player.name)}</div>
              <div style="font-size:11px; color:var(--muted);">Ставка: <span style="color:var(--text); font-weight:700;">${player.bet.toFixed(2)} TON</span></div>
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:18px; font-weight:900; color:var(--accent);">${player.chance.toFixed(1)}%</div>
            <div style="font-size:10px; color:var(--muted);">шанс</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ==================== WHEEL ====================
  renderWheel() {
    if (!this.elements.strip) return;

    // ВАЖНО: НИКОГДА не перерисовываем если идет спин!
    if (this.state.isSpinning) {
      console.log('[Roulette] BLOCKED: Cannot render wheel during spin!');
      return;
    }

    if (this.state.players.length === 0) {
      this.elements.strip.innerHTML = `
        <div style="padding:0 20px; text-align:center; color:var(--muted); font-size:13px;">
          Ожидание игроков...
        </div>
      `;
      return;
    }

    // Проверяем нужно ли перерисовывать
    const playersKey = this.state.players.map(p => `${p.id}_${p.bet.toFixed(2)}`).join('|');
    if (this.state.lastPlayersKey === playersKey && this.elements.strip.children.length > 0) {
      console.log('[Roulette] Skipping wheel render - players unchanged');
      return;
    }
    this.state.lastPlayersKey = playersKey;

    console.log('[Roulette] Rendering wheel with', this.state.players.length, 'players');

    // КРИТИЧЕСКИ ВАЖНО: Используем готовый HTML от СЕРВЕРА!
    // Никаких вычислений на клиенте - просто вставляем HTML
    if (this.state.wheelCardsHTML && this.state.wheelCardsHTML.length > 0) {
      console.log('[Roulette] ✅ Using HTML from SERVER');
      this.elements.strip.innerHTML = this.state.wheelCardsHTML;
    } else {
      console.log('[Roulette] ⚠️ No HTML from server yet - waiting');
      this.elements.strip.innerHTML = `
        <div style="padding:0 20px; text-align:center; color:var(--muted); font-size:13px;">
          Загрузка карточек...
        </div>
      `;
      return;
    }
    
    this.elements.strip.style.transform = 'translateX(0)';
    this.elements.strip.style.transition = 'none';
    
    console.log('[Roulette] ✅ Wheel rendered from SERVER HTML - Ready for animation');
  }
  
  // Получить стабильный индекс цвета для игрока на основе его ID
  getPlayerColorIndex(userId) {
    // Простой хеш от user_id
    let hash = 0;
    const str = String(userId);
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash) % 5; // 5 цветов
  }
  
  // Детерминированная "случайная" функция на основе seed
  seededRandom(seed) {
    // Защита от некорректных значений
    if (!seed || typeof seed !== 'number') {
      console.warn('[Roulette] Invalid seed:', seed, 'using fallback');
      seed = 12345;
    }
    
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }
  
  // Анимация вращения рулетки (как в CS:GO кейсах)
  spinWheelAnimation(winnerUserId, roundId, winnerCardIndex = null) {
    return new Promise((resolve) => {
      if (!this.elements.strip || !this.elements.wheelContainer) {
        console.error('[Roulette] Missing elements for animation');
        resolve();
        return;
      }
      
      console.log('[Roulette] Starting SYNCHRONIZED animation for winner:', winnerUserId, 'round:', roundId);
      
      // КРИТИЧЕСКИ ВАЖНО: Проверяем что карточки существуют
      const checkCards = () => {
        const allCards = Array.from(this.elements.strip.querySelectorAll('.roulette-card'));
        console.log('[Roulette] Cards check - found:', allCards.length);
        
        if (allCards.length === 0) {
          console.error('[Roulette] ⚠️ NO CARDS FOUND! Strip HTML length:', this.elements.strip.innerHTML.length);
          console.error('[Roulette] Strip content preview:', this.elements.strip.innerHTML.substring(0, 200));
          console.error('[Roulette] wheelCardsHTML in state:', this.state.wheelCardsHTML?.length);
          
          // ПОПЫТКА ВОССТАНОВЛЕНИЯ: Если HTML есть в state но не в DOM - вставляем его
          if (this.state.wheelCardsHTML && this.state.wheelCardsHTML.length > 0) {
            console.log('[Roulette] 🔧 Attempting to restore cards from HTML state...');
            this.elements.strip.innerHTML = this.state.wheelCardsHTML;
            console.log('[Roulette] ✅ Cards restored from HTML state');
            
            // Повторная проверка после восстановления
            return Array.from(this.elements.strip.querySelectorAll('.roulette-card'));
          }
          
          return [];
        }
        
        return allCards;
      };
      
      // Проверяем карточки
      let allCards = checkCards();
      
      if (allCards.length === 0) {
        console.error('[Roulette] ❌ Cannot animate - no cards available even after restore attempt');
        resolve();
        return;
      }
      
      console.log('[Roulette] ✅ Cards verified, total:', allCards.length);
      
      // Сервер теперь может отдавать точный winner_card_index (индекс в общем массиве карточек).
      // Это гарантирует совпадение результата на сервере и визуального выпадения.
      let targetCardIndex = Number.isInteger(winnerCardIndex) ? winnerCardIndex : null;
      if (targetCardIndex != null) {
        if (targetCardIndex < 0 || targetCardIndex >= allCards.length) {
          console.warn('[Roulette] Invalid winnerCardIndex from server:', targetCardIndex);
          targetCardIndex = null;
        }
      }
      
      // Fallback для старого бэка: выбрать одну из карточек победителя детерминированно
      const seed1 = roundId || winnerUserId || Date.now();
      const seed2 = seed1 + 1;
      const seed3 = seed1 + 2;
      
      if (targetCardIndex == null) {
        const winnerCards = allCards.filter(card => 
          String(card.getAttribute('data-user-id')) === String(winnerUserId)
        );
        
        console.log('[Roulette] Winner cards found (fallback):', winnerCards.length);
        
        if (winnerCards.length === 0) {
          console.error('[Roulette] No winner cards found for user:', winnerUserId);
          resolve();
          return;
        }
        
        const randomFactor = this.seededRandom(seed1); // 0..1
        const targetIndex = Math.floor(winnerCards.length * 0.6 + randomFactor * winnerCards.length * 0.3);
        const targetCard = winnerCards[targetIndex];
        targetCardIndex = allCards.indexOf(targetCard);
      }

      // Истина = winner_card_index с сервера. Принудительно НЕ переопределяем индекс.
      
      console.log('[Roulette] Target card index:', targetCardIndex, 'of', allCards.length);
      
      // Рассчитываем позицию по реальной геометрии DOM,
      // чтобы центрировалась именно нужная карточка (без смещения на 1 влево).
      const containerWidth = this.elements.wheelContainer.offsetWidth;
      const targetCardEl = allCards[targetCardIndex];
      if (!targetCardEl) {
        console.error('[Roulette] Target card element not found for index:', targetCardIndex);
        resolve();
        return;
      }
      const targetCenterPx = targetCardEl.offsetLeft + (targetCardEl.offsetWidth / 2);
      const containerCenterPx = containerWidth / 2;
      const finalPosition = containerCenterPx - targetCenterPx;
      const cardWidth = Math.max(1, targetCardEl.offsetWidth);
      
      // Стабильный "обычный" спин:
      // большая базовая дистанция -> одинаковый визуальный темп независимо от target index.
      const extraCardsTravel = (allCards.length * 4) + 90;
      const extraSpins = extraCardsTravel * cardWidth;
      
      // Финальная позиция с учетом дополнительного прокрута
      const totalDistance = extraSpins + Math.abs(finalPosition);
      
      const pxPerSec = 850; // ограничиваем стартовую скорость
      const duration = Math.max(7600, Math.min(11000, Math.round((Math.abs(totalDistance) / pxPerSec) * 1000)));
      console.log('[Roulette] SYNC Animation:', {
        currentPosition: 0,
        finalPosition,
        totalDistance,
        extraSpins,
        duration,
        roundId: seed1
      });
      
      // ВАЖНО: Карточки УЖЕ на месте (translateX(0)), НЕ ТРОГАЕМ ИХ!
      // Просто убеждаемся что transition выключен
      this.elements.strip.style.transition = 'none';
      // Карточки остаются на месте!
      this.elements.strip.style.transform = 'translateX(0)';
      
      // Даем браузеру время применить (хотя ничего не меняется)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Мягкий старт без резкого ускорения в начале.
          this.elements.strip.style.transition = `transform ${duration}ms cubic-bezier(0.12, 0, 0.20, 1)`;
          this.elements.strip.style.transform = `translateX(${finalPosition}px)`;
          
          console.log('[Roulette] ✅ Animation started', {
            duration,
            totalDistance,
            cards: allCards.length
          });
          
          // Ждем окончания анимации + дополнительная задержка
          setTimeout(() => {
            const winnerCardEl = allCards[targetCardIndex];
            if (winnerCardEl) {
              winnerCardEl.classList.add('roulette-card--winner');
            }
            this.hapticImpact('medium');
            this.stopSpinSound();
            // Даем пользователю явно увидеть подсветку ДО модалки.
            setTimeout(() => {
              if (winnerCardEl) winnerCardEl.classList.remove('roulette-card--winner');
              console.log('[Roulette] Animation COMPLETED - resolving promise');
              resolve();
            }, 700);
          }, duration + 1000); // +1 секунда для паузы после остановки
        });
      });
    });
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
  async spinRoulette() {
    try {
      console.log('[Roulette] Spinning...');
      this.stopPreSpinAnimation();
      this.startSpinSound();
      this.hapticImpact('medium');

      // Инициатор: гарантированно скрываем таймер (polling уже остановлен)
      this.stopSmoothTimer();
      if (this.elements.timerWrap) {
        this.elements.timerWrap.classList.add('hidden');
      }
      
      // ВАЖНО: Останавливаем polling на время спина
      this.stopPolling();
      
      // Блокируем UI
      this.disableBetButton();
      this.updateStatus('spinning');
      
      // Вызываем API для получения победителя
      const data = await this.callAPI('spinRoulette', {
        request_id: this.generateRequestId('spinRoulette'),
      });
      
      console.log('[Roulette] Winner from API:', data.winner);
      console.log('[Roulette] Round ID from API:', data.round_id);
      console.log('[Roulette] Full API response:', data);
      
      // ВАЖНО: Сначала запускаем анимацию вращения с победителем из API
      console.log('[Roulette] Starting animation...');
      this.state.isAnimating = true;
      await this.spinWheelAnimation(data.winner.user_id, data.round_id, data.winner_card_index);
      this.state.isAnimating = false;
      console.log('[Roulette] Animation completed');
      
      // ТОЛЬКО ПОСЛЕ анимации показываем победителя
      this.showWinner(
        data.winner.display_name,
        data.winner.amount,
        data.winner.user_id,
        data.winner.photo_url,
        Number.isFinite(Number(data.winner.chance)) ? Number(data.winner.chance) : null
      );

      // Сразу убираем UI старого раунда при появлении модалки
      this.clearRoundUIToWaiting();
      
      // Обновляем баланс если я победил (тихо, без toast)
      const myUserIdStr = String(this.state.myUserId);
      if (String(data.winner.user_id) === myUserIdStr) {
        if (window.userState && typeof window.userState.balance === 'number') {
          window.userState.balance = window.userState.balance + data.winner.amount;
          window.userState.prevBalance = window.userState.balance;
          
          if (typeof window.refreshBalanceUiAfterHydrate === 'function') {
            window.refreshBalanceUiAfterHydrate();
          }
        }
      }
      
      // После закрытия модалки загружаем новый раунд и возобновляем polling
      setTimeout(() => {
        this.state.isSpinning = false;
        this.enableBetButton();
        this.loadActiveRound();
        // ВАЖНО: Запускаем polling снова
        this.startDataSync();
      }, 5500);
      
    } catch (error) {
      console.error('[Roulette] Spin error:', error);
      console.error('[Roulette] Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      
      this.state.isSpinning = false;
      this.state.isAnimating = false;
      this.stopPreSpinAnimation();
      this.stopSpinSound();
      
      // Если розыгрыш уже идет - НЕ показываем ошибку, просто ждем через polling
      if (error.message && (error.message.includes('уже идет') || error.message.includes('уже запущен') || error.message.includes('уже завершен'))) {
        console.log('[Roulette] Spin already in progress or finished, waiting via polling...');
        this.disableBetButton();
        // ВАЖНО: Запускаем polling снова
        this.startDataSync();
        // Polling автоматически обнаружит завершение раунда и покажет анимацию
      } else {
        // Другая ошибка - НЕ показываем toast, только логируем
        console.error('[Roulette] Spin error - not showing to user');
        // this.showToast('Ошибка: ' + error.message);
        setTimeout(() => {
          this.enableBetButton();
          this.loadActiveRound();
          // ВАЖНО: Запускаем polling снова
          this.startDataSync();
        }, 2000);
      }
    }
  }

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
      this.elements.winnerModal.classList.add('show');
      const isWin = String(winnerUserId) === String(this.state.myUserId);
      this.playResultSound(isWin);
      this.hapticNotify(isWin ? 'success' : 'warning');
      
      // Автоматически закрываем через 5 секунд
      setTimeout(() => {
        if (this.elements.winnerModal) {
          this.elements.winnerModal.classList.remove('show');
        }
      }, 3200);
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

  // ==================== RECENT WINNERS ====================
  async loadRecentWinners() {
    try {
      if (this.elements.recentWinners) {
        this.elements.recentWinners.innerHTML = `
          <div class="skeleton-card"></div>
          <div class="skeleton-card"></div>
          <div class="skeleton-card"></div>
        `;
      }
      const data = await this.callAPI('getRecentWinners', { limit: 5 });
      
      if (data.winners && data.winners.length > 0) {
        this.renderRecentWinners(data.winners);
      } else {
        this.renderRecentWinners([]);
      }
    } catch (error) {
      console.error('Failed to load recent winners:', error);
    }
  }
  
  renderRecentWinners(winners) {
    if (!this.elements.recentWinners) return;
    
    if (winners.length === 0) {
      this.elements.recentWinners.innerHTML = `
        <div style="text-align:center; padding:20px; color:var(--muted); font-size:13px;">
          История пока пуста
        </div>
      `;
      return;
    }
    
    this.elements.recentWinners.innerHTML = winners.map(winner => {
      const date = new Date(winner.created_at);
      const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      
      // Аватар: фото или инициал
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

  async loadMyHistory() {
    try {
      if (this.elements.myHistory) {
        this.elements.myHistory.innerHTML = `
          <div class="skeleton-card"></div>
          <div class="skeleton-card"></div>
          <div class="skeleton-card"></div>
        `;
      }
      const data = await this.callAPI('getMyHistory', { limit: 8 });
      this.renderMyHistory(data.history || []);
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
  // Load initial data and start polling
  rouletteUI.loadActiveRound();
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
  console.log('[Roulette] Script loaded - VERSION: 20260508-AVATARS - AVATARS WITH TIMEOUT');
  
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
