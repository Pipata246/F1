// Obstacle Race - правильная логика экранов
console.log('Obstacle Race JS loaded');

let selectedStakeOptions = [];
let balanceTon = 0;
let myName = 'Игрок';

const $ = (id) => document.getElementById(id);

function showScreen(name) {
    console.log('Показываем экран:', name);
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = $('screen-' + name);
    if (screen) {
        screen.classList.add('active');
        console.log('Экран активирован:', name);
    } else {
        console.error('Экран не найден:', 'screen-' + name);
    }
}

function debugLog(msg) {
    const debug = $('debug-info');
    if (debug) {
        debug.innerHTML += '<br>' + msg;
    }
    console.log(msg);
}

function initStakeGrid() {
    const grid = $('stakeGridObstacle');
    if (!grid) {
        debugLog('ERROR: stakeGridObstacle не найден');
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
            // Здесь будет логика поиска игры
            showScreen('waiting');
        };
        debugLog('Кнопка "Играть" настроена');
    }
    
    // Кнопка "Играть с ботом" на экране ставок
    const botBtn = $('btn-bot');
    if (botBtn) {
        botBtn.onclick = () => {
            debugLog('Переход к демо экрану');
            showScreen('demo');
        };
        debugLog('Кнопка "Играть с ботом" настроена');
    }
    
    // Кнопка "Играть" на демо экране
    const demoPlayBtn = $('btn-demo-play');
    if (demoPlayBtn) {
        demoPlayBtn.onclick = () => {
            debugLog('Начинаем демо игру');
            // Здесь будет логика игры с ботом
            alert('Демо игра пока не реализована');
        };
        debugLog('Кнопка демо "Играть" настроена');
    }
    
    // Кнопка "Назад" на демо экране
    const demoBackBtn = $('btn-demo-back');
    if (demoBackBtn) {
        demoBackBtn.onclick = () => {
            debugLog('Возврат к главному меню');
            window.location.href = '/';
        };
        debugLog('Кнопка демо "Назад" настроена');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    debugLog('DOM загружен');
    
    // Проверяем экраны
    const screens = document.querySelectorAll('.screen');
    debugLog('Найдено экранов: ' + screens.length);
    screens.forEach((s, i) => {
        debugLog('Экран ' + i + ': ' + s.id);
    });
    
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
    
    // Скрываем отладку через 10 секунд
    setTimeout(() => {
        const debug = $('debug-info');
        if (debug) debug.style.display = 'none';
    }, 10000);
});