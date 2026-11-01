// Synthesizes the launch film's sound-effects track, timed to ideabird-launch.html.
// usage: node sfx.mjs <out.wav>
import fs from 'node:fs';

const SR = 48000, DUR = 45;
const LEN = SR * DUR;
const N = s => Math.max(1, Math.round(s * SR));
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;
const TAU = Math.PI * 2;

// ---------- buses ----------
const dryL = new Float32Array(LEN), dryR = new Float32Array(LEN);
const sendL = new Float32Array(LEN), sendR = new Float32Array(LEN);

function norm(x) { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); if (m > 0) for (let i = 0; i < x.length; i++) x[i] /= m; return x; }
// place a mono sound at time t with gain, a pan sweep (-1..1) and a reverb send
function place(x, t, gain, { pan = 0, pan2 = pan, rev = .25 } = {}) {
  const s0 = Math.round(t * SR);
  for (let i = 0; i < x.length; i++) {
    const j = s0 + i; if (j < 0 || j >= LEN) continue;
    const pn = pan + (pan2 - pan) * (i / x.length), a = (pn + 1) * Math.PI / 4;
    const v = x[i] * gain, l = v * Math.cos(a), r = v * Math.sin(a);
    dryL[j] += l; dryR[j] += r; sendL[j] += l * rev; sendR[j] += r * rev;
  }
}
const panX = x => Math.max(-1, Math.min(1, (x - 960) / 960 * .7));

// Chamberlin state-variable filter with a time-varying cutoff
function svf(x, fc, damp = .6, mode = 'bp') {
  let low = 0, band = 0; const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const f = 2 * Math.sin(Math.PI * Math.min(typeof fc === 'function' ? fc(i) : fc, SR / 6.5) / SR);
    low += f * band; const high = x[i] - low - damp * band; band += f * high;
    y[i] = mode === 'bp' ? band : mode === 'lp' ? low : high;
  }
  return y;
}
const white = n => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = noise(); return x; };

