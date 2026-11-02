// Synthesizes the reel's soundtrack (music + sound effects), timed to ideabird-reel.html.
// usage: node reel-audio.mjs <out.wav>
import fs from 'node:fs';

const SR = 48000, DUR = 16.5, LEN = Math.round(SR * DUR), TAU = Math.PI * 2;
const N = s => Math.max(1, Math.round(s * SR));
let seed = 21;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const p = (t, a, b) => clamp((t - a) / (b - a));

const L = new Float32Array(LEN), R = new Float32Array(LEN), sendL = new Float32Array(LEN), sendR = new Float32Array(LEN);
function place(x, t, gain, { pan = 0, pan2 = pan, rev = .15 } = {}) {
  const s0 = Math.round(t * SR);
  for (let i = 0; i < x.length; i++) {
    const j = s0 + i; if (j < 0 || j >= LEN) continue;
    const pn = pan + (pan2 - pan) * (i / x.length), a = (pn + 1) * Math.PI / 4, v = x[i] * gain;
    L[j] += v * Math.cos(a); R[j] += v * Math.sin(a); sendL[j] += v * Math.cos(a) * rev; sendR[j] += v * Math.sin(a) * rev;
  }
}
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
function norm(x) { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); if (m) for (let i = 0; i < x.length; i++) x[i] /= m; return x; }

// ---------- sounds ----------
function whoosh(dur, f0, f1, peak = .45) {
  const n = N(dur), y = svf(white(n), i => f0 * Math.pow(f1 / f0, i / n), .5);
  for (let i = 0; i < n; i++) { const a = i / n; y[i] *= a < peak ? (a / peak) ** 2 : (1 - (a - peak) / (1 - peak)) ** 1.6; }
  return norm(y);
}
function tone(f, dur, { type = 'sine', dec = 20, att = .002, bend = 0 } = {}) {
  const n = N(dur), y = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; ph += (f * (1 + bend * Math.exp(-t * 60))) / SR; ph -= Math.floor(ph);
    const w = type === 'square' ? (ph < .5 ? 1 : -1) : type === 'saw' ? 2 * ph - 1 : Math.sin(TAU * ph);
    y[i] = w * Math.min(1, t / att) * Math.exp(-t * dec);
  }
  return y;
}
function kick(big = false) {
  const n = N(big ? 1 : .4), y = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * (46 + 130 * Math.exp(-t * (big ? 20 : 32))) / SR; y[i] = Math.tanh(Math.sin(ph) * 1.7) * Math.exp(-t * (big ? 3 : 8)) + noise() * Math.exp(-t * 900) * .3; }
  return y;
}
function hat(open = false) { const n = N(open ? .25 : .05), y = svf(white(n), 8000, .6, 'hp'); for (let i = 0; i < n; i++) y[i] *= Math.exp(-(i / SR) * (open ? 14 : 80)); return y; }
function clap() {
  const n = N(.3), y = svf(white(n), 1500, .5); for (let i = 0; i < n; i++) { const t = i / SR; let e = Math.exp(-Math.max(0, t - .02) * 24); for (const o of [0, .008, .016]) if (t >= o && t < o + .008) e = Math.max(e, Math.exp(-(t - o) * 300)); y[i] *= e * 2.2; }
  return y;
}
function stamp() {
  const n = N(.5), y = new Float32Array(n), slap = svf(white(n), 2200, .9); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * (60 + 90 * Math.exp(-t * 30)) / SR; y[i] = Math.sin(ph) * Math.exp(-t * 9) + slap[i] * Math.exp(-t * 60) * 2.5; }
  return norm(y);
}
function dun(m, dur) {
  const n = N(dur), y = new Float32Array(n);
  for (const mm of [m, m + 12, m + 19]) for (const d of [-.08, .08]) { let ph = rnd(); const inc = hz(mm + d) / SR; for (let i = 0; i < n; i++) { ph += inc; ph -= Math.floor(ph); y[i] += 2 * ph - 1; } }
  const z = svf(y, i => 300 + 2400 * Math.exp(-(i / SR) * 4), .8, 'lp'); let s = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; s += TAU * hz(m - 12) / SR; z[i] = z[i] * .5 + Math.sin(s) * 1.2; z[i] *= Math.min(1, t * 200) * Math.exp(-t * 1.6) * (1 + .15 * Math.sin(TAU * 7 * t)); }
  return norm(z);
}
function chime(fs_, dur = 2, dec = 2.5) {
  const n = N(dur), y = new Float32Array(n);
  fs_.forEach((f, k) => { for (const [m, a] of [[1, 1], [2, .3], [3.01, .12]]) for (let i = 0; i < n; i++) { const t = i / SR; y[i] += Math.sin(TAU * f * m * t + k) * a * Math.min(1, t * 400) * Math.exp(-t * dec * m); } });
  return norm(y);
}
function scratch() {
  // record scratch: a fast pitch dip down then up on a buzzy source
  const n = N(.42), y = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const a = i / n, sp = a < .55 ? 1 - a / .55 * 1.6 : -.6 + (a - .55) / .45 * 1.9; ph += Math.abs(sp) * 220 / SR; ph -= Math.floor(ph); y[i] = ((2 * ph - 1) * .6 + noise() * .4) * Math.min(1, Math.abs(sp) * 1.5); }
  return norm(svf(y, 1800, .5));
}
function kaching() {
  const n = N(1.2), y = new Float32Array(n), c = svf(white(n), 5000, .4);
  for (let i = 0; i < n; i++) { const t = i / SR; y[i] = c[i] * Math.exp(-t * 40) * .8 + (t > .06 ? Math.sin(TAU * 2637 * t) * Math.exp(-(t - .06) * 5) * .6 + Math.sin(TAU * 3520 * t) * Math.exp(-(t - .06) * 4) * .5 : 0) + Math.sin(TAU * 1318.5 * t) * Math.exp(-t * 6) * .4; }
  return norm(y);
}
function heartbeat() { const a = kick(), y = new Float32Array(N(.6)); for (let i = 0; i < a.length && i < y.length; i++) { y[i] += a[i]; const j = i + N(.18); if (j < y.length) y[j] += a[i] * .7; } return norm(svf(y, 300, .7, 'lp')); }
function drone(m, dur) {
  const n = N(dur), y = new Float32Array(n);
  for (const mm of [m, m + 7, m + 12]) for (const d of [-.1, .1]) { let ph = rnd(); for (let i = 0; i < n; i++) { ph += hz(mm + d) / SR; ph -= Math.floor(ph); y[i] += 2 * ph - 1; } }
  const z = svf(y, 500, .9, 'lp');
  for (let i = 0; i < n; i++) { const a = i / n; z[i] *= Math.min(1, a * 6) * Math.min(1, (1 - a) * 8); }
  return norm(z);
}
function blip(f, lowVoice = false) { return tone(f, .07, { type: 'square', dec: lowVoice ? 30 : 45, bend: .3 }); }
function poof() { const n = N(.35), y = svf(white(n), i => 3000 * Math.exp(-i / n * 2.5), .5); for (let i = 0; i < n; i++) y[i] *= Math.exp(-(i / SR) * 12); return norm(y); }

