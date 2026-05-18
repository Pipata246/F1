import React from 'react';

// Экран поиска соперника + accept-модалка с обратным отсчётом.
export const WaitingScreen = ({
  darkBg,
  safeFrameStyle,
  selectedStakeOptions,
  acceptInfo,
  acceptTick,
  onCancel,
}) => {
  const leftSec = Math.max(0, Math.ceil((Number(acceptInfo?.deadlineMs || 0) - Date.now()) / 1000)) + (acceptTick * 0);
  return (
    <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none`} style={safeFrameStyle}>
      <div className="z-10 flex flex-col items-center gap-6">
        <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-white text-xl font-bold">Ищем соперника...</p>
        {!!selectedStakeOptions.length && (
          <p className="text-gray-400 text-sm">Ставки: {selectedStakeOptions.join(', ')} TON</p>
        )}
        <button onClick={onCancel} className="text-gray-400 hover:text-white text-sm mt-4 px-6 py-2 border border-white/10 rounded-lg transition-colors">
          Отмена
        </button>
      </div>
      {!!acceptInfo && (
        <div className="fixed inset-0 z-[999] bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-gradient-to-b from-[#1f6a37] to-[#1a3f2a] border border-emerald-200/35 rounded-2xl p-5 text-center shadow-2xl">
            <p className="text-white text-lg font-black">Матч найден</p>
            <p className="text-gray-100 text-sm mt-2">{acceptInfo.p1} vs {acceptInfo.p2}</p>
            {acceptInfo.stake != null && <p className="text-lime-200 text-sm mt-1">Ставка: {acceptInfo.stake} TON</p>}
            <p className={`text-3xl font-black mt-2 ${leftSec <= 3 ? 'text-rose-200' : 'text-lime-200'}`}>{leftSec}с</p>
            <p className="mt-3 text-xs text-lime-100/90">Игра начнется автоматически</p>
          </div>
        </div>
      )}
    </div>
  );
};
