import React from 'react';

// Экран выбора ставок перед матчмейкингом.
export const StakeSelectScreen = ({
  darkBg,
  safeFrameStyle,
  selectedStakeOptions,
  balanceTon,
  bottomNotice,
  onToggleStake,
  onStart,
  onBack,
}) => (
  <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none relative`} style={safeFrameStyle}>
    <div className="z-10 flex flex-col items-center gap-4 w-full max-w-xs px-4">
      <div className="text-6xl">⚽</div>
      <h1 className="text-3xl font-black text-white tracking-wide">ПЕНАЛЬТИ</h1>
      <p className="text-gray-400 text-sm text-center leading-relaxed">
        PvP: бей и лови! 5 ударов каждому, серия до промаха при ничьей.
      </p>
      <div className="w-full max-w-xs mx-auto mt-2">
        <p className="text-xs text-gray-400 mb-2 uppercase tracking-wider text-center">Выбери ставки TON</p>
        <div className="grid grid-cols-3 gap-2">
          {[0.1, 0.5, 1, 5, 10, 25].map((stake) => {
            const active = selectedStakeOptions.includes(stake);
            const blocked = Number(balanceTon || 0) < Number(stake);
            return (
              <button
                key={stake}
                type="button"
                onClick={() => onToggleStake(stake)}
                className={`aspect-square rounded-xl border text-sm font-black transition-all ${
                  blocked
                    ? 'bg-red-500/20 border-red-400 text-red-200'
                    : active
                      ? 'bg-emerald-500/25 border-emerald-300 text-emerald-200 shadow-[0_0_16px_rgba(16,185,129,0.35)]'
                      : 'bg-white/5 border-white/15 text-white/80 hover:bg-white/10'
                }`}
              >
                {stake} TON
              </button>
            );
          })}
        </div>
        <button onClick={onStart} className="w-full mt-3 bg-emerald-500 hover:bg-emerald-400 text-black font-black py-3 rounded-xl">
          Играть
        </button>
        <button onClick={onBack} className="w-full mt-2 bg-white/5 border border-white/15 text-white py-3 rounded-xl">
          Назад
        </button>
      </div>
      {!!bottomNotice && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[9999] bg-black/90 text-white text-sm font-bold px-4 py-2 rounded-xl">
          {bottomNotice}
        </div>
      )}
    </div>
  </div>
);
