// Координаты зон удара и позиций вратаря.
// Gate container: 360x280, zone grid: left=16, w=328, h=238 (85% of 280).
// Ball starts with center at (180, 285) (bottom:-40, half height 35).
// targetPositions — translate-offsets от стартовой позиции мяча.
// Landing center = (180 + tx, 285 + ty).

export const zoneTargetCenters = [
  { left: 98, top: 90 },   // zone 0: top-left
  { left: 262, top: 90 },  // zone 1: top-right
  { left: 98, top: 208 },  // zone 2: bottom-left
  { left: 262, top: 208 }, // zone 3: bottom-right
];

export const targetPositions = [
  { x: -82, y: -195 },  // zone 0
  { x: 82, y: -195 },   // zone 1
  { x: -82, y: -77 },   // zone 2
  { x: 82, y: -77 },    // zone 3
];

// Позиции вратаря для прыжка в каждую зону (offset от центра + bottom).
export const keeperZonePos = [
  { x: -82, bottom: 170 }, // zone 0
  { x: 82, bottom: 170 },  // zone 1
  { x: -82, bottom: 52 },  // zone 2
  { x: 82, bottom: 52 },   // zone 3
];
