import React, { memo } from 'react';

// Точки ударов игрока: зелёные забитые, красные мимо.
// В овертайме показывает только удары текущего цикла (2 удара = 1 цикл).
export const KickDots = memo(({ history, playerIdx, totalKicks = 5, label, color, suddenDeath, suddenDeathStartRound }) => {
  const allKicks = history.filter(h => h.kickerIndex === playerIdx);

  let kicks;
  if (suddenDeath) {
    const overtimeKicks = allKicks.filter((k) => {
      const fullHistoryIdx = history.indexOf(k);
      return fullHistoryIdx >= suddenDeathStartRound;
    });

    const cycleSize = 2;
    const totalOvertimeRounds = history.length - suddenDeathStartRound;
    const completedCycles = Math.floor(totalOvertimeRounds / cycleSize);

    let currentCycleStart = suddenDeathStartRound;
    for (let cycle = 0; cycle < completedCycles; cycle++) {
      const cycleEnd = suddenDeathStartRound + (cycle + 1) * cycleSize;
      const cycleHistory = history.slice(currentCycleStart, cycleEnd);
      const p1Goals = cycleHistory.filter(h => h.kickerIndex === 0 && h.isGoal).length;
      const p2Goals = cycleHistory.filter(h => h.kickerIndex === 1 && h.isGoal).length;
      if (p1Goals !== p2Goals) break;
      currentCycleStart = cycleEnd;
    }

    const currentCycleKicks = overtimeKicks.filter((k) => {
      const fullHistoryIdx = history.indexOf(k);
      return fullHistoryIdx >= currentCycleStart;
    });
    kicks = currentCycleKicks.slice(-totalKicks);
  } else {
    kicks = allKicks.slice(0, totalKicks);
  }

  return (
    <div className="flex items-center justify-center gap-2">
      <span className={`text-[10px] font-bold truncate w-14 text-right ${color}`}>{label}</span>
      <div className="flex gap-1">
        {Array.from({ length: totalKicks }).map((_, i) => {
          const k = kicks[i];
          if (!k) return <div key={i} className="w-4 h-4 rounded-full border-2 border-white/20" />;
          return (
            <div key={i} className={`w-4 h-4 rounded-full border-2 ${
              k.isGoal ? 'bg-green-500 border-green-400' : 'bg-red-500 border-red-400'
            }`} />
          );
        })}
      </div>
    </div>
  );
});
