import fs from "fs";

const p = "roulette-server/public/roulette-ui.js";
let s = fs.readFileSync(p, "utf8");

const start = "  // Получить стабильный индекс цвета для игрока на основе его ID";
const end = "  // ==================== ACTIONS ====================";
const i0 = s.indexOf(start);
const i1 = s.indexOf(end);
if (i0 === -1 || i1 === -1 || i1 <= i0) {
  console.error("markers not found", { i0, i1 });
  process.exit(1);
}

const replacement = `  clearWinnerCardHighlight(strip) {
    if (!strip) return;
    strip.querySelectorAll(".roulette-card--winner").forEach((el) => {
      el.classList.remove("roulette-card--winner");
      el.style.boxShadow = "";
      el.style.filter = "";
      el.style.transform = "";
      el.style.zIndex = "";
      el.style.position = "";
    });
  }

  countCardsInHtml(html) {
    const wrap = document.createElement("div");
    wrap.innerHTML = String(html || "").trim();
    return wrap.querySelectorAll(".roulette-card").length;
  }

  /**
   * Один спин как в кейсе CS:GO: много повторов server HTML (ленты не «заканчиваются»),
   * один RAF ease-out, без CSS transition (нет второго движка).
   */
  runCaseOpeningSpin({ round, wheelHtml }) {
    return new Promise((resolve, reject) => {
      const strip = this.elements.strip;
      const container = this.elements.wheelContainer;
      const baseHtml = (wheelHtml && String(wheelHtml).trim())
        ? wheelHtml
        : String(this.state.wheelCardsHTML || "").trim();

      if (!strip || !container || !baseHtml) {
        reject(new Error("[Roulette] Missing strip/container/wheelHtml"));
        return;
      }

      this.cancelCaseOpeningRaf();
      strip.style.transition = "none";

      const baseCount = this.countCardsInHtml(baseHtml);
      if (!baseCount) {
        reject(new Error("[Roulette] No .roulette-card in wheel HTML"));
        return;
      }

      const rawIdx = Number(round?.winner_card_index);
      let idxInBase;
      if (Number.isFinite(rawIdx)) {
        idxInBase = ((Math.floor(rawIdx) % baseCount) + baseCount) % baseCount;
      } else {
        const wrap = document.createElement("div");
        wrap.innerHTML = baseHtml.trim();
        const arr = [...wrap.querySelectorAll(".roulette-card")];
        const found = arr.findIndex(
          (c) => String(c.getAttribute("data-user-id")) === String(round?.winner_user_id)
        );
        idxInBase = found >= 0 ? found : 0;
      }

      const RUNWAY_SEGMENTS = 18;
      const TAIL_SEGMENTS = 14;
      const repeats = RUNWAY_SEGMENTS + 1 + TAIL_SEGMENTS;
      strip.innerHTML = new Array(repeats).fill(baseHtml).join("");

      const globalWinnerIndex = RUNWAY_SEGMENTS * baseCount + idxInBase;
      const allLive = strip.querySelectorAll(".roulette-card");
      const winnerEl = allLive[globalWinnerIndex];

      if (!winnerEl) {
        reject(new Error("[Roulette] Winner card index out of DOM range"));
        return;
      }

      this.clearWinnerCardHighlight(strip);
      strip.style.transform = "translateX(0)";
      void strip.offsetHeight;

      const cw = container.offsetWidth;
      const cardW = Math.max(1, winnerEl.offsetWidth);
      const targetCenter = winnerEl.offsetLeft + cardW / 2;
      const pointerX = cw / 2;
      const runwayPx = cardW * 46 + cw * 0.48;
      const finalTranslate = pointerX - targetCenter - runwayPx;

      const durationMs = 14000;
      const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
      const t0 = performance.now();

      const step = (now) => {
        const u = Math.min(1, (now - t0) / durationMs);
        const e = easeOutQuint(u);
        strip.style.transform = 'translateX(' + finalTranslate * e + 'px)';
        if (u < 1) {
          this.caseSpinRafId = requestAnimationFrame(step);
        } else {
          this.caseSpinRafId = null;
          strip.style.transform = 'translateX(' + finalTranslate + 'px)';
          requestAnimationFrame(() => {
            this.clearWinnerCardHighlight(strip);
            winnerEl.classList.add("roulette-card--winner");
            winnerEl.style.boxShadow =
              "inset 0 0 0 3px rgba(140,255,193,.78), 0 0 26px rgba(140,255,193,.85)";
            winnerEl.style.filter = "brightness(1.15) saturate(1.16)";
            winnerEl.style.transform = "scale(1.04)";
            winnerEl.style.zIndex = "20";
            winnerEl.style.position = "relative";
            this.stopSpinSound();
            setTimeout(resolve, 1250);
          });
        }
      };

      this.caseSpinRafId = requestAnimationFrame(step);
    });
  }

`;

s = s.slice(0, i0) + replacement + s.slice(i1);
fs.writeFileSync(p, s);
console.log("patched:", p, "removed old spin block, inserted runCaseOpeningSpin");
