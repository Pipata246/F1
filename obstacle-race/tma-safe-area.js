export function applyTelegramSafeArea() {
  const tg = window.Telegram?.WebApp;
  const root = document.documentElement;
  const sa = tg?.safeAreaInset || {};
  const cs = tg?.contentSafeAreaInset || {};
  let top = Math.max(readInsetNum(sa.top), readInsetNum(cs.top));
  let bottom = Math.max(readInsetNum(sa.bottom), readInsetNum(cs.bottom));
  const css = getComputedStyle(root);
  top = Math.max(top, parseFloat(css.getPropertyValue('--tg-content-safe-area-inset-top')) || 0);
  top = Math.max(top, parseFloat(css.getPropertyValue('--tg-safe-area-inset-top')) || 0);
  bottom = Math.max(bottom, parseFloat(css.getPropertyValue('--tg-content-safe-area-inset-bottom')) || 0);
  bottom = Math.max(bottom, parseFloat(css.getPropertyValue('--tg-safe-area-inset-bottom')) || 0);
  if (tg) {
    const p = String(tg.platform || '').toLowerCase();
    const minTop = p === 'ios' ? 92 : p === 'android' ? 72 : 0;
    if (minTop > 0) top = Math.max(top, minTop);
  }
  root.style.setProperty('--tg-header-offset', `${Math.ceil(top)}px`);
  if (bottom > 0) root.style.setProperty('--tg-header-offset-bottom', `${Math.ceil(bottom)}px`);
}

function readInsetNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function applyViewport() {
  try {
    applyTelegramSafeArea();
    const tg = window.Telegram?.WebApp;
    if (tg?.viewportStableHeight) {
      document.documentElement.style.setProperty('--app-vh', `${tg.viewportStableHeight}px`);
    } else {
      document.documentElement.style.setProperty('--app-vh', `${window.innerHeight}px`);
    }
  } catch {
    document.documentElement.style.setProperty('--app-vh', `${window.innerHeight}px`);
  }
}

export function initTmaSafeArea() {
  const tg = window.Telegram?.WebApp;
  try {
    tg?.ready();
    tg?.expand();
    tg?.requestFullscreen?.();
    tg?.disableVerticalSwipes?.();
    applyViewport();
    setTimeout(applyViewport, 80);
    setTimeout(applyViewport, 350);
    tg?.onEvent?.('viewportChanged', applyViewport);
    tg?.onEvent?.('safeAreaChanged', applyViewport);
    tg?.onEvent?.('contentSafeAreaChanged', applyViewport);
    window.addEventListener('resize', applyViewport);
  } catch {
    applyViewport();
  }
}

initTmaSafeArea();
