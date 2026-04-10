import React, { useEffect, useState } from 'react';

const ProfilePage = () => {
  const [stats, setStats] = useState({ wins: 0, losses: 0, goals: 0, saves: 0 });
  const [name, setName] = useState('Игрок');

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    const user = tg?.initDataUnsafe?.user;
    const initData = tg?.initData || '';
    if (user) {
      setName(user.first_name || 'Игрок');
    }
    if (!initData) return;
    fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getGameStats', initData }),
    })
      .then(r => r.json())
      .then((data) => {
        const s = data?.stats?.super_penalty || {};
        setStats({
          wins: s.wins || 0,
          losses: s.losses || 0,
          goals: s.points_for || 0,
          saves: s.points_against || 0,
        });
      })
      .catch(() => {});
  }, []);

  const total = stats.wins + stats.losses;
  const winRate = total > 0 ? Math.round((stats.wins / total) * 100) : 0;

  return (
    <div className="h-screen bg-[#121214] flex flex-col items-center justify-center p-4 select-none">
      <div className="w-20 h-20 bg-gray-700 rounded-full mb-4 flex items-center justify-center text-3xl">
        ⚽
      </div>
      <h2 className="text-2xl font-bold text-white">{name}</h2>

      <div className="mt-6 grid grid-cols-2 gap-3 w-full max-w-xs">
        <div className="bg-white/5 border border-white/10 p-4 rounded-xl text-center">
          <p className="text-gray-400 text-xs uppercase">Победы</p>
          <p className="text-3xl font-black text-green-500">{stats.wins}</p>
        </div>
        <div className="bg-white/5 border border-white/10 p-4 rounded-xl text-center">
          <p className="text-gray-400 text-xs uppercase">Поражения</p>
          <p className="text-3xl font-black text-red-500">{stats.losses}</p>
        </div>
        <div className="bg-white/5 border border-white/10 p-4 rounded-xl text-center">
          <p className="text-gray-400 text-xs uppercase">Голы</p>
          <p className="text-3xl font-black text-yellow-400">{stats.goals}</p>
        </div>
        <div className="bg-white/5 border border-white/10 p-4 rounded-xl text-center">
          <p className="text-gray-400 text-xs uppercase">Сейвы</p>
          <p className="text-3xl font-black text-blue-400">{stats.saves}</p>
        </div>
      </div>

      {total > 0 && (
        <div className="mt-4 bg-white/5 border border-white/10 p-4 rounded-xl w-full max-w-xs text-center">
          <p className="text-gray-400 text-xs uppercase">Винрейт</p>
          <p className="text-3xl font-black text-white">{winRate}%</p>
        </div>
      )}

      <button
        onClick={() => { window.location.hash = '#/'; }}
        className="mt-8 text-gray-400 hover:text-white text-sm px-6 py-2 border border-white/10 rounded-lg transition-colors"
      >
        ← Назад к игре
      </button>
    </div>
  );
};

export default ProfilePage;