// ---------- S1: scroll + count-up + ticking ----------
place(whoosh(1.5, 400, 2400, .2), 0, .12, { pan: .2, pan2: -.2 });
for (let k = 0; k < 4; k++) place(tone(1800, .05, { dec: 120 }), k * .4, .12, { rev: .1 });
for (let t = .05, k = 0; t < 1.4; k++) { place(tone(2600 + (k % 3) * 300, .025, { dec: 260 }), t, .05); t += .025 + .1 * p(t, .3, 1.4) ** 2; }
place(drone(30, 3.7), 0, .12, { rev: .3 });

// ---------- S2: dun, DUNNN, bird ----------
place(dun(42, 1.0), 1.6, .42, { rev: .35 });
place(kick(true), 1.6, .5);
place(dun(41, 1.7), 1.96, .5, { rev: .4 });
place(whoosh(.45, 700, 2600), 1.92, .18, { pan: .8, pan2: .3 });
place(tone(660, .2, { dec: 22, bend: .8 }), 2.42, .2, { pan: .3, rev: .3 });
place(tone(880, .2, { dec: 22, bend: .6 }), 2.25, .14, { pan: -.2, rev: .3 });
for (let c = 0; c < 46; c += 2) place(blip([620, 740, 560, 830, 700][c % 5] * (0.95 + rnd() * .1)), 2.3 + c / 50, .08, { pan: .3 });
place(whoosh(.35, 3000, 700, .3), 3.42, .14);

// ---------- S3: beat drop on the stamps, record scratch ----------
const BEAT = .425, G0 = 3.7;
for (let k = 0; k < 8; k++) {
  const t = G0 + k * BEAT;
  if (t < 6.3) { place(kick(), t, .55); place(hat(), t + BEAT / 2, .1, { pan: .2 }); }
  if (k % 2 === 0) place(whoosh(.3, 900, 3800, .5), t - .06, .14, { pan: .7, pan2: -.4 });
}
[[3.7, 42], [4.55, 45], [5.4, 47], [6.25, 40]].forEach(([t, m]) => { if (t < 6.3) for (let s = 0; s < 4; s++) place(tone(hz(m - 12 + (s === 3 ? 12 : 0)), .2, { type: 'saw', dec: 9 }), t + s * BEAT / 2, .07); });
[4.12, 4.97, 5.82, 6.67].forEach((t, k) => { place(stamp(), t, .5, { rev: .3 }); place(clap(), t, .2, { rev: .3 }); });
place(scratch(), 6.22, .3);
place(dun(38, 1.0), 6.67, .25, { rev: .4 });

