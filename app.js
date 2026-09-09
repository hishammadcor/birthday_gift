/* ============================================================
   HAPPY BIRTHDAY, ANAN
   ------------------------------------------------------------
   Act 1 — blow the candles out (canvas, one rAF loop, zero deps).
           Breath comes from the mic (analysed on-device) or from
           hold-to-blow — both feed the exact same 0..1 scalar.
   Act 2 — the room fades and a 3D rose grows from the dark and
           blooms, while "Happy Birthday" plays from 0:30.

   The song is unlocked on the same tap that starts the blowing,
   so it is free to start by itself the instant the last candle
   dies — which is what Safari's autoplay policy needs.
   ============================================================ */

/* ------------------------------------------------------------
   Safari reach-back: ctx.roundRect landed only in Safari 16.4.
   The cake + candles are drawn with it, so polyfill it or older
   iPhones get a blank canvas.
   ------------------------------------------------------------ */
if (typeof CanvasRenderingContext2D !== 'undefined' &&
    !CanvasRenderingContext2D.prototype.roundRect){
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r){
    let rr = typeof r === 'number' ? [r, r, r, r] : (r || [0, 0, 0, 0]);
    if (rr.length === 1) rr = [rr[0], rr[0], rr[0], rr[0]];
    if (rr.length === 2) rr = [rr[0], rr[1], rr[0], rr[1]];
    const max = Math.min(Math.abs(w), Math.abs(h)) / 2;
    rr = rr.map(v => Math.min(v, max));
    this.moveTo(x + rr[0], y);
    this.lineTo(x + w - rr[1], y);
    this.arcTo(x + w, y, x + w, y + rr[1], rr[1]);
    this.lineTo(x + w, y + h - rr[2]);
    this.arcTo(x + w, y + h, x + w - rr[2], y + h, rr[2]);
    this.lineTo(x + rr[3], y + h);
    this.arcTo(x, y + h, x, y + h - rr[3], rr[3]);
    this.lineTo(x, y + rr[0]);
    this.arcTo(x, y, x + rr[0], y, rr[0]);
    return this;
  };
}

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* deterministic noise so sprinkles / candle jitter survive a resize */
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ============================================================
   DOM
   ============================================================ */
const stage    = $('stage');
const canvas   = $('scene');
const ctx      = canvas.getContext('2d');
const eyebrow  = $('eyebrow');
const msg      = $('msg');
const msgTitle = $('msgTitle');
const msgEyebrow = $('msgEyebrow');
const msgSub   = $('msgSub');
const controls = $('controls');
const micBtn   = $('micBtn');
const micLabel = $('micLabel');
const holdBtn  = $('holdBtn');
const meter    = $('meter');
const meterFill = $('meterFill');
const meterLabel = $('meterLabel');
const replay   = $('replay');
const live     = $('live');

/* rose */
const roseStage    = $('roseStage');
const roseWrapper  = $('roseWrapper');
const roseHead     = $('roseHead');
const calyx        = $('calyx');
const stem         = $('stem');
const leafLeft     = $('leafLeft');
const leafRight    = $('leafRight');
const endText      = $('endText');
const ambientLight = $('ambientLight');
const fallingPetalsEl = $('fallingPetals');

const CANDLES = 5;

/* ============================================================
   AUDIO — "Happy Birthday", from 0:30
   ------------------------------------------------------------
   Safari (and iOS especially) will not let a page make sound on
   its own. But a media element that has once been play()'d inside
   a real user gesture is "blessed" — it can be driven by script
   afterwards. So the first tap that starts the blowing (mic button
   or hold) silently primes the song; later, when the candles are
   out, it can start by itself from 0:30 with sound.
   ------------------------------------------------------------ */
const SONG_START = 30;           // seconds
const song = $('song');
let audioPrimed = false;         // blessed by a gesture yet?
let songWanted  = false;         // we want it playing (retry target)

function primeAudio(){
  if (audioPrimed || !song) return;
  audioPrimed = true;
  /* muted play inside the gesture blesses the element without a blip */
  song.muted = true;
  const p = song.play();
  const settle = () => { try { song.pause(); song.currentTime = 0; } catch (e) {} };
  if (p && typeof p.then === 'function') p.then(settle).catch(() => { audioPrimed = false; });
  else settle();
}

function playSong(){
  if (!song) return;
  songWanted = true;
  const begin = () => {
    song.muted = false;
    try {
      if (isFinite(song.duration) && song.duration > SONG_START + 1) song.currentTime = SONG_START;
    } catch (e) {}
    const p = song.play();
    if (p && typeof p.catch === 'function') p.catch(() => {/* a later tap will retry */});
  };
  if (song.readyState >= 1) begin();
  else song.addEventListener('loadedmetadata', begin, { once: true });
}

/* if the first attempt was blocked, the next interaction anywhere retries it */
function audioKick(){
  primeAudio();
  if (songWanted && song && song.paused) playSong();
}
window.addEventListener('pointerdown', audioKick);
window.addEventListener('keydown', audioKick);

