import React, { memo } from 'react';

// Контейнер вратаря с translate3d + img со спрайтом.
// transitionDisabled позволяет мгновенно сбросить позицию без обратной анимации между раундами.
export const Keeper = memo(({
  assetBase,
  role,
  keeperState,
  keeperX,
  keeperBottom,
  isKeeperMirrored,
  transitionDisabled,
}) => {
  const isKickerView = role !== 'keeper';
  const idleSrc = isKickerView ? `${assetBase}keeper_green.png` : `${assetBase}keeper_idle.png`;
  const saveSrc = isKickerView ? `${assetBase}keeper_red.png` : `${assetBase}keeper_save.png`;
  const src = keeperState === 'save' ? saveSrc : idleSrc;
  const saveH = isKickerView ? '122px' : '100px';
  const idleH = isKickerView ? '170px' : '140px';

  return (
    <div
      className="absolute left-0 right-0 flex items-end justify-center z-10 pointer-events-none"
      style={{
        bottom: 0,
        height: '200px',
        transform: `translate3d(${keeperX}px, ${keeperState === 'idle' ? -16 : -Number(keeperBottom)}px, 0)`,
        transition: transitionDisabled ? 'none' : 'transform 0.45s cubic-bezier(0.22, 0.61, 0.36, 1)',
        willChange: 'transform',
      }}
    >
      <img
        src={src}
        alt="Keeper"
        className="object-contain drop-shadow-2xl"
        loading="eager"
        decoding="sync"
        onError={(e) => {
          if (e.currentTarget.dataset.fallback === '1') return;
          e.currentTarget.dataset.fallback = '1';
          e.currentTarget.src = `${assetBase}keeper_idle.png`;
        }}
        style={{
          height: keeperState === 'save' ? saveH : idleH,
          transform: isKeeperMirrored ? 'scaleX(-1)' : 'scaleX(1)',
          objectPosition: 'center bottom',
          transition: transitionDisabled
            ? 'none'
            : 'transform 0.3s cubic-bezier(0.22, 0.61, 0.36, 1), height 0.45s cubic-bezier(0.22, 0.61, 0.36, 1)',
          willChange: 'transform, height',
        }}
      />
    </div>
  );
});
