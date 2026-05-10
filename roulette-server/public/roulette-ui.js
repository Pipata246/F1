/**
 * Roulette UI Manager
 * Manages all UI updates and interactions for the roulette game
 * Stage 3: Backend integration with API calls
 * VERSION: AVATARS20260508 - AVATARS WITH 2 SECOND TIMEOUT
 */

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
    };

    this.pollInterval = null;
    this.timerInterval = null; // Интервал для плавного обновления таймера
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
    this.updateBetButton(false);
  }

  init() {
    // Setup event listeners
    this.elements.betBtn?.addEventListener('click', () => this.handleBet());
    
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

  async loadActiveRound() {
    try {
      // Во время локальной анимации не трогаем UI из polling,
      // иначе можно сбросить DOM колеса и получить "пропали карточки".
      if (this.state.isAnimating) {
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
        this.updateStatus(data.round.status);
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
        if (data.round.status === 'active' && data.round.timer_ends_at) {
          const endsAt = new Date(data.round.timer_ends_at);
          const serverNow = new Date(data.serverTime);
          
          // Сохраняем синхронизацию времени
          this.state.lastServerTime = serverNow.getTime();
          this.state.lastLocalTime = Date.now();
          this.state.timerEndTime = endsAt.getTime();
          
          // Запускаем локальный таймер для плавного отображения
          this.startSmoothTimer();
          
          if (this.elements.timerWrap) {
            this.elements.timerWrap.classList.remove('hidden');
          }
        } else if (data.round.status === 'spinning') {
          // Раунд крутится - скрываем таймер и блокируем кнопку
          this.stopSmoothTimer();
          if (this.elements.timerWrap) {
            this.elements.timerWrap.classList.add('hidden');
          }
          this.disableBetButton();
        } else {
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
          
          // Найти имя победителя из ставок (или из data.winner, если сервер прислал)
          const winnerBet = (data.bets || []).find(b => String(b.user_id) === String(data.round.winner_user_id));
          const winnerName = data.winner?.display_name || (winnerBet ? winnerBet.display_name : 'Игрок');
          
          // Блокируем UI
          this.disableBetButton();
          this.updateStatus('spinning');
          
          // ВАЖНО: Сначала запускаем анимацию вращения
          console.log('[Roulette] Starting animation for winner:', data.round.winner_user_id);
          await this.spinWheelAnimation(data.round.winner_user_id, data.round.id);
          console.log('[Roulette] Animation completed via polling');
          
          // ТОЛЬКО ПОСЛЕ анимации показываем победителя
          this.showWinner(
            winnerName,
            parseFloat(data.round.winner_amount),
            data.round.winner_user_id,
            data.winner?.photo_url || this.state.lastWinnerPhotoUrl
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
          
          // Сбросить флаги и вернуть polling
          this.state.isAnimating = false;
          this.state.isSpinning = false;
          this.enableBetButton();
          this.startPolling();
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
        this.updateStatus('waiting');
        this.updatePot(0);
        this.updatePlayers([]);
        this.updateBetButton(false); // Не в раунде
        this.stopSmoothTimer();
        if (this.elements.timerWrap) {
          this.elements.timerWrap.classList.add('hidden');
        }
      }
      
      // Загружаем историю победителей
      await this.loadRecentWinners();
    } catch (error) {
      console.error('[Roulette] Failed to load active round:', error);
      // НЕ показываем toast - тихо логируем ошибку
    }
  }

  startPolling() {
    // Poll every 1 second for smooth timer updates
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    
    this.pollInterval = setInterval(() => {
      // Во время спина polling ДОЛЖЕН продолжаться, чтобы увидеть `finished`.
      // UI-рендер колеса уже защищён через isSpinning (renderWheel/updatePlayers).
      if (!this.state.isAnimating) {
        this.loadActiveRound();
      }
    }, 1000);
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
      const remaining = Math.max(0, Math.floor((this.state.timerEndTime - estimatedServerTime) / 1000));
      
      this.updateTimerDisplay(remaining);
      
      // Если время истекло - запускаем спин
      if (remaining <= 0 && !this.state.isSpinning) {
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
    // Инициатор спина сам останавливает polling, поэтому таймер нужно скрыть прямо тут
    this.stopSmoothTimer();
    if (this.elements.timerWrap) {
      this.elements.timerWrap.classList.add('hidden');
    }
    
    // Блокируем кнопку ставки
    this.disableBetButton();
    
    // Вызываем спин рулетки
    this.spinRoulette();
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
  spinWheelAnimation(winnerUserId, roundId) {
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
      
      const winnerCards = allCards.filter(card => 
        String(card.getAttribute('data-user-id')) === String(winnerUserId)
      );
      
      console.log('[Roulette] Winner cards found:', winnerCards.length);
      
      if (winnerCards.length === 0) {
        console.error('[Roulette] No winner cards found for user:', winnerUserId);
        resolve();
        return;
      }
      
      // СИНХРОНИЗАЦИЯ: Используем roundId как seed для детерминированного выбора
      // Если roundId нет - используем winnerId как fallback
      const seed1 = roundId || winnerUserId || Date.now();
      const seed2 = seed1 + 1;
      const seed3 = seed1 + 2;
      
      console.log('[Roulette] Using seed:', seed1, 'from roundId:', roundId);
      
      // Выбираем карточку победителя детерминированно (все видят одинаковую)
      const randomFactor = this.seededRandom(seed1); // 0..1
      const targetIndex = Math.floor(winnerCards.length * 0.6 + randomFactor * winnerCards.length * 0.3);
      const targetCard = winnerCards[targetIndex];
      const targetCardIndex = allCards.indexOf(targetCard);
      
      console.log('[Roulette] SYNC: Target card index:', targetCardIndex, 'of', allCards.length, 'seed:', seed1);
      
      // Рассчитываем позицию для остановки (карточка должна быть в центре)
      const containerWidth = this.elements.wheelContainer.offsetWidth;
      const cardWidth = 102; // 100px + 2px border
      const centerOffset = containerWidth / 2 - cardWidth / 2;
      
      // Детерминированное смещение (все видят одинаковое)
      const randomOffset = (this.seededRandom(seed2) - 0.5) * 40;
      
      // Финальная позиция
      const finalPosition = -(targetCardIndex * cardWidth) + centerOffset + randomOffset;
      
      // Детерминированное количество оборотов (все видят одинаковое)
      const extraSpins = (3 + this.seededRandom(seed3) * 1) * allCards.length * cardWidth;
      
      // КРИТИЧЕСКИ ВАЖНО: НЕ ДВИГАЕМ КАРТОЧКИ! Они должны остаться на месте!
      // Финальная позиция учитывает дополнительные обороты
      const totalDistance = extraSpins + (targetCardIndex * cardWidth) - centerOffset - randomOffset;
      
      console.log('[Roulette] SYNC Animation:', {
        currentPosition: 0,
        finalPosition,
        totalDistance,
        extraSpins,
        duration: 7000,
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
          // ИНТРИГА: Длинная анимация с медленным финалом
          const duration = 10000; // 10 секунд для интриги!
          
          // Easing: быстрый старт → медленный финал (максимальная интрига!)
          // cubic-bezier(0.33, 1, 0.68, 1) - очень медленный финал
          this.elements.strip.style.transition = `transform ${duration}ms cubic-bezier(0.33, 1, 0.68, 1)`;
          this.elements.strip.style.transform = `translateX(${finalPosition}px)`;
          
          console.log('[Roulette] ✅ Animation started - SUSPENSE MODE (10s)!');
          
          // Ждем окончания анимации + дополнительная задержка
          setTimeout(() => {
            console.log('[Roulette] Animation COMPLETED - resolving promise');
            resolve();
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
      
      await this.callAPI(action, { [paramName]: amount });
      
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
      const data = await this.callAPI('spinRoulette');
      
      console.log('[Roulette] Winner from API:', data.winner);
      console.log('[Roulette] Round ID from API:', data.round_id);
      console.log('[Roulette] Full API response:', data);
      
      // ВАЖНО: Сначала запускаем анимацию вращения с победителем из API
      console.log('[Roulette] Starting animation...');
      this.state.isAnimating = true;
      await this.spinWheelAnimation(data.winner.user_id, data.round_id);
      this.state.isAnimating = false;
      console.log('[Roulette] Animation completed');
      
      // ТОЛЬКО ПОСЛЕ анимации показываем победителя
      this.showWinner(
        data.winner.display_name,
        data.winner.amount,
        data.winner.user_id,
        data.winner.photo_url
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
        this.startPolling();
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
      
      // Если розыгрыш уже идет - НЕ показываем ошибку, просто ждем через polling
      if (error.message && (error.message.includes('уже идет') || error.message.includes('уже запущен') || error.message.includes('уже завершен'))) {
        console.log('[Roulette] Spin already in progress or finished, waiting via polling...');
        this.disableBetButton();
        // ВАЖНО: Запускаем polling снова
        this.startPolling();
        // Polling автоматически обнаружит завершение раунда и покажет анимацию
      } else {
        // Другая ошибка - НЕ показываем toast, только логируем
        console.error('[Roulette] Spin error - not showing to user');
        // this.showToast('Ошибка: ' + error.message);
        setTimeout(() => {
          this.enableBetButton();
          this.loadActiveRound();
          // ВАЖНО: Запускаем polling снова
          this.startPolling();
        }, 2000);
      }
    }
  }

  showWinner(winnerName, amount, winnerUserId, winnerPhotoUrl = null) {
    if (this.elements.winnerName) {
      this.elements.winnerName.textContent = winnerName;
    }
    if (this.elements.winnerAmount) {
      this.elements.winnerAmount.textContent = amount.toFixed(2);
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
      
      // Автоматически закрываем через 5 секунд
      setTimeout(() => {
        if (this.elements.winnerModal) {
          this.elements.winnerModal.classList.remove('show');
        }
      }, 5000);
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
  rouletteUI.startPolling();
}

// Stop polling when leaving roulette tab
function stopRouletteUI() {
  if (rouletteUI) {
    rouletteUI.stopPolling();
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
        rouletteUI.startPolling();
      }
    }
  });
}