/* ============================================================
   BREATH — the mic engine
   ------------------------------------------------------------
   A blow is turbulence: a low rumble AND a high hiss at once, with
   no tonal centre. Speech has the low band but little 2–7kHz; an
   "sss" has the high band but no rumble. Gate on both and take the
   geometric mean, measured against the user's own room noise floor.
   ============================================================ */
class MicBreath {
  constructor(){
    this.ready = false;
    this.stream = null;
    this.audio = null;
    this.analyser = null;
    this.freq = null;
    this.floorLow = null;
    this.floorHigh = null;
    this.calibFrames = 0;
    this.value = 0;
  }

  async start(){
    /* the browser's own voice processing removes exactly the signal we want */
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.audio = new AC();
    if (this.audio.state === 'suspended') await this.audio.resume();

    const src = this.audio.createMediaStreamSource(this.stream);
    this.analyser = this.audio.createAnalyser();
    this.analyser.fftSize = 2048;               // ~23Hz per bin at 48k
    this.analyser.smoothingTimeConstant = 0.5;
    src.connect(this.analyser);                  // analyser only — nothing reaches the speakers

    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.binHz = this.audio.sampleRate / this.analyser.fftSize;
    this.lowBand  = this._bins(30, 300);
    this.highBand = this._bins(2000, 7000);
    this.ready = true;
    return true;
  }

  _bins(fromHz, toHz){
    return [
      Math.max(1, Math.floor(fromHz / this.binHz)),
      Math.min(this.freq.length - 1, Math.ceil(toHz / this.binHz)),
    ];
  }

  _bandDb([a, b]){
    let sum = 0;
    for (let i = a; i <= b; i++) sum += Math.pow(10, this.freq[i] / 10);
    return 10 * Math.log10(sum / (b - a + 1) + 1e-12);
  }

  read(){
    if (!this.ready) return 0;
    this.analyser.getFloatFrequencyData(this.freq);
    const low = this._bandDb(this.lowBand);
    const high = this._bandDb(this.highBand);

    if (this.calibFrames < 30){
      this.calibFrames++;
      this.floorLow  = this.floorLow  === null ? low  : lerp(this.floorLow, low, 0.2);
      this.floorHigh = this.floorHigh === null ? high : lerp(this.floorHigh, high, 0.2);
      return 0;
    }

    const lowN  = smoothstep(this.floorLow  + 8, this.floorLow  + 26, low);
    const highN = smoothstep(this.floorHigh + 8, this.floorHigh + 26, high);
    return Math.sqrt(lowN * highN);
  }

  stop(){
    this.ready = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.audio) this.audio.close();
    this.stream = this.audio = this.analyser = null;
  }
}

const mic = new MicBreath();

let holdPointer = false, holdKey = false;
const holding = () => holdPointer || holdKey;
let breath = 0;               // the smoothed 0..1 everything downstream reads
let everBlew = false;

function readBreath(dt){
  let raw;
  if (holding()) raw = 1;
  else if (mic.ready) raw = mic.read();
  else raw = 0;

  /* fast attack, slower release — a real puff starts abruptly and tails off */
  const k = raw > breath ? 1 - Math.exp(-dt / 0.055) : 1 - Math.exp(-dt / 0.19);
  breath += (raw - breath) * k;
  if (breath < 0.002) breath = 0;
  if (breath > 0.18 && !everBlew){ everBlew = true; onFirstBreath(); }
  return breath;
}

/* ============================================================
   SCENE GEOMETRY
   ============================================================ */
let W = 0, H = 0, dpr = 1;
let cakeW, cakeH, cakeRx, cakeRy, cakeTopY, cakeBottomY, cx;
let candleW, candleH, flameH, sprinkles = [];

let gRoom = null, gTable = null, gVignette = null;
let cakeLayer = null, cakeLayerCtx = null, cakeLayerKey = -1, cakeBox = null;

const SCENE_H_PER_CAKE_W = 0.085 + 0.015 + 0.30 + 0.40 + 0.115 * 1.3;   // ≈0.95

function layout(){
  cx = W / 2;

  const gap = clamp(Math.min(W, H) * 0.035, 8, 26);
  const eyebrowBottom = (eyebrow.offsetTop + eyebrow.offsetHeight) || H * 0.12;
  const controlsTop = controls.offsetTop || H * 0.86;
  const bandTop = eyebrowBottom + gap;
  const bandBottom = Math.max(bandTop + 120, controlsTop - gap);
  const band = bandBottom - bandTop;

  cakeW = clamp(Math.min(W * 0.62, band / SCENE_H_PER_CAKE_W), 120, 560);
  cakeH = cakeW * 0.40;
  cakeRx = cakeW / 2;
  cakeRy = cakeW * 0.115;

  candleW = cakeW * 0.030;
  candleH = cakeW * 0.30;
  flameH  = cakeW * 0.085;

  const shadow = cakeRy * 1.3;
  const above = flameH + candleW * 0.5 + candleH + cakeH;
  cakeBottomY = clamp(H * 0.72, bandTop + above, bandBottom - shadow);
  cakeTopY = cakeBottomY - cakeH;

  const rnd = mulberry32(7);
  sprinkles = Array.from({ length: 30 }, () => ({
    a: rnd() * Math.PI * 2,
    r: 0.28 + rnd() * 0.62,
    y: rnd(),
    rot: rnd() * Math.PI,
    hue: rnd(),
  }));

  layoutCandles();
  buildSprites();
  buildGradients();
  buildCakeLayer();
}

