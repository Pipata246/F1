import React, { memo } from 'react';

// Мяч в стартовой позиции с inline transform для полёта в зону удара.
export const Ball = memo(({ assetBase, visible, style }) => (
  <div className="absolute bottom-[-40px] left-1/2 -translate-x-1/2 z-20 pointer-events-none" style={{ willChange: 'transform' }}>
    {visible && (
      <img
        src={`${assetBase}ball.png`}
        alt="Ball"
        className="w-[70px] h-[70px] drop-shadow-[0_10px_20px_rgba(0,0,0,0.6)]"
        style={{ ...style, willChange: 'transform' }}
      />
    )}
  </div>
));