// ---------- S4: IdeaBird app, timer and ka-ching ----------
place(whoosh(.6, 3200, 500, .3), 7.0, .16);
place(whoosh(.55, 300, 1300, .4), 7.05, .14);
place(tone(1320, .2, { dec: 25, bend: .5 }), 7.5, .14, { pan: -.4, rev: .3 });
{ const n = N(.8), y = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { const a = i / n; ph += (500 + 900 * a) / SR; y[i] = Math.sin(TAU * ph) * Math.sin(Math.PI * a); } place(y, 7.8, .1, { rev: .3 }); }
for (let k = 0; k < 12; k++) { const t = 7.25 + k * BEAT; if (t < 11.4) { place(kick(), t, .4); place(hat(), t + BEAT / 2, .09, { pan: -.2 }); if (k % 2) place(clap(), t, .14); } }
for (let k = 0; k < 7; k++) place(tone(1500, .04, { dec: 140 }), 7.65 + (k + 1) * (10.55 - 7.65) / 7 - .02, .12, { pan: .6 });
[64, 66, 68, 71, 73].forEach((m, i) => { const t = 8.7 + i * .38; place(tone(hz(m), .25, { dec: 16, bend: .5 }), t, .14, { rev: .3 }); place(whoosh(.25, 1200, 3000), t - .04, .06); });
place(kaching(), 10.55, .45, { pan: .5, rev: .3 });

// ---------- S5: music cuts, the threat ----------
place(drone(28, 2.6), 11.45, .2, { rev: .3 });
place(whoosh(.55, 4000, 400, .7), 11.55, .2);
place(kick(true), 12.02, .55);
place(tone(440, .2, { dec: 20, bend: .6 }), 11.58, .12, { rev: .3 });
for (let t = 12.1; t < 13.9; t += .72) place(heartbeat(), t, .4);
for (let c = 0; c < 47; c += 2) place(blip([300, 360, 270, 330, 390][c % 5] * (0.95 + rnd() * .1), true), 12.08 + c / 34, .1);
[12.35, 13.4].forEach(t => place(svf(white(N(.4)).map((v, i) => v * Math.abs(Math.sin(i / SR * TAU * 45)) * Math.exp(-i / SR * 6)), 900, .5), t, .14));
[12.95, 13.3, 13.65].forEach((t, k) => { place(poof(), t, .2, { pan: [-.3, .4, -.5][k] }); place(tone([523, 466, 392][k], .25, { dec: 10, type: 'square' }), t + .02, .05); });

// ---------- S6: end card ----------
place(whoosh(.75, 600, 6000, .85), 13.4, .18);
place(kick(true), 13.97, .6);
place(chime([hz(69), hz(73), hz(76), hz(81)], 2.6, 1.4), 14.15, .3, { rev: .6 });
place(tone(hz(57), 2.3, { type: 'saw', dec: 1.3 }), 14.15, .05);
place(tone(hz(81), .25, { dec: 18, bend: .5 }), 14.75, .14, { rev: .4 });
for (let k = 0; k < 5; k++) { const t = 14.15 + k * BEAT; place(kick(), t, .3); place(hat(), t + BEAT / 2, .08); }

// ---------- reverb + master ----------
function reverb(x, off) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map(d => ({ b: new Float32Array(d + off), i: 0, s: 0 }));
  const aps = [556, 441, 341].map(d => ({ b: new Float32Array(d + off), i: 0 }));
  const y = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let o = 0;
    for (const c of combs) { const v = c.b[c.i]; c.s = v * .7 + c.s * .3; c.b[c.i] = x[n] + c.s * .8; c.i = (c.i + 1) % c.b.length; o += v; }
    o /= combs.length;
    for (const a of aps) { const v = a.b[a.i]; a.b[a.i] = o + v * .5; a.i = (a.i + 1) % a.b.length; o = v - o; }
    y[n] = o;
  }
  return y;
}
const wl = reverb(sendL, 0), wr = reverb(sendR, 23);
let peak = 0;
for (let i = 0; i < LEN; i++) { L[i] += wl[i]; R[i] += wr[i]; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
const g = Math.pow(10, -1.5 / 20) / peak, fade = N(.5);
const buf = Buffer.alloc(44 + LEN * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + LEN * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(LEN * 4, 40);
for (let i = 0; i < LEN; i++) {
  const f = i > LEN - fade ? (LEN - i) / fade : 1;
  buf.writeInt16LE(Math.round(clamp(Math.tanh(L[i] * g * 1.3) / Math.tanh(1.3) * f, -1, 1) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(clamp(Math.tanh(R[i] * g * 1.3) / Math.tanh(1.3) * f, -1, 1) * 32767), 46 + i * 4);
}
fs.writeFileSync(process.argv[2] || 'reel-audio.wav', buf);
console.log('peak', peak.toFixed(3));