function buildGradients(){
  const cy = cakeTopY - candleH;
  gRoom = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.55);
  gRoom.addColorStop(0, 'rgba(92,52,20,.62)');
  gRoom.addColorStop(0.35, 'rgba(52,29,13,.36)');
  gRoom.addColorStop(1, 'rgba(13,9,8,0)');

  gTable = ctx.createRadialGradient(0, 0, 0, 0, 0, cakeW * 1.9);
  gTable.addColorStop(0, 'rgba(120,66,26,.5)');
  gTable.addColorStop(1, 'rgba(13,9,8,0)');

  gVignette = ctx.createRadialGradient(cx, H * 0.55, Math.min(W, H) * 0.28, cx, H * 0.55, Math.max(W, H) * 0.78);
  gVignette.addColorStop(0, 'rgba(0,0,0,0)');
  gVignette.addColorStop(1, 'rgba(0,0,0,.72)');
}

function buildCakeLayer(){
  const pad = cakeW * 0.14;
  cakeBox = {
    x: cx - cakeRx - pad,
    y: cakeTopY - candleH - candleW * 2 - pad,
    w: cakeW + pad * 2,
    h: (cakeBottomY + cakeRy * 1.6) - (cakeTopY - candleH - candleW * 2) + pad * 2,
  };
  cakeLayer = cakeLayer || document.createElement('canvas');
  cakeLayer.width = Math.max(1, Math.round(cakeBox.w * dpr));
  cakeLayer.height = Math.max(1, Math.round(cakeBox.h * dpr));
  cakeLayerCtx = cakeLayer.getContext('2d');
  cakeLayerKey = -1;                       // force a re-bake at the new size
}

function bakeCakeLayer(light){
  const key = Math.round(clamp01(light) * 24);
  if (key === cakeLayerKey) return;
  cakeLayerKey = key;
  const lit = key / 24;
  const g = cakeLayerCtx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cakeBox.w, cakeBox.h);
  g.save();
  g.translate(-cakeBox.x, -cakeBox.y);
  paintCakeInto(g, lit);
  paintCandlesInto(g, lit);
  g.restore();
}

/* ============================================================
   CANDLES + FLAMES
   ============================================================ */
const candles = [];

function layoutCandles(){
  const spread = cakeW * 0.60;
  const rnd = mulberry32(21);
  for (let i = 0; i < CANDLES; i++){
    const t = CANDLES === 1 ? 0.5 : i / (CANDLES - 1);
    const x = cx + (t - 0.5) * spread;
    const y = cakeTopY + Math.abs(t - 0.5) * cakeRy * 0.9;
    if (!candles[i]){
      candles[i] = {
        lit: true, health: 1, out: 0,
        phase: rnd() * Math.PI * 2,
        rate: 1.5 + rnd() * 0.5 + i * 0.16,
        wob: 0.6 + rnd() * 0.8,
      };
    }
    candles[i].x = x;
    candles[i].y = y;
  }
}

function litCount(){ return candles.reduce((n, c) => n + (c.lit ? 1 : 0), 0); }

function extinguish(c){
  c.lit = false;
  c.health = 0;
  c.out = now;
  for (let i = 0; i < 7; i++) spawnSmoke(c.x, c.y - candleH, i / 7);
  const left = litCount();
  announce(left ? `${left} candle${left > 1 ? 's' : ''} left` : 'All candles out.');
}

function updateFlames(dt, b){
  for (const c of candles){
    if (!c.lit) continue;
    if (b > 0.05){
      c.health -= dt * b * c.rate;
      if (c.health <= 0){ extinguish(c); continue; }
    } else if (c.health < 1){
      c.health = Math.min(1, c.health + dt * 0.35);   // it fights back
    }
  }
}

/* ============================================================
   SMOKE
   ============================================================ */
const smoke = [];
function spawnSmoke(x, y, t){
  smoke.push({
    x, y,
    vx: (Math.random() - 0.5) * cakeW * 0.04,
    vy: -cakeW * (0.07 + Math.random() * 0.07),
    r: cakeW * (0.006 + Math.random() * 0.010),
    life: 0,
    max: 1.9 + Math.random() * 1.3,
    seed: Math.random() * 100,
    delay: t * 0.9,
  });
}
function updateSmoke(dt){
  for (let i = smoke.length - 1; i >= 0; i--){
    const s = smoke[i];
    if (s.delay > 0){ s.delay -= dt; continue; }
    s.life += dt;
    if (s.life > s.max){ smoke.splice(i, 1); continue; }
    s.x += (s.vx + Math.sin(s.life * 1.7 + s.seed) * cakeW * 0.05) * dt;
    s.y += s.vy * dt;
    s.vy *= 1 - dt * 0.35;
    s.r += cakeW * 0.020 * dt;
  }
}

/* ============================================================
   SPRITES — pre-rendered radial falloffs
   ============================================================ */