// ---------- sound generators (all return normalized mono) ----------
function whoosh(dur, f0, f1, { damp = .5, peak = .45, curve = 1.6 } = {}) {
  const n = N(dur), y = svf(white(n), i => f0 * Math.pow(f1 / f0, i / n), damp, 'bp');
  for (let i = 0; i < n; i++) { const a = i / n; y[i] *= a < peak ? Math.pow(a / peak, 2) : Math.pow(1 - (a - peak) / (1 - peak), curve); }
  return norm(y);
}
function impact() {
  const n = N(1.6), y = new Float32Array(n), cr = svf(white(n), 1400, .9, 'lp');
  let ph = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = 42 + 70 * Math.exp(-t * 16);
    ph += TAU * f / SR; ph2 += TAU * 190 / SR;
    y[i] = Math.sin(ph) * Math.exp(-t * 2.8) * Math.min(1, t * 400) + Math.sin(ph2) * Math.exp(-t * 16) * .25 + cr[i] * Math.exp(-t * 45) * 1.6;
  }
  return norm(y);
}
function sub(dur = 2) {
  const n = N(dur), y = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * (36 + 46 * Math.exp(-t * 7)) / SR; y[i] = Math.sin(ph) * Math.min(1, t * 80) * Math.exp(-t * 1.9); }
  return norm(y);
}
function pop(f, dur = .2) {
  const n = N(dur), y = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * f * (1 + .7 * Math.exp(-t * 70)) / SR; y[i] = Math.sin(ph) * (1 - Math.exp(-t * 900)) * Math.exp(-t * 26); }
  return norm(y);
}
function tick(f, dur = .05) {
  const n = N(dur), y = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * f / SR; y[i] = Math.sin(ph) * Math.exp(-t * 160) + noise() * Math.exp(-t * 600) * .25; }
  return norm(y);
}
function keyTick() {
  const n = N(.035), f = 2200 + rnd() * 2600;
  const y = svf(white(n), f, .35, 'bp');
  for (let i = 0; i < n; i++) y[i] *= Math.exp(-(i / SR) * 260);
  return norm(y);
}
function click() {
  const n = N(.06), y = svf(white(n), 3200, .6, 'hp'); let ph = 0, ph2 = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * 1900 / SR; ph2 += TAU * 320 / SR; y[i] = y[i] * Math.exp(-t * 420) + Math.sin(ph) * Math.exp(-t * 140) * .45 + Math.sin(ph2) * Math.exp(-t * 70) * .35; }
  return norm(y);
}
function chime(freqs, dur = 2.6, decay = 2.2) {
  const n = N(dur), y = new Float32Array(n);
  const parts = [[1, 1, 1], [2, .32, 1.6], [3.01, .12, 2.4], [4.18, .06, 3.2]];
  freqs.forEach((f, k) => {
    for (const [m, a, dk] of parts) {
      const w = TAU * f * m / SR, dl = decay * dk * (1 + k * .08);
      for (let i = 0; i < n; i++) { const t = i / SR; y[i] += Math.sin(w * i + k) * a * Math.min(1, t * 300) * Math.exp(-t * dl); }
    }
  });
  return norm(y);
}
function riser(dur) {
  const n = N(dur), y = svf(white(n), i => 300 * Math.pow(25, i / n), .4, 'bp'); let ph = 0;
  for (let i = 0; i < n; i++) { const a = i / n; ph += TAU * (180 + 620 * a * a) / SR; y[i] = (y[i] + Math.sin(ph) * .25) * Math.pow(a, 2.4); }
  return norm(y);
}
function glitch(dur) {
  const n = N(dur), y = new Float32Array(n);
  let i = 0;
  while (i < n) {
    const len = N(.01 + rnd() * .025), on = rnd() > .3, kind = rnd(), f = 300 + rnd() * 3500, hold = 3 + Math.floor(rnd() * 12);
    let h = 0, ph = 0;
    for (let k = 0; k < len && i < n; k++, i++) {
      if (!on) continue;
      if (k % hold === 0) h = kind < .5 ? noise() : Math.sign(Math.sin(ph));
      ph += TAU * f * hold / SR;
      y[i] = h * (.4 + rnd() * .1) * Math.sin(Math.PI * k / len);
    }
  }
  const b = svf(y, 2400, .9, 'bp');
  for (let k = 0; k < n; k++) b[k] = b[k] * .7 + y[k] * .3;
  for (let k = 0; k < n; k++) { const a = k / n; b[k] *= Math.min(1, a * 12) * (1 - a); }
  return norm(b);
}
function scan(dur) {
  const n = N(dur), hi = svf(white(n), 5200, .3, 'bp'), y = new Float32Array(n); let ph = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const a = i / n, t = i / SR;
    ph += TAU * (320 + 760 * a) / SR; ph2 += TAU * (1300 + 1500 * a) / SR;
    const env = Math.sin(Math.PI * a) ** .7;
    y[i] = (Math.sin(ph) * .6 + Math.sin(ph2) * .18 * (.5 + .5 * Math.sin(TAU * 24 * t)) + hi[i] * .5) * env;
  }
  return norm(y);
}
function scribble(dur) {
  const n = N(dur), y = svf(white(n), i => 2600 + 900 * Math.sin(i / SR * TAU * 3), .25, 'bp');
  for (let i = 0; i < n; i++) { const t = i / SR, a = i / n; y[i] *= Math.abs(Math.sin(TAU * 8.5 * t + Math.sin(TAU * 2.2 * t) * 2)) ** 1.5 * Math.min(1, a * 10) * Math.min(1, (1 - a) * 6); }
  return norm(y);
}
function thump(f) {
  const n = N(.4), lp = svf(white(n), 700, .8, 'lp'), y = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * f * (1 + .25 * Math.exp(-t * 40)) / SR; y[i] = Math.sin(ph) * Math.exp(-t * 14) + lp[i] * Math.exp(-t * 50) * 1.4; }
  return norm(y);
}
function pad(freqs, dur, attack = .25) {
  const n = N(dur), y = new Float32Array(n);
  freqs.forEach((f, k) => { for (let i = 0; i < n; i++) { const t = i / SR; y[i] += Math.sin(TAU * f * t + k) * Math.min(1, t / attack) * Math.exp(-t * 1.6); } });
  return norm(y);
}

// ---------- notes ----------
const A3 = 220, A4 = 440, B4 = 493.88, Cs5 = 554.37, E5 = 659.26, Fs5 = 739.99, A5 = 880, B5 = 987.77, Cs6 = 1108.73, E6 = 1318.51, E4 = 329.63, Fs4 = 369.99, Gs4 = 415.3;

