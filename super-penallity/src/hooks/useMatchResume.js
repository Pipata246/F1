import { useEffect } from 'react';

const STORAGE_KEY = 'sp_active_room';

// Инкапсулирует resume-after-refresh логику и сохранение roomId в sessionStorage.
//  - mount: читает sessionStorage и пытается восстановить активный матч через серверный
//    endpoint pvpGetMyActiveRoom. Если успешно — зовёт onResume(room) для применения.
//  - screen-change: сохраняет roomId при входе в 'game', удаляет при 'result'/'stake-online'/'menu'.
//  - pagehide: отменяет очередь матчмейкинга если игрок ещё не в активном матче. В матче не
//    отправляет leave — сервер сам решит по stale presence через 45с.
export function useMatchResume({
  screen,
  initDataRef,
  pvpRoomIdRef,
  playModeRef,
  onResume,
}) {
  // Mount: попытка восстановления активного матча.
  useEffect(() => {
    const stored = (() => {
      try { return sessionStorage.getItem(STORAGE_KEY); } catch { return null; }
    })();
    if (!stored) return;
    const storedRoomId = Number(stored);
    if (!Number.isInteger(storedRoomId) || storedRoomId <= 0) {
      try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
      return;
    }
    const tryReconnect = () => {
      const init = initDataRef.current;
      if (!init) {
        setTimeout(tryReconnect, 200);
        return;
      }
      fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pvpGetMyActiveRoom', initData: init, gameKey: 'super_penalty' }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (!data?.ok || !data.room || Number(data.room.id) !== storedRoomId) {
            try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
            return;
          }
          onResume?.(data.room);
        })
        .catch(() => { try { sessionStorage.removeItem(STORAGE_KEY); } catch {} });
    };
    tryReconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Сохранение/очистка roomId по экрану.
  useEffect(() => {
    if (playModeRef.current === 'pvp' && pvpRoomIdRef.current && screen === 'game') {
      try { sessionStorage.setItem(STORAGE_KEY, String(pvpRoomIdRef.current)); } catch {}
    } else if (screen === 'result' || screen === 'stake-online' || screen === 'menu') {
      try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // pagehide: отмена очереди только когда не в активной игре. В матче — НЕ leave.
  useEffect(() => {
    const onPageHide = () => {
      if (playModeRef.current !== 'pvp') return;
      const init = initDataRef.current;
      const rid = pvpRoomIdRef.current;
      if (!init || !rid) return;
      if (screen !== 'game') {
        const payload = JSON.stringify({ action: 'pvpCancelQueue', initData: init, roomId: rid });
        try {
          if (navigator.sendBeacon) navigator.sendBeacon('/api/user', new Blob([payload], { type: 'application/json' }));
        } catch {}
        fetch('/api/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);
}