let glowSprite, smokeSprite;
function radialSprite(size, stops){
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}
function buildSprites(){
  glowSprite = radialSprite(256, [
    [0, 'rgba(255,190,110,.95)'],
    [0.28, 'rgba(255,150,60,.42)'],
    [0.62, 'rgba(255,110,30,.12)'],
    [1, 'rgba(255,100,20,0)'],
  ]);
  smokeSprite = radialSprite(128, [
    [0, 'rgba(176,170,164,.42)'],
    [0.5, 'rgba(158,152,146,.14)'],
    [1, 'rgba(150,144,138,0)'],
  ]);
}
function drawSprite(sprite, x, y, size, alpha){
  if (alpha <= 0.002) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
  ctx.globalAlpha = 1;
}

/* ============================================================
   PAINTING
   ============================================================ */
let now = 0;

function lightLevel(){
  let l = 0;
  for (const c of candles) if (c.lit) l += 0.35 + 0.65 * c.health;
  return clamp01(l / CANDLES);
}

function paintRoom(light, bloom){
  ctx.fillStyle = '#0d0908';
  ctx.fillRect(0, 0, W, H);

  const warm = clamp01(light * 0.9 + bloom * 0.75);
  if (warm <= 0.001) return;

  const cy = cakeTopY - candleH;
  const s = 1 + bloom * 0.42;
  ctx.save();
  ctx.globalAlpha = warm;
  ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
  ctx.fillStyle = gRoom;
  ctx.fillRect(-W, -H, W * 3, H * 3);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = warm;
  ctx.translate(cx, cakeBottomY);
  ctx.scale(1, 0.26);
  ctx.fillStyle = gTable;
  ctx.beginPath();
  ctx.arc(0, 0, cakeW * 1.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function paintCakeInto(ctx, light){
  const lit = 0.30 + 0.70 * light;

  ctx.save();
  ctx.translate(cx, cakeBottomY + cakeRy * 0.55);
  ctx.scale(1, 0.22);
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.beginPath(); ctx.arc(0, 0, cakeRx * 1.16, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  const bg = ctx.createLinearGradient(cx - cakeRx, 0, cx + cakeRx, 0);
  bg.addColorStop(0, `rgb(${58 * lit},${38 * lit},${28 * lit})`);
  bg.addColorStop(0.34, `rgb(${196 * lit},${150 * lit},${112 * lit})`);
  bg.addColorStop(0.62, `rgb(${168 * lit},${124 * lit},${90 * lit})`);
  bg.addColorStop(1, `rgb(${52 * lit},${34 * lit},${25 * lit})`);
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(cx - cakeRx, cakeTopY);
  ctx.lineTo(cx - cakeRx, cakeBottomY);
  ctx.ellipse(cx, cakeBottomY, cakeRx, cakeRy, 0, Math.PI, 0, true);
  ctx.lineTo(cx + cakeRx, cakeTopY);
  ctx.closePath();
  ctx.fill();

  const lipY = cakeTopY + cakeRy * 0.92;
  const drips = 9;
  ctx.beginPath();
  ctx.moveTo(cx - cakeRx, cakeTopY);
  ctx.lineTo(cx - cakeRx, lipY);
  for (let i = 0; i < drips; i++){
    const x0 = cx - cakeRx + (i / drips) * cakeW;
    const x1 = cx - cakeRx + ((i + 1) / drips) * cakeW;
    const depth = lipY + cakeH * (0.09 + mulberry32(i * 13 + 3)() * 0.21);
    ctx.quadraticCurveTo((x0 + x1) / 2, depth, x1, lipY);
  }
  ctx.lineTo(cx + cakeRx, cakeTopY);
  ctx.closePath();
  const fg = ctx.createLinearGradient(cx - cakeRx, 0, cx + cakeRx, 0);
  fg.addColorStop(0, `rgb(${96 * lit},${68 * lit},${62 * lit})`);
  fg.addColorStop(0.36, `rgb(${252 * lit},${228 * lit},${214 * lit})`);
  fg.addColorStop(1, `rgb(${104 * lit},${72 * lit},${64 * lit})`);
  ctx.fillStyle = fg;
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(cx, cakeTopY, cakeRx, cakeRy, 0, 0, Math.PI * 2);
  const tg = ctx.createRadialGradient(cx, cakeTopY - cakeRy * 0.4, 0, cx, cakeTopY, cakeRx);
  tg.addColorStop(0, `rgb(${255 * lit},${242 * lit},${228 * lit})`);
  tg.addColorStop(1, `rgb(${208 * lit},${176 * lit},${156 * lit})`);
  ctx.fillStyle = tg;
  ctx.fill();

  for (const s of sprinkles){
    const x = cx + Math.cos(s.a) * cakeRx * s.r;
    const y = cakeTopY + Math.sin(s.a) * cakeRy * s.r;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(s.rot);
    const hues = [[236, 108, 128], [255, 190, 92], [150, 196, 216]];
    const [r, g2, b] = hues[Math.floor(s.hue * hues.length) % hues.length];
    ctx.fillStyle = `rgb(${r * lit},${g2 * lit},${b * lit})`;
    const w = cakeW * 0.016, h = cakeW * 0.006;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
    ctx.fill();
    ctx.restore();
  }
}

function paintCandlesInto(ctx, light){
  const lit = 0.34 + 0.66 * light;
  for (const c of candles){
    const top = c.y - candleH;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(c.x - candleW / 2, top, candleW, candleH, candleW * 0.35);
    ctx.clip();

    const g = ctx.createLinearGradient(c.x - candleW / 2, 0, c.x + candleW / 2, 0);
    g.addColorStop(0, `rgb(${120 * lit},${96 * lit},${96 * lit})`);
    g.addColorStop(0.4, `rgb(${250 * lit},${240 * lit},${236 * lit})`);
    g.addColorStop(1, `rgb(${140 * lit},${110 * lit},${108 * lit})`);
    ctx.fillStyle = g;
    ctx.fillRect(c.x - candleW, top, candleW * 2, candleH);

    ctx.fillStyle = `rgba(${226 * lit},${86 * lit},${104 * lit},.9)`;
    const step = candleW * 1.5;
    for (let y = top - candleW * 2; y < c.y + candleW * 2; y += step * 2){
      ctx.save();
      ctx.translate(c.x, y);
      ctx.rotate(-0.5);
      ctx.fillRect(-candleW * 2, 0, candleW * 4, step * 0.72);
      ctx.restore();
    }
    ctx.restore();

    ctx.strokeStyle = c.lit ? `rgba(60,40,30,.9)` : `rgba(${90 * lit},${80 * lit},${76 * lit},.95)`;
    ctx.lineWidth = Math.max(1, candleW * 0.16);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(c.x, top);
    ctx.lineTo(c.x, top - candleW * 0.5);
    ctx.stroke();
  }
}

function paintFlames(b){
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const c of candles){
    const top = c.y - candleH - candleW * 0.5;

    if (!c.lit){
      const age = now - c.out;
      if (age < 0.7) drawSprite(glowSprite, c.x, top, cakeW * 0.10 * (1 - age / 0.7), 0.5 * (1 - age / 0.7));
      continue;
    }

    const flick = Math.sin(now * 7.3 * c.wob + c.phase) * 0.5 + Math.sin(now * 17.1 + c.phase * 2) * 0.22;
    const push = b * (0.85 + 0.3 * Math.sin(now * 11 + c.phase));
    const health = c.health;

    const h = flameH * (0.72 + 0.28 * health) * (1 - 0.55 * push) * (1 + flick * 0.10);
    const w = candleW * (0.85 + 0.12 * flick) * (1 - 0.25 * push);
    const lean = push * 2.6 + flick * 0.10;
    const intensity = (0.45 + 0.55 * health) * (1 - 0.35 * push);

    drawSprite(glowSprite, c.x + lean * h * 0.4, top - h * 0.45,
               cakeW * (0.42 + 0.10 * flick) * (0.6 + 0.4 * health), 0.30 * intensity);

    ctx.beginPath();
    ctx.moveTo(c.x, top);
    ctx.bezierCurveTo(c.x - w, top - h * 0.28, c.x - w * 0.7 + lean * h * 0.35, top - h * 0.74, c.x + lean * h, top - h);
    ctx.bezierCurveTo(c.x + w * 0.7 + lean * h * 0.35, top - h * 0.74, c.x + w, top - h * 0.28, c.x, top);
    ctx.closePath();
    const og = ctx.createLinearGradient(c.x, top, c.x + lean * h, top - h);
    og.addColorStop(0, `rgba(255,92,20,${0.75 * intensity})`);
    og.addColorStop(0.45, `rgba(255,158,48,${0.95 * intensity})`);
    og.addColorStop(1, `rgba(255,214,140,${0.5 * intensity})`);
    ctx.fillStyle = og;
    ctx.fill();

    const hw = w * 0.42, hh = h * 0.52;
    ctx.beginPath();
    ctx.moveTo(c.x, top);
    ctx.bezierCurveTo(c.x - hw, top - hh * 0.3, c.x - hw * 0.6 + lean * hh * 0.4, top - hh * 0.75, c.x + lean * hh, top - hh);
    ctx.bezierCurveTo(c.x + hw * 0.6 + lean * hh * 0.4, top - hh * 0.75, c.x + hw, top - hh * 0.3, c.x, top);
    ctx.closePath();
    ctx.fillStyle = `rgba(255,248,226,${0.9 * intensity})`;
    ctx.fill();
  }
  ctx.restore();
}

function paintSmoke(){
  for (const s of smoke){
    if (s.delay > 0) continue;
    const t = s.life / s.max;
    const a = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.13;
    drawSprite(smokeSprite, s.x, s.y, s.r * 4.5, a);
  }
}

function paintVignette(){
  ctx.fillStyle = gVignette;
  ctx.fillRect(0, 0, W, H);
}

function paint(b, bloom){
  const light = lightLevel();
  paintRoom(light, bloom);

  bakeCakeLayer(light + bloom * 0.55);
  ctx.drawImage(cakeLayer, cakeBox.x, cakeBox.y, cakeBox.w, cakeBox.h);

  paintFlames(b);
  paintSmoke();
  paintVignette();
}

/* ============================================================
   ACTS — idle → out → bloom → rose → done
   ============================================================ */
let phase = 'idle';
let allOutAt = 0, bloomAt = 0;
let titleChars = [];

function announce(text){ live.textContent = text; }

function onFirstBreath(){
  eyebrow.classList.add('is-out');
  controls.classList.add('is-out');
}

function splitTitle(){
  const text = msgTitle.textContent;
  msgTitle.textContent = '';
  msgTitle.setAttribute('aria-label', text);
  titleChars = [...text].map((ch) => {
    const s = document.createElement('span');
    s.className = 'msg__ch';
    s.textContent = ch;
    s.setAttribute('aria-hidden', 'true');
    msgTitle.appendChild(s);
    return s;
  });
}

function revealMessage(){
  msg.hidden = false;
  announce('Happy Birthday, Anan.');

  const ease = 'cubic-bezier(.22,.86,.3,1)';
  msgEyebrow.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
    { duration: 700, delay: 60, easing: ease, fill: 'forwards' });

  titleChars.forEach((ch, i) => {
    ch.animate([{ opacity: 0, transform: 'translateY(.22em)' }, { opacity: 1, transform: 'none' }],
      { duration: 760, delay: 220 + i * 38, easing: ease, fill: 'forwards' });
  });

  msgSub.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
    { duration: 700, delay: 220 + titleChars.length * 38 + 120, easing: ease, fill: 'forwards' });
}