// ---------- deterministic re-creation of the animation's pile/cards (matches the html) ----------
const R = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// =================== S1: cold open ===================
place(whoosh(.7, 300, 1200, { peak: .5 }), .05, .16, { rev: .2 });
for (let k = 0; k < 17; k++) place(keyTick(), .47 + k * .044 + rnd() * .012, .12 + rnd() * .05, { pan: (rnd() - .5) * .3, rev: .05 });
for (let k = 0; k < 6; k++) place(keyTick(), 1.46 + k * .065, .1, { pan: .1, rev: .05 });
place(glitch(.55), 1.28, .26, { pan: -.15, rev: .15 });
place(whoosh(.35, 3000, 6000, { peak: .3 }), 1.3, .06);
place(glitch(.6), 2.53, .3, { pan: .15, rev: .15 });
place(pop(A3, .5), 2.95, .18, { rev: .4 });
place(riser(.55), 3.45, .14, { rev: .2 });
place(whoosh(.7, 4000, 600, { peak: .25 }), 3.68, .25, { pan: 0, rev: .3 });

// =================== S2: pile of screenshots ===================
for (let i = 0; i < 18; i++) {
  const col = i % 6, row = Math.floor(i / 6);
  const fx = 960 + (col - 2.5) * 300 + (R(i + 41) - .5) * 140;
  const a = R(i + 91) * Math.PI * 2, sx = 960 + Math.cos(a) * 1500;
  const t0 = 3.95 + i * .15;
  place(whoosh(.45, 900 + rnd() * 600, 2600 + rnd() * 1800, { peak: .55, curve: 3 }), t0 - .05, .085, { pan: panX(sx), pan2: panX(fx), rev: .15 });
  place(thump(110 + rnd() * 60), t0 + .3, .09, { pan: panX(fx), rev: .12 });
}
[5.95, 6.75, 7.55].forEach((t, k) => {
  place(whoosh(.18, 5000, 900, { peak: .7 }), t - .1, .18);
  place(impact(), t, .38 + k * .04, { rev: .35 });
});
place(riser(.65), 8.4, .2, { rev: .3 });
place(whoosh(.65, 500, 5000, { peak: .9, curve: 1 }), 8.42, .22, { rev: .3 });

// =================== S3: reveal ===================
place(sub(2.4), 9.02, .42, { rev: .2 });
place(whoosh(1.1, 5500, 400, { peak: .08 }), 9.0, .22, { rev: .4 });
const pent = [A5, B5, Cs6, E6, Fs5 * 2];
for (let j = 0; j < 25; j++) place(tick(pent[j % 5] * (rnd() > .5 ? 1 : .5)), 9.32 + rnd() * .75, .05 + rnd() * .03, { pan: (rnd() - .5) * .8, rev: .5 });
place(whoosh(.55, 600, 1800, { peak: .4 }), 10.33, .18, { rev: .3 });
place(chime([A3, A4, Cs5, E5, B5], 3.2, 1.3), 10.3, .3, { rev: .55 });
place(whoosh(.5, 2500, 7000, { peak: .35 }), 10.25, .09);
place(whoosh(.4, 3000, 7000, { peak: .3 }), 10.95, .06);
place(whoosh(.8, 700, 4000, { peak: .7, curve: 1 }), 12.45, .2, { rev: .3 });

// =================== S4: upload + understand ===================
place(whoosh(.8, 250, 900, { peak: .35 }), 13.0, .2, { rev: .2 });
place(whoosh(.45, 2500, 7000, { peak: .3 }), 13.35, .07);
place(click(), 14.1, .3, { pan: .45, rev: .1 });
place(whoosh(.95, 600, 1500, { peak: .5 }), 14.08, .14, { pan: .55, pan2: -.15, rev: .15 });
place(thump(95), 15.0, .3, { pan: -.15, rev: .2 });
place(click(), 15.04, .18, { pan: -.15, rev: .1 });
place(scan(1.1), 15.3, .17, { pan: -.15, rev: .3 });
place(whoosh(.45, 2500, 7000, { peak: .3 }), 15.35, .07);
place(whoosh(.45, 2500, 7000, { peak: .3 }), 16.2, .07);
place(pop(E5), 16.4, .2, { rev: .35 }); place(pop(A5), 16.5, .2, { rev: .35 });
for (let i = 0; i < 3; i++) {
  const a = 16.2 + i * .22;
  place(tick(E6, .04), a, .06, { pan: -.15, rev: .3 });
  place(whoosh(.6, 1200, 3500, { peak: .4 }), a + .25, .1, { pan: -.15, pan2: .3, rev: .2 });
  place(pop([Cs5, E5, A5][i]), a + .82, .2, { pan: .3, rev: .3 });
}
place(whoosh(.7, 3500, 500, { peak: .3 }), 19.12, .17, { rev: .3 });

