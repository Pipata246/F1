/**
 * Roulette UI Manager
 * Manages all UI updates and interactions for the roulette game
 * Stage 3: Backend integration with API calls
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
      myUserId: null,
      myBet: null,
      isLoading: false,
      isInRound: false, // Флаг: пользователь в раунде или нет
    };

    this.pollInterval = null;
    this.init();
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

      const data = await response.json();
      
      if (!data.ok) {
        throw new Error(data.error || 'API error');
      }

      return data;
    } catch (error) {
      console.error('API call failed:', error);
      throw error;
    }
  }

  async loadActiveRound() {
    try {
      const data = await this.callAPI('getActiveRound');
      
      if (data.round) {
        const previousStatus = this.state.currentRound?.status;
        const previousRoundId = this.state.currentRound?.id;
        
        this.state.currentRound = data.round;
        
        // Update UI
        this.updateStatus(data.round.status);
        this.updatePot(parseFloat(data.round.pot_amount));
        
        // Process players
        const players = data.bets.map(bet => ({
          id: bet.user_id,
          name: bet.display_name,
          bet: parseFloat(bet.bet_amount),
          chance: parseFloat(bet.chance_percent)
        }));
        
        this.updatePlayers(players);
        
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
        
        // Handle timer - используем ТОЛЬКО серверное время
        if (data.round.status === 'active' && data.round.timer_ends_at) {
          const endsAt = new Date(data.round.timer_ends_at);
          const now = new Date();
          const remaining = Math.max(0, Math.floor((endsAt - now) / 1000));
          
          // Показываем таймер
          this.updateTimerDisplay(remaining);
          if (this.elements.timerWrap) {
            this.elements.timerWrap.classList.remove('hidden');
          }
          
          // Если время истекло - запускаем спин (только один раз)
          if (remaining <= 0 && !this.state.isSpinning) {
            this.onTimerEnd();
          }
        } else {
          if (this.elements.timerWrap) {
            this.elements.timerWrap.classList.add('hidden');
          }
        }
        
        // ВАЖНО: Если раунд только что завершился - показываем победителя
        if (data.round.status === 'finished' && previousStatus === 'spinning' && data.round.id === previousRoundId) {
          // Раунд завершился, показываем результат
          if (data.round.winner_user_id) {
            // Найти имя победителя из ставок
            const winnerBet = data.bets.find(b => String(b.user_id) === String(data.round.winner_user_id));
            const winnerName = winnerBet ? winnerBet.display_name : 'Игрок';
            
            this.showWinner(winnerName, parseFloat(data.round.winner_amount));
            
            // Обновить баланс если я победил
            if (String(data.round.winner_user_id) === myUserIdStr) {
              if (typeof window.hydrateUserFromServer === 'function') {
                await window.hydrateUserFromServer();
                if (typeof window.refreshBalanceUiAfterHydrate === 'function') {
                  window.refreshBalanceUiAfterHydrate();
                }
              }
            }
            
            // Сбросить флаг спина
            this.state.isSpinning = false;
            this.enableBetButton();
          }
        }
        
      } else {
        // No active round
        this.state.currentRound = null;
        this.state.myBet = null;
        this.updateStatus('waiting');
        this.updatePot(0);
        this.updatePlayers([]);
        this.updateBetButton(false); // Не в раунде
        if (this.elements.timerWrap) {
          this.elements.timerWrap.classList.add('hidden');
        }
      }
    } catch (error) {
      console.error('Failed to load active round:', error);
      this.showToast('Ошибка загрузки: ' + error.message);
    }
  }

  startPolling() {
    // Poll every 1 second for smooth timer updates
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    
    this.pollInterval = setInterval(() => {
      this.loadActiveRound();
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
    
    this.state.isSpinning = true;
    this.updateStatus('spinning');
    
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
    this.state.players = players;
    
    if (this.elements.playerCount) {
      this.elements.playerCount.textContent = players.length;
    }

    this.renderPlayersList();
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

    this.elements.playersList.innerHTML = this.state.players.map(player => `
      <div class="pill" style="padding:10px 12px;">
        <div style="display:flex; align-items:center; gap:10px; flex:1;">
          <div style="width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, #8CFFC1, #4DFF9A); display:flex; align-items:center; justify-content:center; font-weight:900; font-size:16px; color:#07110c;">
            ${player.name.charAt(0).toUpperCase()}
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
    `).join('');
  }

  // ==================== WHEEL ====================
  renderWheel() {
    if (!this.elements.strip) return;

    if (this.state.players.length === 0) {
      this.elements.strip.innerHTML = `
        <div style="padding:0 20px; text-align:center; color:var(--muted); font-size:13px;">
          Ожидание игроков...
        </div>
      `;
      return;
    }

    // Create segments based on player chances
    const segments = this.state.players.map((player, index) => {
      const colors = [
        'linear-gradient(135deg, #8CFFC1, #4DFF9A)',
        'linear-gradient(135deg, #fbbf24, #f59e0b)',
        'linear-gradient(135deg, #fb923c, #f97316)',
        'linear-gradient(135deg, #a78bfa, #8b5cf6)',
        'linear-gradient(135deg, #60a5fa, #3b82f6)',
      ];
      const color = colors[index % colors.length];
      
      // Width based on chance (minimum 80px for visibility)
      const width = Math.max(80, player.chance * 4);

      return `
        <div style="
          min-width:${width}px;
          height:100%;
          background:${color};
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          padding:0 16px;
          border-right:2px solid rgba(0,0,0,0.3);
        ">
          <div style="width:32px; height:32px; border-radius:50%; background:rgba(255,255,255,0.9); display:flex; align-items:center; justify-content:center; font-weight:900; font-size:14px; color:#07110c; margin-bottom:4px;">
            ${player.name.charAt(0).toUpperCase()}
          </div>
          <div style="font-size:11px; font-weight:800; color:rgba(0,0,0,0.8); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;">
            ${this.escapeHtml(player.name)}
          </div>
          <div style="font-size:10px; font-weight:700; color:rgba(0,0,0,0.6);">
            ${player.chance.toFixed(1)}%
          </div>
        </div>
      `;
    });

    // Repeat segments to create infinite loop effect
    const repeatedSegments = segments.concat(segments).concat(segments);
    this.elements.strip.innerHTML = repeatedSegments.join('');
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
      // Выбираем действие в зависимости от того, в раунде ли пользователь
      const action = this.state.isInRound ? 'raiseBet' : 'joinRound';
      const paramName = this.state.isInRound ? 'raiseAmount' : 'betAmount';
      
      await this.callAPI(action, { [paramName]: amount });
      this.showToast(this.state.isInRound ? 'Ставка повышена!' : 'Ставка принята!');
      
      // Clear input
      if (betInput) {
        betInput.value = '';
      }
      
      // Reload round data
      await this.loadActiveRound();
      
      // Refresh user balance
      if (typeof window.hydrateUserFromServer === 'function') {
        await window.hydrateUserFromServer();
        if (typeof window.refreshBalanceUiAfterHydrate === 'function') {
          window.refreshBalanceUiAfterHydrate();
        }
      }
    } catch (error) {
      this.showToast(error.message || 'Ошибка при обработке ставки');
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
      
      // Вызываем API
      const data = await this.callAPI('spinRoulette');
      
      console.log('[Roulette] Winner:', data.winner);
      
      // Показываем победителя
      this.showWinner(data.winner.display_name, data.winner.amount);
      
      // Обновляем баланс если я победил
      const myUserIdStr = String(this.state.myUserId);
      if (String(data.winner.user_id) === myUserIdStr) {
        if (typeof window.hydrateUserFromServer === 'function') {
          await window.hydrateUserFromServer();
          if (typeof window.refreshBalanceUiAfterHydrate === 'function') {
            window.refreshBalanceUiAfterHydrate();
          }
        }
      }
      
      // Через 5 секунд загружаем новый раунд и разблокируем кнопку
      setTimeout(() => {
        this.state.isSpinning = false;
        this.enableBetButton();
        this.loadActiveRound();
      }, 5000);
      
    } catch (error) {
      console.error('[Roulette] Spin error:', error);
      
      // Если розыгрыш уже идет - просто ждем результата
      if (error.message && error.message.includes('уже идет')) {
        console.log('[Roulette] Spin already in progress, waiting for result...');
        this.showToast('Ожидание результата...');
        
        // Проверяем результат каждую секунду
        const checkInterval = setInterval(async () => {
          const data = await this.callAPI('getActiveRound');
          
          // Если раунд завершен - показываем результат
          if (!data.round || data.round.status === 'finished') {
            clearInterval(checkInterval);
            
            // Обновляем баланс
            if (typeof window.hydrateUserFromServer === 'function') {
              await window.hydrateUserFromServer();
              if (typeof window.refreshBalanceUiAfterHydrate === 'function') {
                window.refreshBalanceUiAfterHydrate();
              }
            }
            
            // Загружаем новый раунд
            setTimeout(() => {
              this.enableBetButton();
              this.loadActiveRound();
            }, 2000);
          }
        }, 1000);
        
        // Таймаут на 10 секунд
        setTimeout(() => {
          clearInterval(checkInterval);
          this.state.isSpinning = false;
          this.enableBetButton();
          this.loadActiveRound();
        }, 10000);
        
      } else {
        // Другая ошибка
        this.showToast('Ошибка розыгрыша: ' + error.message);
        setTimeout(() => {
          this.state.isSpinning = false;
          this.enableBetButton();
          this.loadActiveRound();
        }, 2000);
      }
    }
  }

  showWinner(winnerName, amount) {
    if (this.elements.winnerName) {
      this.elements.winnerName.textContent = winnerName;
    }
    if (this.elements.winnerAmount) {
      this.elements.winnerAmount.textContent = amount.toFixed(2);
    }
    if (this.elements.winnerModal) {
      this.elements.winnerModal.classList.add('show');
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
