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
      
      // Actions
      joinSection: document.getElementById('rouletteJoinSection'),
      raiseSection: document.getElementById('rouletteRaiseSection'),
      betInput: document.getElementById('rouletteBetInput'),
      raiseInput: document.getElementById('rouletteRaiseInput'),
      joinBtn: document.getElementById('rouletteJoinBtn'),
      raiseBtn: document.getElementById('rouletteRaiseBtn'),
      yourBet: document.getElementById('rouletteYourBet'),
      yourChance: document.getElementById('rouletteYourChance'),
      
      // Winners
      recentWinners: document.getElementById('rouletteRecentWinners'),
      winnerModal: document.getElementById('rouletteWinnerModal'),
      winnerName: document.getElementById('rouletteWinnerName'),
      winnerAmount: document.getElementById('rouletteWinnerAmount'),
    };

    this.state = {
      currentRound: null,
      players: [],
      isSpinning: false,
      myUserId: null,
      myBet: null,
      isLoading: false,
    };

    this.pollInterval = null;
    this.init();
  }

  init() {
    // Setup event listeners
    this.elements.joinBtn?.addEventListener('click', () => this.handleJoin());
    this.elements.raiseBtn?.addEventListener('click', () => this.handleRaise());
    
    // Initialize with empty state
    this.updateStatus('waiting');
    this.updatePot(0);
    this.updatePlayers([]);
    
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
        
        // Check if I'm in this round
        const myBet = data.bets.find(b => b.user_id === this.state.myUserId);
        if (myBet) {
          this.state.myBet = myBet;
          this.showRaiseSection();
          this.updateMyBetInfo(parseFloat(myBet.bet_amount), parseFloat(myBet.chance_percent));
        } else {
          this.state.myBet = null;
          this.showJoinSection();
        }
        
        // Handle timer
        if (data.round.status === 'active' && data.round.timer_ends_at) {
          const endsAt = new Date(data.round.timer_ends_at);
          const now = new Date();
          const remaining = Math.max(0, Math.floor((endsAt - now) / 1000));
          
          if (remaining > 0) {
            this.startTimer(remaining);
          }
        } else {
          this.stopTimer();
        }
      } else {
        // No active round
        this.state.currentRound = null;
        this.state.myBet = null;
        this.updateStatus('waiting');
        this.updatePot(0);
        this.updatePlayers([]);
        this.showJoinSection();
        this.stopTimer();
      }
    } catch (error) {
      console.error('Failed to load active round:', error);
      this.showToast('Ошибка загрузки: ' + error.message);
    }
  }

  startPolling() {
    // Poll every 2 seconds
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    
    this.pollInterval = setInterval(() => {
      this.loadActiveRound();
    }, 2000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  showJoinSection() {
    if (this.elements.joinSection) {
      this.elements.joinSection.classList.remove('hidden');
    }
    if (this.elements.raiseSection) {
      this.elements.raiseSection.classList.add('hidden');
    }
  }

  showRaiseSection() {
    if (this.elements.joinSection) {
      this.elements.joinSection.classList.add('hidden');
    }
    if (this.elements.raiseSection) {
      this.elements.raiseSection.classList.remove('hidden');
    }
  }

  updateMyBetInfo(betAmount, chancePercent) {
    if (this.elements.yourBet) {
      this.elements.yourBet.textContent = betAmount.toFixed(2);
    }
    if (this.elements.yourChance) {
      this.elements.yourChance.textContent = chancePercent.toFixed(1);
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
  startTimer(seconds) {
    if (this.elements.timerWrap) {
      this.elements.timerWrap.classList.remove('hidden');
    }

    let remaining = seconds;
    this.updateTimerDisplay(remaining);

    if (this.timerInterval) clearInterval(this.timerInterval);
    
    this.timerInterval = setInterval(() => {
      remaining--;
      this.updateTimerDisplay(remaining);

      if (remaining <= 0) {
        clearInterval(this.timerInterval);
        this.onTimerEnd();
      }
    }, 1000);
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

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.elements.timerWrap) {
      this.elements.timerWrap.classList.add('hidden');
    }
  }

  onTimerEnd() {
    this.stopTimer();
    this.updateStatus('spinning');
    // Stage 1: Just visual feedback
    console.log('Timer ended - would trigger spin');
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
  async handleJoin() {
    if (this.state.isLoading) return;
    
    const amount = parseFloat(this.elements.betInput?.value || 0);
    
    if (amount < 0.1) {
      this.showToast('Минимальная ставка: 0.1 TON');
      return;
    }

    this.state.isLoading = true;
    if (this.elements.joinBtn) {
      this.elements.joinBtn.disabled = true;
      this.elements.joinBtn.textContent = 'Отправка...';
    }

    try {
      await this.callAPI('joinRound', { betAmount: amount });
      this.showToast('Ставка принята!');
      
      // Clear input
      if (this.elements.betInput) {
        this.elements.betInput.value = '';
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
      this.showToast(error.message || 'Ошибка при входе в раунд');
    } finally {
      this.state.isLoading = false;
      if (this.elements.joinBtn) {
        this.elements.joinBtn.disabled = false;
        this.elements.joinBtn.textContent = 'Войти в раунд';
      }
    }
  }

  async handleRaise() {
    if (this.state.isLoading) return;
    
    const amount = parseFloat(this.elements.raiseInput?.value || 0);
    
    if (amount < 0.1) {
      this.showToast('Минимальное повышение: 0.1 TON');
      return;
    }

    this.state.isLoading = true;
    if (this.elements.raiseBtn) {
      this.elements.raiseBtn.disabled = true;
      this.elements.raiseBtn.textContent = 'Отправка...';
    }

    try {
      await this.callAPI('raiseBet', { raiseAmount: amount });
      this.showToast('Ставка повышена!');
      
      // Clear input
      if (this.elements.raiseInput) {
        this.elements.raiseInput.value = '';
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
      this.showToast(error.message || 'Ошибка при повышении ставки');
    } finally {
      this.state.isLoading = false;
      if (this.elements.raiseBtn) {
        this.elements.raiseBtn.disabled = false;
        this.elements.raiseBtn.textContent = 'Повысить';
      }
    }
  }

  // ==================== WINNER ====================
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
