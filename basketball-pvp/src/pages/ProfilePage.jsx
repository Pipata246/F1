import React, { useState, useEffect } from 'react';

const ProfilePage = () => {
  const [stats, setStats] = useState(null);
  const tgUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || 'anon';
  const name = window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name || 'Player';

  useEffect(() => {
    fetch(`/api/stats/${tgUserId}`)
      .then(r => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

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
      <button onClick={() => { window.location.href = '/'; }} className="mt-8 text-gray-400 hover:text-white text-sm transition-colors">
        Назад
      </button>
    </div>
  );
};

export default ProfilePage;
