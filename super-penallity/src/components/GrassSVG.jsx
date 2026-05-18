import React, { memo } from 'react';

// 4 слоя травы спереди ворот. Memo чтобы не пересчитывать pathы на каждом рендере.
export const GrassSVG = memo(() => (
  <svg className="absolute bottom-0 left-0 w-full h-36 z-[1] pointer-events-none" viewBox="0 0 400 120" preserveAspectRatio="none">
    <g fill="#145a2a" opacity="0.9">
      {Array.from({ length: 25 }).map((_, i) => {
        const x = i * 16 + Math.sin(i * 1.7) * 3;
        const h = 40 + Math.sin(i * 0.5) * 18;
        const lean = Math.sin(i * 0.8) * 8;
        return <path key={`a${i}`} d={`M${x},120 Q${x + lean},${120 - h * 0.6} ${x + lean * 0.6},${120 - h} Q${x + lean * 0.3},${120 - h * 0.6} ${x + 5},120`} />;
      })}
    </g>
    <g fill="#1a6b35" opacity="0.85">
      {Array.from({ length: 30 }).map((_, i) => {
        const x = i * 13.3 + 2 + Math.cos(i * 1.3) * 4;
        const h = 32 + Math.cos(i * 0.7) * 14;
        const lean = Math.cos(i * 1.1) * 7;
        return <path key={`b${i}`} d={`M${x},120 Q${x + lean},${120 - h * 0.6} ${x + lean * 0.5},${120 - h} Q${x + lean * 0.2},${120 - h * 0.6} ${x + 6},120`} />;
      })}
    </g>
    <g fill="#1e7a3c" opacity="0.8">
      {Array.from({ length: 30 }).map((_, i) => {
        const x = i * 13.3 + 1 + Math.sin(i * 2.1) * 3;
        const h = 24 + Math.sin(i * 0.9) * 10;
        const lean = Math.sin(i * 0.6) * 5;
        return <path key={`c${i}`} d={`M${x},120 Q${x + lean},${120 - h * 0.5} ${x + lean * 0.4},${120 - h} Q${x + lean * 0.1},${120 - h * 0.5} ${x + 7},120`} />;
      })}
    </g>
    <g fill="#22903f" opacity="0.6">
      {Array.from({ length: 15 }).map((_, i) => {
        const x = i * 26.7 + 3 + Math.sin(i * 2.5) * 4;
        const h = 16 + Math.sin(i * 1.8) * 8;
        const lean = Math.sin(i * 1.3) * 3;
        return <path key={`d${i}`} d={`M${x},120 Q${x + lean},${120 - h} ${x + lean * 0.2},${120 - h - 3} Q${x},${120 - h} ${x + 5},120`} />;
      })}
    </g>
  </svg>
));
