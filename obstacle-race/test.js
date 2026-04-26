// Простой тест JavaScript
console.log('Test JS loaded');

document.addEventListener('DOMContentLoaded', () => {
    console.log('Test DOM loaded');
    
    const debug = document.getElementById('debug-info');
    if (debug) {
        debug.innerHTML = 'Test JS работает!<br>DOM загружен<br>Экраны: ' + document.querySelectorAll('.screen').length;
    }
    
    // Показываем первый экран
    setTimeout(() => {
        const screens = document.querySelectorAll('.screen');
        if (screens.length > 0) {
            screens.forEach(s => s.classList.remove('active'));
            screens[0].classList.add('active');
            debug.innerHTML += '<br>Показан первый экран: ' + screens[0].id;
        }
    }, 1000);
});