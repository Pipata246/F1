// Obstacle Race - Минимальная рабочая версия
console.log('Obstacle Race loading...');

// Основные переменные
let selectedStakeOptions = [];
let balanceTon = 0;
let myName = 'Игрок';
let tgInitData = '';

const $ = (id) => document.getElementById(id);

function debugLog(msg) {
    const debug = $('debug-info');
    if (debug) {
        debug.innerHTML += '<br>' + msg;
    }
    console.log(msg);
}

function showScreen(name) {
    debugLog('Показываем экран: ' + name);
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = $('screen-' + name);
    if (screen) {
        screen.classList.add('active');
        debugLog('Экран активирован: ' + name);
    } else {
        debugLog('ОШИБКА: Экран не найден: screen-' + name);
    }
}

function initStakeGrid() {
    const grid = $('stakeGridObstacle');
    if (!grid) {
        debugLog('ОШИБКА: stakeGridObstacle не найден');
        return;
    }
    
    const stakes = [0.1, 0.5, 1, 5, 10, 25];
    grid.innerHTML = '';
    
    stakes.forEach(stake => {
        const btn = document.createElement('button');
        btn.className = 'btn ghost';
        btn.textContent = stake + ' TON';
        btn.style.cssText = `
            height: 74px;
            padding: 0 6px;
            font-weight: 900;
            font-size: 13px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 14px;
            border: 2px solid rgba(255,255,255,0.18);
            background: rgba(255,255,255,0.08);
            color: #fff;
            cursor: pointer;
            transition: all 0.2s;
        `;
        
        btn.onclick = () => {
            const idx = selectedStakeOptions.indexOf(stake);
            if (idx >= 0) {
                selectedStakeOptions.splice(idx, 1);
                btn.style.borderColor = 'rgba(255,255,255,0.18)';
                btn.style.background = 'rgba(255,255,255,0.08)';
                btn.style.color = '#fff';
            } else {
                selectedStakeOptions.push(stake);
                btn.style.borderColor = '#8fd1ff';
                btn.style.background = 'rgba(59,130,246,0.25)';
                btn.style.color = '#e6f3ff';
            }
            debugLog('Выбранные ставки: ' + selectedStakeOptions.join(', '));
        };
        
        grid.appendChild(btn);
    });
    
    debugLog('Сетка ставок создана');
}

function initButtons() {
    // Кнопка "Играть" на экране ставок
    const playBtn = $('stakePlayBtnObstacle');
    if (playBtn) {
        playBtn.onclick = () => {
            if (selectedStakeOptions.length === 0) {
                alert('Выбери хотя бы одну ставку');
                return;
            }
            debugLog('Начинаем PvP игру со ставками: ' + selectedStakeOptions.join(', '));
            showScreen('waiting');
        };
        debugLog('Кнопка "Играть" настроена');
    } else {
        debugLog('ОШИБКА: stakePlayBtnObstacle не найдена');
    }
    
    // Кнопка "Играть с ботом" на экране ставок
    const botBtn = $('btn-bot');
    if (botBtn) {
        botBtn.onclick = () => {
            debugLog('Переход к демо экрану');
            showScreen('demo');
        };
        debugLog('Кнопка "Играть с ботом" настроена');
    } else {
        debugLog('ОШИБКА: btn-bot не найдена');
    }
    
    // Кнопка "Играть" на демо экране
    const demoPlayBtn = $('btn-demo-play');
    if (demoPlayBtn) {
        demoPlayBtn.onclick = () => {
            debugLog('Начинаем демо игру');
            alert('Демо игра пока не реализована');
        };
        debugLog('Кнопка демо "Играть" настроена');
    } else {
        debugLog('ОШИБКА: btn-demo-play не найдена');
    }
    
    // Кнопка "Назад" на демо экране
    const demoBackBtn = $('btn-demo-back');
    if (demoBackBtn) {
        demoBackBtn.onclick = () => {
            debugLog('Возврат к главному меню');
            window.location.href = '/';
        };
        debugLog('Кнопка демо "Назад" настроена');
    } else {
        debugLog('ОШИБКА: btn-demo-back не найдена');
    }
}

// Инициализация при загрузке DOM
document.addEventListener('DOMContentLoaded', () => {
    debugLog('DOM загружен');
    
    try {
        // Проверяем экраны
        const screens = document.querySelectorAll('.screen');
        debugLog('Найдено экранов: ' + screens.length);
        screens.forEach((s, i) => {
            debugLog('Экран ' + i + ': ' + s.id);
        });
        
        // Инициализируем Telegram WebApp
        if (window.Telegram && window.Telegram.WebApp) {
            const tg = window.Telegram.WebApp;
            tg.ready();
            tg.expand();
            const user = tg.initDataUnsafe && tg.initDataUnsafe.user;
            if (user && user.first_name) {
                myName = user.first_name;
            }
            tgInitData = tg.initData || '';
            debugLog('Telegram WebApp инициализирован');
        }
        
        // Инициализируем элементы
        initStakeGrid();
        initButtons();
        
        // Определяем какой экран показать на основе URL
        const urlParams = new URLSearchParams(window.location.search);
        const launchMode = urlParams.get('launch');
        
        debugLog('Launch mode: ' + launchMode);
        
        if (launchMode === 'demo') {
            debugLog('Показываем демо экран');
            showScreen('demo');
        } else {
            debugLog('Показываем экран выбора ставки');
            showScreen('start');
        }
        
        debugLog('Инициализация завершена успешно');
        
    } catch (error) {
        debugLog('ОШИБКА инициализации: ' + error.message);
        console.error('Initialization error:', error);
    }
    
    // Скрываем отладку через 15 секунд
    setTimeout(() => {
        const debug = $('debug-info');
        if (debug) debug.style.display = 'none';
    }, 15000);
});

debugLog('Скрипт загружен');