function armReplay(){
  window.wishDone = true;
  replay.hidden = false;
  requestAnimationFrame(() => replay.classList.add('is-shown'));
  if (mic.ready) mic.stop();
  meter.hidden = true;
}

function updatePhase(){
  if (phase === 'idle' && litCount() === 0){
    phase = 'out';
    allOutAt = now;
    /* the song begins the instant the last candle dies */
    playSong();
  } else if (phase === 'out' && now - allOutAt > 0.9){
    phase = 'bloom';
    bloomAt = now;
    revealMessage();
  } else if (phase === 'bloom' && now - bloomAt > 3.6){
    phase = 'rose';
    beginRose();
  }
}

/* ============================================================
   ACT 2 — the rose
   ============================================================ */
const PETAL_LAYERS = [
  { count: 4, w: 24, h: 46, curl: 78, delayBase: 0, tz: 2, cls: 'petal-bud' },
  { count: 5, w: 34, h: 58, curl: 65, delayBase: 0.25, tz: 9, cls: 'petal-core' },
  { count: 6, w: 46, h: 72, curl: 48, delayBase: 0.55, tz: 18, cls: 'petal-inner' },
  { count: 7, w: 58, h: 88, curl: 22, delayBase: 0.90, tz: 30, cls: 'petal-mid-inner' },
  { count: 8, w: 72, h: 104, curl: -5, delayBase: 1.30, tz: 44, cls: 'petal-mid' },
  { count: 9, w: 86, h: 118, curl: -25, delayBase: 1.75, tz: 60, cls: 'petal-outer' },
  { count: 10, w: 98, h: 130, curl: -48, delayBase: 2.25, tz: 76, cls: 'petal-blush' },
];
const SEPALS_COUNT = 5;
const FALLING_PETAL_COLORS = [
  ['#9a001d', '#3d0008'],
  ['#850018', '#2b0005'],
  ['#ad0022', '#480008'],
  ['#bf0028', '#52000c'],
];
let fallingPetalInterval = null;
let roseBuilt = false;

