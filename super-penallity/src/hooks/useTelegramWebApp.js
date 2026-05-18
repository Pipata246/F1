import { useEffect, useRef } from 'react';

// Инкапсулирует всю работу с Telegram WebApp:
//  - инициализация initData (ref'ом для синхронного доступа),
//  - скрытие BackButton и disableClosingConfirmation,
//  - получение displayName/balance через authSession,
//  - presence heartbeat (раз в 9 сек + при возвращении фокуса/visibility),
//  - presenceLeave на pagehide.
//
// Возвращает initDataRef — синхронная ссылка на текущее initData, используется по всему
// приложению (submit'ы, polling, leave-room и т.д.) без зависимости от React-рендера.
export function useTelegramWebApp({ onDisplayName, onBalance }) {
  const initDataRef = useRef('');

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    initDataRef.current = tg?.initData || '';

    if (tg?.BackButton) tg.BackButton.hide();
    if (tg) tg.disableClosingConfirmation();

    const u = tg?.initDataUnsafe?.user;
    const fallback = u?.first_name || 'Player';
    const init = initDataRef.current;
    if (!init) {
      onDisplayName?.(fallback);
      return;
    }
    fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'authSession', initData: init }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data?.ok && data.user?.display_name) {
          onDisplayName?.(String(data.user.display_name).slice(0, 64));
          onBalance?.(Number(data.user.balance || 0));
        } else {
          onDisplayName?.(fallback);
          onBalance?.(0);
        }
      })
      .catch(() => {
        onDisplayName?.(fallback);
        onBalance?.(0);
      });
  // mount-only: callbacks могут пересоздаваться, но логика должна запускаться раз
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Presence heartbeat: раз в 9 сек, плюс при visibility/focus.
  useEffect(() => {
    const ping = () => {
      const init = initDataRef.current;
      if (!init) return;
      fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'presenceHeartbeat', initData: init }),
      }).catch(() => {});
    };
    ping();
    const id = setInterval(ping, 9000);
    const onVis = () => { if (document.visibilityState === 'visible') ping(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', ping);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', ping);
    };
  }, []);

  // Presence leave на pagehide + при unmount.
  useEffect(() => {
    const leave = () => {
      const init = initDataRef.current;
      if (!init) return;
      const payload = JSON.stringify({ action: 'presenceLeave', initData: init });
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/user', new Blob([payload], { type: 'application/json' }));
        }
      } catch {}
      fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, []);

  return initDataRef;
}