// =================== S5: angles ===================
for (let i = 0; i < 3; i++) place(whoosh(.55, 700, 2600, { peak: .35 }), 19.48 + i * .12, .11, { pan: [-.5, 0, .5][i], rev: .25 });
place(whoosh(.5, 2500, 7000, { peak: .3 }), 20.05, .08);
place(whoosh(1.05, 400, 1100, { peak: .5 }), 21.35, .07, { pan: .6, pan2: -.4, rev: .15 });
place(click(), 22.95, .3, { pan: -.45, rev: .1 });
place(whoosh(.65, 1100, 3200, { peak: .45 }), 23.0, .16, { pan: -.45, rev: .25 });
place(pop(E5), 23.55, .16, { pan: -.4, rev: .4 });
place(whoosh(.7, 500, 1300, { peak: .5 }), 23.75, .13, { pan: -.45, pan2: 0, rev: .2 });
place(whoosh(.35, 1200, 6000, { peak: .5 }), 24.55, .16, { rev: .3 });
place(chime([A5, E6], 1.6, 3), 24.62, .14, { rev: .6 });

// =================== S6: five posts ===================
const PS = [[390, 295], [960, 295], [1530, 295], [532, 720], [1387, 720]];
[E4, Fs4, Gs4, B4, Cs5].forEach((f, i) => {
  const t0 = 24.72 + i * .2;
  place(whoosh(.4, 900, 3000, { peak: .45 }), t0, .09, { pan: 0, pan2: panX(PS[i][0]), rev: .2 });
  place(thump(f / 2), t0 + .22, .2, { pan: panX(PS[i][0]), rev: .25 });
  place(pop(f * 2, .25), t0 + .22, .07, { pan: panX(PS[i][0]), rev: .4 });
});
const TYPE = [[25.27, 84, 62], [25.47, 88, 62], [25.67, 88, 62], [26.07, 190, 95]];
TYPE.forEach(([ts, len, cps], i) => {
  const pn = panX(PS[i === 3 ? 4 : i][0]);
  for (let c = 0; c < len; c += 3) place(keyTick(), ts + c / cps + rnd() * .01, .035 + rnd() * .02, { pan: pn, rev: .05 });
});
[78, 82, 66].forEach((len, j) => { const ts = 25.87 + j * 1.15; for (let c = 0; c < len; c += 3) place(keyTick(), ts + c / 64 + rnd() * .01, .035 + rnd() * .02, { pan: panX(532), rev: .05 }); });
place(whoosh(.75, 3000, 400, { peak: .3 }), 30.28, .17, { rev: .35 });
[[30.55, A5], [30.605, B5], [30.674, Cs6], [30.772, E6]].forEach(([t, f]) => place(tick(f, .08), t, .09, { rev: .45 }));
place(pop(A5, .4), 31.15, .2, { rev: .5 });
place(whoosh(.45, 2500, 7000, { peak: .3 }), 30.62, .08);
place(whoosh(.45, 2500, 7000, { peak: .3 }), 31.2, .08);
place(impact(), 31.86, .26, { rev: .45 });
place(chime([A4, E5, A5, Cs6], 2.2, 1.8), 31.88, .2, { rev: .6 });
place(whoosh(.6, 900, 5000, { peak: .6 }), 32.65, .15, { rev: .3 });

// =================== S7: tone + write like me ===================
place(whoosh(.8, 250, 900, { peak: .35 }), 33.05, .18, { rev: .2 });
place(whoosh(.45, 2500, 7000, { peak: .3 }), 33.2, .07);
[[34.3, 34.75, -.2], [35.1, 35.55, .1], [35.9, 36.35, .4]].forEach(([a, b, pn]) => {
  place(whoosh(b - a + .05, 700, 1500, { peak: .5 }), a, .08, { pan: pn - .25, pan2: pn, rev: .1 });
  place(click(), b - .02, .2, { pan: pn, rev: .15 });
});
[34.7, 35.5, 36.3].forEach(t => place(whoosh(.4, 1800, 5000, { peak: .35 }), t - .3, .07));
place(whoosh(.45, 2500, 7000, { peak: .3 }), 36.55, .08);
place(pop(Cs5), 36.55, .13, { rev: .3 });
place(click(), 36.95, .28, { rev: .1 });
place(pop(E5), 37.0, .16, { rev: .4 }); place(pop(A5), 37.1, .16, { rev: .4 });
place(whoosh(.5, 1800, 5500, { peak: .3 }), 37.15, .09);
place(scribble(.7), 37.78, .11, { pan: -.3, pan2: .1, rev: .1 });
place(whoosh(.6, 3500, 500, { peak: .3 }), 38.58, .17, { rev: .3 });