function createSepals(){
  const step = 360 / SEPALS_COUNT;
  for (let i = 0; i < SEPALS_COUNT; i++){
    const sepal = document.createElement('div');
    sepal.className = 'sepal';
    const angle = i * step + (Math.random() - 0.5) * 5;
    const d = 0.3 + i * 0.06;
    const curl = 18 + Math.random() * 8;
    sepal.style.setProperty('--sepal-angle', `${angle}deg`);
    sepal.style.setProperty('--sepal-curl', `${curl}deg`);
    sepal.style.setProperty('--sepal-delay', `${d}s`);
    calyx.appendChild(sepal);
  }
}

function createPetals(){
  PETAL_LAYERS.forEach((layer, li) => {
    const angleStep = 360 / layer.count;
    const layerOffset = li * 24 + (Math.random() - 0.5) * 8;
    for (let i = 0; i < layer.count; i++){
      const petal = document.createElement('div');
      petal.className = `petal ${layer.cls}`;
      const angle = layerOffset + i * angleStep + (Math.random() - 0.5) * 5;
      const d = layer.delayBase + i * 0.05;
      const curlJitter = (Math.random() - 0.5) * 6;
      const scaleJitter = 0.94 + Math.random() * 0.12;
      const bloomDur = 2.1 + Math.random() * 0.4;
      petal.style.width = `${layer.w}px`;
      petal.style.height = `${layer.h}px`;
      petal.style.setProperty('--angle', `${angle}deg`);
      petal.style.setProperty('--curl', `${layer.curl + curlJitter}deg`);
      petal.style.setProperty('--scale', scaleJitter);
      petal.style.setProperty('--delay', `${d}s`);
      petal.style.setProperty('--tz', `${layer.tz}px`);
      petal.style.setProperty('--bloom-dur', `${bloomDur}s`);
      roseHead.appendChild(petal);
    }
  });
}

function buildRose(){
  if (roseBuilt) return;
  roseBuilt = true;
  createSepals();
  createPetals();
}

