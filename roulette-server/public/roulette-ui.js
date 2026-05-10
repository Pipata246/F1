/**
 * Roulette UI Manager
 * Manages all UI updates and interactions for the roulette game
 * Stage 3: Backend integration with API calls
 * VERSION: NEVERCLEARS20260508 - NEVER CLEARS PLAYERS DURING SPIN
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
      lastServerTime: null, // Последнее серверное время
      lastLocalTime: null, // Последнее локальное время
      timerEndTime: null, // Время окончания таймера
      shownWinnerRoundId: null, // ID раунда, для которого уже показали модалку победителя
      lastPlayersKey: null, // Ключ для проверки изменения состава игроков
      wheelCards: [], // Карточки колеса для анимации
    };

    this.pollInterval = null;
    this.timerInterval = null; // Интервал для плавного обновления таймера
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
        
        // ВАЖНО: Устанавливаем флаг спина СРАЗУ если статус spinning
        // Это должно быть ДО обработки игроков!
        if (data.round.status === 'spinning' && !this.state.isSpinning) {
          console.log('[Roulette] Setting isSpinning = true BEFORE processing players');
          this.state.isSpinning = true;
        }
        
        // Update UI
        this.updateStatus(data.round.status);
        this.updatePot(parseFloat(data.round.pot_amount));
        
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
        
        // ВАЖНО: ВСЕГДА обновляем игроков (даже при spinning)
        // updatePlayers сам решит нужно ли перерисовывать колесо
        console.log('[Roulette] Updating players, count:', players.length, 'status:', data.round.status);
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
          
          // Найти имя победителя из ставок
          const winnerBet = data.bets.find(b => String(b.user_id) === String(data.round.winner_user_id));
          const winnerName = winnerBet ? winnerBet.display_name : 'Игрок';
          
          // Блокируем UI
          this.disableBetButton();
          this.updateStatus('spinning');
          
          // ВАЖНО: Сначала запускаем анимацию вращения
          console.log('[Roulette] Starting animation for winner:', data.round.winner_user_id);
          await this.spinWheelAnimation(data.round.winner_user_id);
          console.log('[Roulette] Animation completed via polling');
          
          // ТОЛЬКО ПОСЛЕ анимации показываем победителя
          this.showWinner(winnerName, parseFloat(data.round.winner_amount), data.round.winner_user_id);
          
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
          
          // Сбросить флаг спина
          this.state.isSpinning = false;
          this.enableBetButton();
        }
        
      } else {
        // No active round - это нормально после завершения
        this.state.currentRound = null;
        this.state.myBet = null;
        this.updateStatus('waiting');
        this.updatePot(0);
        
        // ВАЖНО: НЕ очищаем игроков если идет спин!
        if (!this.state.isSpinning) {
          this.updatePlayers([]);
        } else {
          console.log('[Roulette] NOT clearing players - spin in progress');
        }
        
        this.updateBetButton(false); // Не в раунде
        this.stopSmoothTimer();
        if (this.elements.timerWrap) {
          this.elements.timerWrap.classList.add('hidden');
        }
      }
      
      // Загружаем историю победителей
      await this.loadRecentWinners();
    } catch (error) {
      console.error('Failed to load active round:', error);
      // Не показываем toast если просто нет активного раунда
      if (!error.message || !error.message.includes('Нет активного раунда')) {
        this.showToast('Ошибка загрузки: ' + error.message);
      }
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
    console.log('[Roulette] updatePlayers called with', players.length, 'players');
    players.forEach((p, i) => {
      console.log(`  - Player ${i}: ${p.name}, chance=${p.chance}, id=${p.id}`);
    });
    
    // ВАЖНО: Всегда обновляем state.players (даже если идет спин)
    // Это нужно для корректного отображения списка игроков
    this.state.players = players;
    
    if (this.elements.playerCount) {
      this.elements.playerCount.textContent = players.length;
    }

    // Всегда обновляем список игроков
    this.renderPlayersList();
    
    // ВАЖНО: Рендерим колесо ТОЛЬКО если НЕ идет спин
    // Если спин идет - карточки уже отрисованы и не должны меняться
    if (!this.state.isSpinning) {
      this.renderWheel();
    } else {
      console.log('[Roulette] Skipping wheel render - spinning in progress, cards already rendered');
    }
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
    const playersKey = this.state.players.map(p => `${p.id}_${p.chance.toFixed(2)}`).join('|');
    if (this.state.lastPlayersKey === playersKey && this.elements.strip.children.length > 0) {
      console.log('[Roulette] Skipping wheel render - players unchanged');
      return;
    }
    this.state.lastPlayersKey = playersKey;

    console.log('[Roulette] Rendering wheel with', this.state.players.length, 'players');

    // НОВЫЙ ПОДХОД: Создаем карточки БЕЗ shuffle, просто чередуем игроков
    const cards = [];
    const totalCards = 100;
    
    // Вычисляем сколько карточек у каждого игрока
    const playerCards = this.state.players.map(p => ({
      player: p,
      count: Math.round(p.chance),
      colorIndex: this.getPlayerColorIndex(p.id) // Стабильный цвет для игрока
    }));
    
    console.log('[Roulette] Player cards:', playerCards.map(pc => `${pc.player.name}: ${pc.count} cards, color: ${pc.colorIndex}`));
    
    // Распределяем карточки РАВНОМЕРНО (round-robin)
    let cardIndex = 0;
    while (cardIndex < totalCards) {
      for (let i = 0; i < playerCards.length && cardIndex < totalCards; i++) {
        const pc = playerCards[i];
        if (pc.count > 0) {
          cards.push({
            player: pc.player,
            colorIndex: pc.colorIndex
          });
          pc.count--;
          cardIndex++;
        }
      }
    }
    
    console.log('[Roulette] Generated', cards.length, 'cards');
    
    // Сохраняем карточки в state для анимации
    this.state.wheelCards = cards;
    
    // Генерируем HTML
    const cardsHtml = cards.map((card, index) => {
      const colors = [
        'linear-gradient(135deg, #8CFFC1, #4DFF9A)',
        'linear-gradient(135deg, #fbbf24, #f59e0b)',
        'linear-gradient(135deg, #fb923c, #f97316)',
        'linear-gradient(135deg, #a78bfa, #8b5cf6)',
        'linear-gradient(135deg, #60a5fa, #3b82f6)',
      ];
      const color = colors[card.colorIndex % colors.length];
      
      // Аватар: фото или инициал
      const avatarContent = card.player.photoUrl 
        ? `<img src="${this.escapeHtml(card.player.photoUrl)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><div style="display:none; width:100%; height:100%; align-items:center; justify-content:center; font-weight:900; font-size:18px; color:#07110c;">${card.player.name.charAt(0).toUpperCase()}</div>`
        : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:18px; color:#07110c;">${card.player.name.charAt(0).toUpperCase()}</div>`;

      return `
        <div class="roulette-card" data-user-id="${card.player.id}" data-card-index="${index}" style="
          min-width:100px;
          width:100px;
          height:100%;
          background:${color};
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          padding:8px;
          border-right:2px solid rgba(0,0,0,0.3);
          flex-shrink:0;
        ">
          <div style="width:48px; height:48px; border-radius:50%; background:rgba(255,255,255,0.9); overflow:hidden; margin-bottom:6px; flex-shrink:0;">
            ${avatarContent}
          </div>
          <div style="font-size:11px; font-weight:800; color:rgba(0,0,0,0.8); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; text-align:center;">
            ${this.escapeHtml(card.player.name)}
          </div>
        </div>
      `;
    }).join('');
    
    this.elements.strip.innerHTML = cardsHtml;
    this.elements.strip.style.transform = 'translateX(0)';
    this.elements.strip.style.transition = 'none';
    
    console.log('[Roulette] ✅ Wheel rendered successfully with', cards.length, 'cards - LOCKED until spin ends');
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
  
  // Анимация вращения рулетки (как в CS:GO кейсах)
  spinWheelAnimation(winnerUserId) {
    return new Promise((resolve) => {
      if (!this.elements.strip || !this.elements.wheelContainer) {
        console.error('[Roulette] Missing elements for animation');
        resolve();
        return;
      }
      
      console.log('[Roulette] Starting animation for winner:', winnerUserId);
      
      // Находим все карточки победителя по data-user-id
      const allCards = Array.from(this.elements.strip.querySelectorAll('.roulette-card'));
      console.log('[Roulette] Total cards:', allCards.length);
      
      const winnerCards = allCards.filter(card => 
        String(card.getAttribute('data-user-id')) === String(winnerUserId)
      );
      
      console.log('[Roulette] Winner cards found:', winnerCards.length);
      
      if (winnerCards.length === 0) {
        console.error('[Roulette] No winner cards found for user:', winnerUserId);
        resolve();
        return;
      }
      
      // Выбираем случайную карточку победителя из середины-конца массива
      const targetIndex = Math.floor(winnerCards.length * 0.6 + Math.random() * winnerCards.length * 0.3);
      const targetCard = winnerCards[targetIndex];
      const targetCardIndex = allCards.indexOf(targetCard);
      
      console.log('[Roulette] Target card index:', targetCardIndex, 'of', allCards.length);
      
      // Рассчитываем позицию для остановки (карточка должна быть в центре)
      const containerWidth = this.elements.wheelContainer.offsetWidth;
      const cardWidth = 102; // 100px + 2px border
      const centerOffset = containerWidth / 2 - cardWidth / 2;
      
      // Добавляем случайное смещение для реалистичности (±20px)
      const randomOffset = (Math.random() - 0.5) * 40;
      
      // Финальная позиция
      const finalPosition = -(targetCardIndex * cardWidth) + centerOffset + randomOffset;
      
      // Добавляем дополнительные обороты для эффекта (4-6 полных прокруток)
      const extraSpins = (4 + Math.random() * 2) * allCards.length * cardWidth;
      const startPosition = finalPosition - extraSpins;
      
      console.log('[Roulette] Animation:', {
        startPosition,
        finalPosition,
        extraSpins,
        duration: 7000
      });
      
      // Сброс позиции
      this.elements.strip.style.transition = 'none';
      this.elements.strip.style.transform = `translateX(${startPosition}px)`;
      
      // Запуск анимации через небольшую задержку
      setTimeout(() => {
        // Анимация с easing как в CS:GO (быстро → медленно)
        const duration = 7000; // 7 секунд - УВЕЛИЧЕНО
        this.elements.strip.style.transition = `transform ${duration}ms cubic-bezier(0.17, 0.67, 0.12, 0.99)`;
        this.elements.strip.style.transform = `translateX(${finalPosition}px)`;
        
        console.log('[Roulette] Animation started');
        
        // Ждем окончания анимации + дополнительная задержка
        setTimeout(() => {
          console.log('[Roulette] Animation COMPLETED - resolving promise');
          resolve();
        }, duration + 800); // +800ms для гарантии что анимация точно закончилась и еще пол секунды
      }, 200); // Увеличена задержка перед стартом
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
      
      // Блокируем UI
      this.disableBetButton();
      this.updateStatus('spinning');
      
      // Вызываем API для получения победителя
      const data = await this.callAPI('spinRoulette');
      
      console.log('[Roulette] Winner from API:', data.winner);
      
      // ВАЖНО: Сначала запускаем анимацию вращения с победителем из API
      console.log('[Roulette] Starting animation...');
      await this.spinWheelAnimation(data.winner.user_id);
      console.log('[Roulette] Animation completed');
      
      // ТОЛЬКО ПОСЛЕ анимации показываем победителя
      this.showWinner(data.winner.display_name, data.winner.amount, data.winner.user_id);
      
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
      
      // Через 5 секунд загружаем новый раунд
      setTimeout(() => {
        this.state.isSpinning = false;
        this.enableBetButton();
        this.loadActiveRound();
      }, 5000);
      
    } catch (error) {
      console.error('[Roulette] Spin error:', error);
      this.state.isSpinning = false;
      
      // Если розыгрыш уже идет - НЕ показываем ошибку, просто ждем через polling
      if (error.message && (error.message.includes('уже идет') || error.message.includes('уже запущен') || error.message.includes('уже завершен'))) {
        console.log('[Roulette] Spin already in progress or finished, waiting via polling...');
        this.disableBetButton();
        // Polling автоматически обнаружит завершение раунда и покажет анимацию
      } else {
        // Другая ошибка - показываем
        this.showToast('Ошибка: ' + error.message);
        setTimeout(() => {
          this.enableBetButton();
          this.loadActiveRound();
        }, 2000);
      }
    }
  }

  showWinner(winnerName, amount, winnerUserId) {
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
      const photoUrl = winnerPlayer?.photoUrl;
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
  console.log('[Roulette] Script loaded - VERSION: 20260508-150300 - SORTED BY ID');
  
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
