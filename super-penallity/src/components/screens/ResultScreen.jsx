import React from 'react';
import { motion } from 'framer-motion';
import { KickDots } from '../KickDots.jsx';

// Экран результата матча: победа/поражение, счёт, точки ударов, действия.
export const ResultScreen = ({
  darkBg,
  safeFrameStyle,
  matchResult,
  playerIndex,
  displayName,
  opponent,
  history,
  suddenDeath,
  suddenDeathStartRound,
  currentStakeTon,
  playMode,
  onExit,
  onPlayAgain,
}) => {
  const tonStake = Number(currentStakeTon || 0);
  const hasTonStake = playMode !== 'bot' && Number.isFinite(tonStake) && tonStake > 0;
  const tonResultText = hasTonStake
    ? (matchResult.youWon
        ? `TON итог: +${(tonStake * 2).toFixed(9).replace(/\.?0+$/, '')} TON`
        : `TON итог: -${tonStake.toFixed(9).replace(/\.?0+$/, '')} TON`)
    : null;

  return (
    <div className={`h-screen ${darkBg} flex flex-col items-center justify-center overflow-hidden font-sans select-none`} style={safeFrameStyle}>
      <div className="z-10 flex flex-col items-center gap-6">
        {matchResult.opponentLeft ? (
          <>
            <h1 className="text-4xl font-black text-yellow-400">Соперник вышел</h1>
            <p className="text-gray-400">Победа засчитана!</p>
          </>
        ) : matchResult.youWon ? (
          <motion.h1
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-b from-[#4aff93] to-[#00b548]"
          >
            ПОБЕДА!
          </motion.h1>
        ) : (
          <motion.h1
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-b from-[#ff6b6b] to-[#c90000]"
          >
            ПОРАЖЕНИЕ
          </motion.h1>
        )}

        <div className="flex items-center gap-8 mt-4">
          <div className="text-center">
            <p className="text-blue-400 text-sm font-bold">{displayName || 'Ты'}</p>
            <p className="text-4xl font-black text-blue-400">{matchResult.scores[playerIndex]}</p>
          </div>
          <p className="text-2xl text-gray-600 font-bold">:</p>
          <div className="text-center">
            <p className="text-red-400 text-sm font-bold">{opponent}</p>
            <p className="text-4xl font-black text-red-400">{matchResult.scores[1 - playerIndex]}</p>
          </div>
        </div>
        {tonResultText && (
          <div className={`text-sm font-black ${matchResult.youWon ? 'text-emerald-300' : 'text-rose-300'}`}>
            {tonResultText}
          </div>
        )}

        <div className="flex flex-col items-center gap-2 mt-4 bg-white/5 p-3 rounded-xl border border-white/10">
          <KickDots
            history={history}
            playerIdx={playerIndex}
            totalKicks={suddenDeath ? 1 : 5}
            label={displayName || 'Ты'}
            color="text-blue-400"
            suddenDeath={suddenDeath}
            suddenDeathStartRound={suddenDeathStartRound}
          />
          <KickDots
            history={history}
            playerIdx={1 - playerIndex}
            totalKicks={suddenDeath ? 1 : 5}
            label={opponent}
            color="text-red-400"
            suddenDeath={suddenDeath}
            suddenDeathStartRound={suddenDeathStartRound}
          />
        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={onExit}
            className="bg-white/5 border border-white/20 text-white font-bold py-4 px-8 rounded-xl text-lg transition-all active:scale-95"
          >
            Выйти
          </button>
          <button
            onClick={onPlayAgain}
            className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-bold py-4 px-8 rounded-xl text-lg transition-all active:scale-95 shadow-lg shadow-blue-500/20"
          >
            Ещё раз
          </button>
        </div>
      </div>
    </div>
  );
};