function growStem(){
  return new Promise(resolve => {
    stem.classList.add('grow');
    setTimeout(() => leafLeft.classList.add('visible'), 800);
    setTimeout(() => leafRight.classList.add('visible'), 1100);
    setTimeout(resolve, 2200);
  });
}

function bloom(){
  calyx.classList.add('visible');
  ambientLight.classList.add('visible');
  roseHead.classList.add('blooming');
}

function spawnFallingPetal(){
  if (fallingPetalsEl.childElementCount > 10) return;
  const petal = document.createElement('div');
  petal.className = 'falling-petal';

  const w = 10 + Math.random() * 12;
  const h = w * (1.25 + Math.random() * 0.15);
  const x = 20 + Math.random() * 60;
  const y = 3 + Math.random() * 10;
  const dur = 5.5 + Math.random() * 3.5;
  const d = Math.random() * 0.6;
  const colors = FALLING_PETAL_COLORS[Math.floor(Math.random() * FALLING_PETAL_COLORS.length)];

  const sign = () => (Math.random() > 0.5 ? 1 : -1);
  const s1 = sign() * (15 + Math.random() * 25);
  const s2 = sign() * (10 + Math.random() * 20);
  const s3 = sign() * (20 + Math.random() * 30);
  const s4 = sign() * (10 + Math.random() * 15);

  petal.style.left = `${x}vw`;
  petal.style.top = `${y}vh`;
  petal.style.setProperty('--fp-w', `${w}px`);
  petal.style.setProperty('--fp-h', `${h}px`);
  petal.style.setProperty('--fp-c1', colors[0]);
  petal.style.setProperty('--fp-c2', colors[1]);
  petal.style.setProperty('--f-dur', `${dur}s`);
  petal.style.setProperty('--f-delay', `${d}s`);
  petal.style.setProperty('--s1', `${s1}px`);
  petal.style.setProperty('--s2', `${s2}px`);
  petal.style.setProperty('--s3', `${s3}px`);
  petal.style.setProperty('--s4', `${s4}px`);

  fallingPetalsEl.appendChild(petal);
  setTimeout(() => { if (petal.parentNode) petal.remove(); }, (dur + d) * 1000 + 300);
}

function startFallingPetals(){
  for (let i = 0; i < 3; i++) setTimeout(() => spawnFallingPetal(), i * 300);
  fallingPetalInterval = setInterval(spawnFallingPetal, 2200);
}

/* candle room gives way to the rose */
function beginRose(){
  buildRose();
  stage.classList.add('is-gone');
  roseStage.classList.add('active');
  roseStage.setAttribute('aria-hidden', 'false');

  /* once the room has crossfaded out, the canvas loop has nothing to do */
  setTimeout(() => { if (phase === 'rose' || phase === 'done') stopLoop(); }, 1600);

  /* let the fade get underway, then grow the rose */
  setTimeout(() => { startRoseSequence(); }, 600);
}

async function startRoseSequence(){
  await growStem();
  await delay(120);
  bloom();
  setTimeout(() => roseWrapper.classList.add('rotating'), 2600);
  setTimeout(() => startFallingPetals(), 3400);
  setTimeout(() => endText.classList.add('visible'), 4600);
  setTimeout(() => { phase = 'done'; armReplay(); }, 6200);
}

/* ============================================================
   THE LOOP
   ============================================================ */
let raf = 0, last = 0, noBlowHintAt = 0, fps = 0;

function frame(ms){
  raf = requestAnimationFrame(frame);
  const t = ms / 1000;
  const dt = Math.min(0.05, last ? t - last : 0.016);
  if (last) fps = lerp(fps || 1 / dt, 1 / dt, 0.1);
  last = t;
  now = t;

  const b = readBreath(dt);
  updateFlames(dt, b);
  updateSmoke(dt);
  updatePhase();

  const bloomLight = phase === 'bloom' || phase === 'rose' || phase === 'done'
    ? smoothstep(0, 1.7, now - bloomAt)
    : 0;

  paint(b, bloomLight);

  if (!meter.hidden){
    meterFill.style.transform = `scaleX(${b.toFixed(3)})`;
    if (noBlowHintAt && !everBlew && now > noBlowHintAt){
      meterLabel.textContent = 'not hearing you — hold anywhere to blow';
      noBlowHintAt = 0;
    }
  }
}

function startLoop(){ if (!raf){ last = 0; raf = requestAnimationFrame(frame); } }
function stopLoop(){ if (raf){ cancelAnimationFrame(raf); raf = 0; } }

/* ============================================================
   REDUCED MOTION — the same story, told as a still
   ============================================================ */
