/**
 * CaseReelEngine — единственная RAF-анимация полосы кейса/рулетки.
 * Затухающая пружина 2-го порядка (без потолков скорости и без «телепорта» в цель):
 * старт с импульсом → скорость монотонно спадает → долгий медленный докат к центру.
 * omega в рад/с (нормировка как в x''+2ζωx'+ω²x=ω²T): меньше omega = дольше и мягче хвост.
 */
(function (global) {
  'use strict';

  var clamp = function (v, a, b) {
    return Math.max(a, Math.min(b, v));
  };

  global.CaseReelLayout = {
    countCardsInBase: function (html) {
      var wrap = document.createElement('div');
      wrap.innerHTML = String(html || '').trim();
      return wrap.querySelectorAll('.roulette-card').length;
    },

    fillRepeatedStrip: function (strip, baseHtml, runwaySeg, tailSeg) {
      var n = runwaySeg + 1 + tailSeg;
      strip.innerHTML = new Array(n).fill(String(baseHtml).trim()).join('');
      return { runwaySeg: runwaySeg, tailSeg: tailSeg, repeats: n };
    },

    globalIndexForWinner: function (baseCount, runwaySeg, winnerIdxInBase) {
      return runwaySeg * baseCount + winnerIdxInBase;
    },

    winnerIndexInBase: function (baseHtml, round) {
      var baseCount = global.CaseReelLayout.countCardsInBase(baseHtml);
      if (!baseCount) return 0;
      var raw = Number(round && round.winner_card_index);
      if (Number.isFinite(raw)) {
        return ((Math.floor(raw) % baseCount) + baseCount) % baseCount;
      }
      var wrap = document.createElement('div');
      wrap.innerHTML = String(baseHtml).trim();
      var arr = Array.prototype.slice.call(wrap.querySelectorAll('.roulette-card'));
      var found = arr.findIndex(function (c) {
        return String(c.getAttribute('data-user-id')) === String(round && round.winner_user_id);
      });
      return found >= 0 ? found : 0;
    },

    /**
     * translateX такой, что центр карты globalCardIndex совпадает с центром контейнера,
     * плюс дополнительный «пробег» extraRunwayPx (влево для кейса).
     */
    computeTargetTranslateX: function (strip, container, globalCardIndex, extraRunwayPx) {
      var cards = strip.querySelectorAll('.roulette-card');
      var card = cards[globalCardIndex];
      if (!card || !container) return 0;
      var cw = container.offsetWidth;
      var cardW = Math.max(1, card.offsetWidth);
      var targetCenter = card.offsetLeft + cardW / 2;
      var pointerX = cw / 2;
      var extra = Number(extraRunwayPx) || 0;
      return pointerX - targetCenter - extra;
    },
  };

  global.CaseReelWinner = {
    pickCardUnderPointer: function (strip, container) {
      if (!strip || !container) return null;
      var cr = container.getBoundingClientRect();
      var x = cr.left + cr.width / 2;
      var y = cr.top + cr.height / 2;
      try {
        var stack = document.elementsFromPoint(x, y);
        for (var i = 0; i < stack.length; i++) {
          var hit = stack[i];
          if (hit && strip.contains(hit) && hit.classList && hit.classList.contains('roulette-card')) {
            return hit;
          }
        }
      } catch (e) {}
      var centerX = x;
      var best = null;
      var bestD = Infinity;
      strip.querySelectorAll('.roulette-card').forEach(function (el) {
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width / 2;
        var d = Math.abs(cx - centerX);
        if (d < bestD) {
          bestD = d;
          best = el;
        }
      });
      return best;
    },

    resolveUserId: function (cardEl) {
      if (!cardEl) return '';
      return String(cardEl.getAttribute('data-user-id') || '');
    },
  };

  function CaseReelEngine() {
    this._raf = null;
    this._aborted = false;
    this._pendingResolve = null;
    this._activeStrip = null;
  }

  CaseReelEngine.prototype.abort = function () {
    this._aborted = true;
    if (this._activeStrip) {
      try {
        this._activeStrip.style.willChange = 'auto';
      } catch (e) {}
      this._activeStrip = null;
    }
    if (this._raf != null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this._pendingResolve) {
      var pr = this._pendingResolve;
      this._pendingResolve = null;
      pr();
    }
  };

  CaseReelEngine.prototype.suggestInitialVelocity = function (pos0, target) {
    var D = target - pos0;
    if (Math.abs(D) < 1) return 0;
    var sign = D < 0 ? -1 : 1;
    // Импульс к цели; верх — чтобы не улететь за кадр при малой дистанции.
    var mag = Math.min(4800, Math.abs(D) * 0.52);
    return sign * mag;
  };

  /**
   * @param {object} o
   * @param {HTMLElement} o.strip
   * @param {number} o.targetTranslateX
   * @param {number} [o.omega] рад/с (типично 0.38–0.55): меньше = дольше и «интригующее» замедление
   * @param {number} [o.zeta] ≥1 — затухание; чуть >1 снижает перелёт при большом начальном импульсе
   * @param {number} [o.maxDurationMs]
   * @param {number} [o.initialVelocity] px/s; иначе авто
   */
  CaseReelEngine.prototype.run = function (o) {
    var strip = o.strip;
    this._activeStrip = strip;
    var target = o.targetTranslateX;
    var omega = o.omega != null ? o.omega : 0.46;
    var zeta = o.zeta != null ? o.zeta : 1.1;
    var maxMs = o.maxDurationMs != null ? o.maxDurationMs : 20000;

    this.abort();
    this._aborted = false;

    var pos = 0;
    var vel = o.initialVelocity != null ? o.initialVelocity : this.suggestInitialVelocity(0, target);
    var z = 2 * zeta * omega;
    var w2 = omega * omega;
    var t0 = performance.now();
    var prev = t0;
    var self = this;

    strip.style.transition = 'none';
    strip.style.willChange = 'transform';

    var applyPos = function (px) {
      strip.style.transform = 'translate3d(' + px + 'px,0,0)';
    };

    this._pendingResolve = null;
    return new Promise(function (resolve) {
      self._pendingResolve = resolve;
      function finish() {
        strip.style.willChange = 'auto';
        self._activeStrip = null;
      }
      function frame(now) {
        if (self._aborted) {
          self._raf = null;
          finish();
          var p0 = self._pendingResolve;
          self._pendingResolve = null;
          if (p0) p0();
          return;
        }
        var dtRaw = (now - prev) / 1000;
        var steps = dtRaw > 0.022 ? 2 : 1;
        var dt = clamp(dtRaw / steps, 0.001, 0.02);
        prev = now;

        for (var s = 0; s < steps; s++) {
          var dist = target - pos;
          var accel = w2 * dist - z * vel;
          vel += accel * dt;
          // только защита от численного взрыва (фоновая вкладка / огромный dt)
          var vSafe = 9000;
          if (vel > vSafe) vel = vSafe;
          if (vel < -vSafe) vel = -vSafe;
          pos += vel * dt;
        }

        var settled = Math.abs(target - pos) < 0.35 && Math.abs(vel) < 10;
        var timeout = now - t0 > maxMs;
        if (settled || timeout) {
          pos = target;
          vel = 0;
          applyPos(pos);
          finish();
          self._raf = null;
          var p1 = self._pendingResolve;
          self._pendingResolve = null;
          if (p1) p1();
          return;
        }
        applyPos(pos);
        self._raf = requestAnimationFrame(frame);
      }
      self._raf = requestAnimationFrame(frame);
    });
  };

  global.CaseReelEngine = CaseReelEngine;
})(typeof window !== 'undefined' ? window : globalThis);
