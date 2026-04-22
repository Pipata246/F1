/**
 * Комиссия на вывод: доля от суммы заявки (gross). На сеть уходит net = gross − fee.
 */
"use strict";

function withdrawalFeeBps() {
  const pct = Number(process.env.WITHDRAWAL_FEE_PERCENT);
  if (Number.isFinite(pct) && pct > 0 && pct < 100) {
    return Math.min(9999, Math.max(1, Math.round(pct * 100)));
  }
  const frac = Number(process.env.WITHDRAWAL_FEE_FRACTION);
  if (Number.isFinite(frac) && frac > 0 && frac < 1) {
    return Math.min(9999, Math.max(1, Math.round(frac * 10000)));
  }
  return 1000;
}

function withdrawalFeePercentDisplay() {
  return withdrawalFeeBps() / 100;
}

/**
 * @param {number} grossTon — списание с баланса пользователя
 * @returns {{ grossTon: number, feeTon: number, netTon: number, feeBps: number } | null}
 */
function withdrawalBreakdown(grossTon) {
  const g = Number(grossTon);
  if (!Number.isFinite(g) || g <= 0) return null;
  const bps = withdrawalFeeBps();
  const grossNano = BigInt(Math.round(g * 1e9));
  const feeNano = (grossNano * BigInt(bps)) / 10000n;
  const netNano = grossNano - feeNano;
  if (netNano <= 0n) return null;
  return {
    grossTon: Number(grossNano) / 1e9,
    feeTon: Number(feeNano) / 1e9,
    netTon: Number(netNano) / 1e9,
    feeBps: bps,
  };
}

module.exports = {
  withdrawalFeeBps,
  withdrawalFeePercentDisplay,
  withdrawalBreakdown,
};