// =================== S8: close ===================
for (let i = 0; i < 5; i++) place(whoosh(.45, 1200, 4000, { peak: .3 }), 38.85 + i * .02, .05, { pan: 0, pan2: Math.cos(-Math.PI / 2 + i * Math.PI * 2 / 5) * .8, rev: .2 });
place(sub(2.2), 39.27, .4, { rev: .2 });
place(whoosh(1.0, 5000, 400, { peak: .1 }), 39.25, .2, { rev: .4 });
place(whoosh(.55, 500, 4500, { peak: .95, curve: 1 }), 39.5, .2, { rev: .3 });
for (let j = 0; j < 25; j++) place(tick(pent[j % 5]), 39.86 + rnd() * .55, .045 + rnd() * .03, { pan: (rnd() - .5) * .6, rev: .5 });
place(whoosh(.45, 1500, 600, { peak: .4 }), 40.55, .14, { pan: 0, pan2: -.7, rev: .2 });
place(whoosh(.95, 500, 4200, { peak: .55, curve: 2.2 }), 40.95, .32, { pan: -.85, pan2: .95, rev: .35 });
place(whoosh(.6, 2500, 8000, { peak: .5 }), 41.15, .08, { pan: -.5, pan2: .9 });
place(chime([A3, E4, A4, Cs5, E5, B5], 3.4, 1.0), 41.78, .32, { rev: .6 });
place(sub(2.5), 41.76, .32, { rev: .2 });
place(pop(A4, .3), 42.38, .18, { rev: .4 });
place(whoosh(.5, 900, 2600, { peak: .4 }), 42.33, .09, { rev: .2 });
[43.0, 43.55, 44.1].forEach((t, k) => place(pad([A4, E5], 1.2, .05), t, .05 - k * .012, { rev: .5 }));
place(whoosh(.85, 3000, 8000, { peak: .5 }), 43.3, .05, { pan: -.4, pan2: .4, rev: .3 });
for (let j = 0; j < 6; j++) place(tick([E6, Cs6, A5 * 2, B5 * 2, E6, Fs5 * 2][j], .06), 43.35 + j * .1, .035, { pan: -.4 + j * .16, rev: .6 });

// ---------- reverb (Schroeder/Freeverb style) ----------
function reverb(x, off) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map(d => ({ b: new Float32Array(d + off), i: 0, s: 0 }));
  const aps = [556, 441, 341, 225].map(d => ({ b: new Float32Array(d + off), i: 0 }));
  const y = new Float32Array(x.length), fb = .84, damp = .3;
  for (let n = 0; n < x.length; n++) {
    let o = 0;
    for (const c of combs) { const v = c.b[c.i]; c.s = v * (1 - damp) + c.s * damp; c.b[c.i] = x[n] + c.s * fb; c.i = (c.i + 1) % c.b.length; o += v; }
    o /= combs.length;
    for (const a of aps) { const v = a.b[a.i]; a.b[a.i] = o + v * .5; a.i = (a.i + 1) % a.b.length; o = v - o; }
    y[n] = o;
  }
  return y;
}
const wl = reverb(sendL, 0), wr = reverb(sendR, 23);

// ---------- master ----------
const L = new Float32Array(LEN), Rr = new Float32Array(LEN);
let peak = 0;
for (let i = 0; i < LEN; i++) {
  L[i] = dryL[i] + wl[i] * .9; Rr[i] = dryR[i] + wr[i] * .9;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(Rr[i]));
}
const g = Math.pow(10, -3 / 20) / peak;
const fadeOut = N(1.2);
const buf = Buffer.alloc(44 + LEN * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + LEN * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(LEN * 4, 40);
for (let i = 0; i < LEN; i++) {
  const f = i > LEN - fadeOut ? (LEN - i) / fadeOut : 1;
  const sat = v => Math.tanh(v * g * 1.1) / Math.tanh(1.1);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sat(L[i]) * f)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sat(Rr[i]) * f)) * 32767), 46 + i * 4);
}
fs.writeFileSync(process.argv[2] || 'sfx.wav', buf);
console.log('peak before gain', peak.toFixed(3), 'gain', g.toFixed(3));
