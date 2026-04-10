import React, { useState, useEffect } from 'react';

const ProfilePage = () => {
  const [stats, setStats] = useState(null);
  const tgInitData = window.Telegram?.WebApp?.initData || '';
  const name = window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name || 'Player';

  useEffect(() => {
    if (!tgInitData) return;
    fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getGameStats', initData: tgInitData }),
    })
      .then(r => r.json())
      .then((data) => {
        const s = data?.stats?.basketball || {};
        setStats({
          wins: s.wins || 0,
          losses: s.losses || 0,
          totalPoints: s.points_for || 0,
          gamesPlayed: s.games_played || 0,
        });
      })
      .catch(() => {});
  }, [tgInitData]);

  return (
    <div className="h-screen bg-[#121214] flex flex-col items-center justify-center font-sans select-none px-4">
      <h1 className="text-2xl font-black text-white mb-6">{name}</h1>
      {stats ? (
        <div className="grid grid-cols-2 gap-4 w-full max-w-xs">
          <div className="bg-white/5 rounded-xl p-4 text-center border border-white/10">
            <p className="text-2xl font-black text-green-400">{stats.wins}</p>
            <p className="text-xs text-gray-400">Победы</p>
          </div>
          <div className="bg-white/5 rounded-xl p-4 text-center border border-white/10">
            <p className="text-2xl font-black text-red-400">{stats.losses}</p>
            <p className="text-xs text-gray-400">Поражения</p>
          </div>
          <div className="bg-white/5 rounded-xl p-4 text-center border border-white/10">
            <p className="text-2xl font-black text-yellow-400">{stats.totalPoints}</p>
            <p className="text-xs text-gray-400">Очки</p>
          </div>
          <div className="bg-white/5 rounded-xl p-4 text-center border border-white/10">
            <p className="text-2xl font-black text-blue-400">{stats.gamesPlayed}</p>
            <p className="text-xs text-gray-400">Игры</p>
          </div>
        </div>
      ) : (
        <p className="text-gray-500">Загрузка...</p>
      )}
      <button onClick={() => { window.location.hash = '#/'; }} className="mt-8 text-gray-400 hover:text-white text-sm transition-colors">
        Назад
      </button>
    </div>
  );
};

export default ProfilePage;
