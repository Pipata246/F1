import React, { memo } from 'react';
import { zoneTargetCenters } from '../lib/zonePositions.js';

// Подсветка мишеней для kicker (yellow) и keeper (emerald).
// displayedZone — из confirmedZone (от сервера) или pending selectedZone.
// Невыбранные мишени остаются тусклыми, выбранная — крупная, яркая, animate-pulse.
export const TargetZones = memo(({ role, displayedZone, visible }) => {
  if (!visible) return null;

  const isKicker = role === 'kicker';
  const palette = isKicker
    ? {
        outerSelected: 'w-16 h-16 border-[4px] border-yellow-300 bg-yellow-400/35 animate-pulse shadow-[0_0_28px_rgba(253,224,71,1)]',
        outerIdle: 'w-14 h-14 border-[3px] border-yellow-400 bg-yellow-400/20 shadow-[0_0_14px_rgba(253,224,71,0.7)]',
        innerSelected: 'w-3.5 h-3.5 bg-yellow-200',
        innerIdle: 'w-2.5 h-2.5 bg-yellow-300',
      }
    : {
        outerSelected: 'w-16 h-16 border-[4px] border-emerald-300 bg-emerald-400/35 animate-pulse shadow-[0_0_28px_rgba(52,211,153,1)]',
        outerIdle: 'w-14 h-14 border-[3px] border-emerald-400 bg-emerald-400/18 shadow-[0_0_14px_rgba(52,211,153,0.7)]',
        innerSelected: 'w-3.5 h-3.5 bg-emerald-200',
        innerIdle: 'w-2.5 h-2.5 bg-emerald-300',
      };

  return (
    <div className="absolute inset-0 z-40 pointer-events-none">
      {[0, 1, 2, 3].map((zone) => {
        const isSelected = displayedZone === zone;
        const c = zoneTargetCenters[zone];
        return (
          <div
            key={zone}
            className="absolute"
            style={{ left: `${c.left}px`, top: `${c.top}px`, transform: 'translate(-50%, -50%)' }}
          >
            <div className={`relative flex items-center justify-center rounded-full transition-all duration-200 ${isSelected ? palette.outerSelected : palette.outerIdle}`}>
              <div className={`rounded-full ${isSelected ? palette.innerSelected : palette.innerIdle}`} />
            </div>
          </div>
        );
      })}
    </div>
  );
});