function drawStill(){
  now = 3;
  for (const c of candles){ c.lit = false; c.health = 0; c.out = -10; }
  smoke.length = 0;
  phase = 'done';
  paint(0, 1);
  eyebrow.classList.add('is-out');
  controls.classList.add('is-out');
  msg.hidden = false;
  titleChars.forEach(ch => { ch.style.opacity = '1'; ch.style.transform = 'none'; });
  msgEyebrow.style.opacity = '1';
  msgSub.style.opacity = '1';

  /* and the rose, already bloomed */
  buildRose();
  stage.classList.add('is-gone');
  roseStage.classList.add('active');
  roseStage.setAttribute('aria-hidden', 'false');
  stem.classList.add('grow');
  leafLeft.classList.add('visible');
  leafRight.classList.add('visible');
  calyx.classList.add('visible');
  ambientLight.classList.add('visible');
  roseHead.classList.add('blooming');
  endText.classList.add('visible');

  window.wishDone = true;
  announce('Happy Birthday, Anan.');
  armReplay();
  /* no gesture has happened here, so the song waits for the first tap */
  playSong();
}

/* ============================================================
   INPUT
   ============================================================ */
function setHold(kind, on){
  if (on) primeAudio();                 // this tap also blesses the song
  if (on && phase !== 'idle') return;
  if (kind === 'pointer') holdPointer = on; else holdKey = on;
  holdBtn.classList.toggle('is-holding', holding());
}

stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest && e.target.closest('.btn--mic, .replay')) return;
  setHold('pointer', true);
});
window.addEventListener('pointerup', () => setHold('pointer', false));
window.addEventListener('pointercancel', () => setHold('pointer', false));
window.addEventListener('blur', () => { setHold('pointer', false); setHold('key', false); });

holdBtn.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  e.preventDefault();
  if (e.repeat) return;
  setHold('key', true);
});
holdBtn.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.key === 'Enter') setHold('key', false);
});
holdBtn.addEventListener('blur', () => setHold('key', false));

micBtn.addEventListener('click', async () => {
  primeAudio();                         // the click that turns the mic on also blesses the song
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    micFailed('Microphone not available here');
    return;
  }
  micBtn.disabled = true;
  micLabel.textContent = 'Asking…';
  try {
    await mic.start();
    controls.classList.add('is-out');
    meter.hidden = false;
    meterLabel.textContent = 'listening…';
    noBlowHintAt = now + 7;
    announce('Microphone on. Blow to put the candles out.');
  } catch (err){
    micFailed(err && err.name === 'NotAllowedError' ? 'No mic — hold to blow instead' : 'Mic unavailable — hold to blow');
  }
});

function micFailed(text){
  micBtn.disabled = true;
  micLabel.textContent = text;
  holdBtn.focus({ preventScroll: true });
  announce(text);
}

replay.addEventListener('click', resetAll);

function resetAll(){
  phase = 'idle';
  breath = 0; holdPointer = holdKey = false; everBlew = false;
  holdBtn.classList.remove('is-holding');
  window.wishDone = false;
  smoke.length = 0;
  for (const c of candles){ c.lit = true; c.health = 1; c.out = 0; }

  replay.classList.remove('is-shown');
  replay.hidden = true;
  msg.hidden = true;
  titleChars.forEach(ch => { ch.getAnimations().forEach(a => a.cancel()); });
  msgEyebrow.getAnimations().forEach(a => a.cancel());
  msgSub.getAnimations().forEach(a => a.cancel());
  eyebrow.classList.remove('is-out');
  controls.classList.remove('is-out');
  micBtn.disabled = false;
  micLabel.textContent = 'Use my breath';
  meter.hidden = true;
  meterFill.style.transform = 'scaleX(0)';

  /* rewind the rose */
  if (fallingPetalInterval){ clearInterval(fallingPetalInterval); fallingPetalInterval = null; }
  while (fallingPetalsEl.firstChild) fallingPetalsEl.removeChild(fallingPetalsEl.firstChild);
  roseStage.classList.remove('active');
  roseStage.setAttribute('aria-hidden', 'true');
  stage.classList.remove('is-gone');
  roseWrapper.classList.remove('rotating');
  stem.classList.remove('grow');
  leafLeft.classList.remove('visible');
  leafRight.classList.remove('visible');
  calyx.classList.remove('visible');
  ambientLight.classList.remove('visible');
  roseHead.classList.remove('blooming');
  endText.classList.remove('visible');

  /* rewind the song */
  songWanted = false;
  if (song){ try { song.pause(); song.currentTime = 0; } catch (e) {} }

  announce('Candles relit.');
  startLoop();
  requestAnimationFrame(() => {
    eyebrow.classList.add('is-in');
    controls.classList.add('is-in');
  });
}

/* ============================================================
   SIZING + BOOT
   ============================================================ */
function resize(){
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layout();
  if (reduceMotion) drawStill();
}
let resizeRAF = 0;
window.addEventListener('resize', () => {
  if (resizeRAF) return;
  resizeRAF = requestAnimationFrame(() => { resizeRAF = 0; resize(); });
});

splitTitle();
resize();

if (document.fonts && document.fonts.ready) document.fonts.ready.then(resize);

if (reduceMotion){
  drawStill();
} else {
  startLoop();
  requestAnimationFrame(() => {
    eyebrow.classList.add('is-in');
    controls.classList.add('is-in');
  });
}

/* pause the canvas loop when the tab is hidden — but never fight the rose,
   which runs on its own timers once Act 2 has begun */
document.addEventListener('visibilitychange', () => {
  if (reduceMotion) return;
  if (phase === 'rose' || phase === 'done') return;
  if (document.hidden) stopLoop(); else startLoop();
});
