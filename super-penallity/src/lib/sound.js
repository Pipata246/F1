// Web Audio API звуковая система для Super Penalty.
// iOS Telegram WebApp требует, чтобы AudioContext создавался в user-gesture (tap/click) —
// armAudioOnGesture навешивает one-shot listener на pointerdown и инициализирует контекст
// при первом тапе. До этого playSound/startBackground просто молчат.

const ASSET_BASE = import.meta.env.BASE_URL || '/super-penallity/';
const SETTINGS_KEY = 'f1duel_global_settings_v1';

function appSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { sound: s?.sound !== false, haptic: s?.haptic !== false };
  } catch {
    return { sound: true, haptic: true };
  }
}

export const SOUND_VOLUMES = {
  kick: 0.6,
  save: 0.5,
  goal: 0.75,
  background: 0.18,
  whistle_start: 0.5,
  whistle_end: 0.55,
  tick: 0.3,
};

const SOUND_MAX_DURATION = {
  goal: 2.4,
  whistle_end: 2.5,
};

const SOUND_BUFFERS = {};
let _audioCtx = null;
let _audioCtxReady = false;
let _audioGestureBound = false;

function _initAudioCtx() {
  if (_audioCtxReady && _audioCtx) return _audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    if (!_audioCtx) _audioCtx = new Ctx();
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    _audioCtxReady = true;
    Object.keys(SOUND_VOLUMES).forEach((name) => { _loadSound(name); });
  } catch (e) { _audioCtx = null; _audioCtxReady = false; }
  return _audioCtx;
}

export function armAudioOnGesture() {
  if (_audioGestureBound) return;
  _audioGestureBound = true;
  const arm = () => { _initAudioCtx(); };
  ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, arm, { once: true, passive: true, capture: true });
  });
}

function _loadSound(name) {
  if (!_audioCtxReady || !_audioCtx) return Promise.resolve(null);
  if (SOUND_BUFFERS[name]) return Promise.resolve(SOUND_BUFFERS[name]);
  return fetch(`${ASSET_BASE}sounds/${name}.mp3`)
    .then((r) => r.arrayBuffer())
    .then((buf) => new Promise((resolve, reject) => {
      _audioCtx.decodeAudioData(buf, resolve, reject);
    }))
    .then((decoded) => { SOUND_BUFFERS[name] = decoded; return decoded; })
    .catch(() => null);
}

export function preloadSounds() {
  if (_audioCtxReady) {
    Object.keys(SOUND_VOLUMES).forEach((name) => { _loadSound(name); });
  }
}

export function playSound(name) {
  if (!appSettings().sound) return;
  if (!_audioCtxReady || !_audioCtx) return;
  try {
    const ctx = _audioCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const buffer = SOUND_BUFFERS[name];
    if (!buffer) { _loadSound(name); return; }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    const volume = SOUND_VOLUMES[name] != null ? SOUND_VOLUMES[name] : 0.5;
    gain.gain.value = volume;
    source.connect(gain).connect(ctx.destination);
    source.start(0);
    const maxDur = SOUND_MAX_DURATION[name];
    if (maxDur != null) {
      const fadeStart = Math.max(0, maxDur - 0.4);
      try {
        gain.gain.setValueAtTime(volume, ctx.currentTime + fadeStart);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + maxDur);
      } catch (e) {}
      try { source.stop(ctx.currentTime + maxDur); } catch (e) {}
    }
  } catch (e) {}
}

let _bgSource = null;
let _bgGain = null;

export function startBackground() {
  if (!appSettings().sound) return;
  if (_bgSource) return;
  if (!_audioCtxReady || !_audioCtx) return;
  const ctx = _audioCtx;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const start = () => {
    const buffer = SOUND_BUFFERS['background'];
    if (!buffer) return;
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = SOUND_VOLUMES.background;
      source.connect(gain).connect(ctx.destination);
      source.start(0);
      _bgSource = source;
      _bgGain = gain;
    } catch (e) {}
  };
  if (SOUND_BUFFERS['background']) start();
  else _loadSound('background').then(start);
}

export function stopBackground() {
  try {
    if (_bgSource) { try { _bgSource.stop(0); } catch (e) {} _bgSource.disconnect(); }
  } catch (e) {}
  _bgSource = null;
  _bgGain = null;
}

export function isAudioReady() {
  return _audioCtxReady;
}

export { appSettings };
