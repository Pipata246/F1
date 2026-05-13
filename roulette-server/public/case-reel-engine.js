/**
 * CaseReelEngine — единственная RAF-анимация полосы кейса/рулетки.
 * Критически затухающая пружина: быстрый старт → плавное замедление → мягкая остановка в цели.
 * Без CSS transition, без setInterval для движения.
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
      var centerX = cr.left + cr.width / 2;
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
  }

  CaseReelEngine.prototype.abort = function () {
    this._aborted = true;
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
    var mag = Math.min(5600, Math.abs(D) * 0.92);
    return sign * mag;
  };

  /**
   * @param {object} o
   * @param {HTMLElement} o.strip
   * @param {number} o.targetTranslateX
   * @param {number} [o.omega] ~1.35–1.85: меньше = дольше докат
   * @param {number} [o.zeta] = 1 критическое затухание
   * @param {number} [o.maxDurationMs]
   * @param {number} [o.initialVelocity] px/s; иначе авто
   */
  CaseReelEngine.prototype.run = function (o) {
    var strip = o.strip;
    var target = o.targetTranslateX;
    var omega = o.omega != null ? o.omega : 1.58;
    var zeta = o.zeta != null ? o.zeta : 1;
    var maxMs = o.maxDurationMs != null ? o.maxDurationMs : 14000;

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

    this._pendingResolve = null;
    return new Promise(function (resolve) {
      self._pendingResolve = resolve;
      function frame(now) {
        if (self._aborted) {
          self._raf = null;
          var p0 = self._pendingResolve;
          self._pendingResolve = null;
          if (p0) p0();
          return;
        }
        var dt = clamp((now - prev) / 1000, 0.001, 0.034);
        prev = now;

        var accel = w2 * (target - pos) - z * vel;
        vel += accel * dt;
        pos += vel * dt;

        var settled = Math.abs(target - pos) < 0.4 && Math.abs(vel) < 8;
        var timeout = now - t0 > maxMs;
        if (settled || timeout) {
          pos = target;
          vel = 0;
          strip.style.transform = 'translateX(' + pos + 'px)';
          self._raf = null;
          var p1 = self._pendingResolve;
          self._pendingResolve = null;
          if (p1) p1();
          return;
        }
        strip.style.transform = 'translateX(' + pos + 'px)';
        self._raf = requestAnimationFrame(frame);
      }
      self._raf = requestAnimationFrame(frame);
    });
  };

  global.CaseReelEngine = CaseReelEngine;
})(typeof window !== 'undefined' ? window : globalThis);
