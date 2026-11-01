// Synthesizes the launch film's music bed, arranged to the scenes in ideabird-launch.html.
// 120 BPM so every scene boundary (4, 9, 13, 20, 25, 33, 39s) lands on a beat. Key: A major
// (intro on F#m), matching the A-major-pentatonic chimes in sfx.mjs.
// usage: node music.mjs <out.wav>
import fs from 'node:fs';

const SR = 48000, DUR = 45, LEN = SR * DUR, TAU = Math.PI * 2;
const BEAT = .5, BAR = 2, S16 = BEAT / 4;
const N = s => Math.max(1, Math.round(s * SR));
let seed = 11;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const p = (t, a, b) => clamp((t - a) / (b - a));

// ---------- buses ----------
const bus = () => ({ L: new Float32Array(LEN), R: new Float32Array(LEN) });
const drums = bus(), music = bus(), send = bus(), dly = bus();
function add(b, x, t, gain, pan = 0) {
  const s0 = Math.round(t * SR), a = (pan + 1) * Math.PI / 4, gl = Math.cos(a) * gain, gr = Math.sin(a) * gain;
  for (let i = 0; i < x.length; i++) { const j = s0 + i; if (j < 0 || j >= LEN) continue; b.L[j] += x[i] * gl; b.R[j] += x[i] * gr; }
}
function svf(x, fc, damp = .7, mode = 'lp') {
  let low = 0, band = 0; const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const f = 2 * Math.sin(Math.PI * Math.min(typeof fc === 'function' ? fc(i) : fc, SR / 6.5) / SR);
    low += f * band; const high = x[i] - low - damp * band; band += f * high;
    y[i] = mode === 'bp' ? band : mode === 'lp' ? low : high;
  }
  return y;
}
const white = n => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = noise(); return x; };

// ---------- instruments ----------
function kick(big = false) {
  const n = N(big ? 1.2 : .45), y = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += TAU * (45 + 120 * Math.exp(-t * (big ? 22 : 30))) / SR;
    y[i] = Math.tanh(Math.sin(ph) * 1.6) * Math.exp(-t * (big ? 2.6 : 7.5)) + noise() * Math.exp(-t * 900) * .3;
  }
  return y;
}
function clap() {
  const n = N(.35), bp = svf(white(n), 1500, .5, 'bp'), y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let e = Math.exp(-Math.max(0, t - .022) * 22);
    for (const o of [0, .008, .016]) if (t >= o && t < o + .008) e = Math.max(e, Math.exp(-(t - o) * 300));
    y[i] = bp[i] * e * 2.2;
  }
  return y;
}
function hat(open = false) {
  const n = N(open ? .3 : .06), hp = svf(white(n), 7500, .6, 'hp'), y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = hp[i] * Math.exp(-(i / SR) * (open ? 13 : 75));
  return y;
}
function snare() {
  const n = N(.18), bp = svf(white(n), 2200, .8, 'bp'), y = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * 190 / SR; y[i] = (bp[i] * 1.6 + Math.sin(ph) * .4) * Math.exp(-t * 28); }
  return y;
}
function crash() {
  const n = N(2.5), hp = svf(white(n), 6000, .5, 'hp'), y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = hp[i] * Math.exp(-(i / SR) * 1.7);
  return y;
}
// detuned saw stack, optional per-sample cutoff function
function saws(midiNotes, dur, { detune = .12, voices = 3, cutoff = 2000, attack = .05, release = .3, damp = .9 } = {}) {
  const n = N(dur), x = new Float32Array(n);
  for (const m of midiNotes) for (let v = 0; v < voices; v++) {
    const f = hz(m + (v - (voices - 1) / 2) * detune), inc = f / SR; let ph = rnd();
    for (let i = 0; i < n; i++) { ph += inc; ph -= Math.floor(ph); x[i] += 2 * ph - 1; }
  }
  const y = svf(x, cutoff, damp, 'lp');
  const rs = n - N(release);
  for (let i = 0; i < n; i++) y[i] *= Math.min(1, i / SR / attack) * (i > rs ? (n - i) / (n - rs) : 1) / (midiNotes.length * voices);
  return y;
}
function pluck(m, bright = 1) {
  const n = N(.32), y = new Float32Array(n), f = hz(m); let ph = 0, ph2 = .3;
  for (let i = 0; i < n; i++) { ph += f / SR; ph2 += f * 1.006 / SR; ph -= Math.floor(ph); ph2 -= Math.floor(ph2); y[i] = (ph < .5 ? 1 : -1) * .5 + (2 * ph2 - 1) * .5; }
  const z = svf(y, i => 300 + 4200 * bright * Math.exp(-(i / SR) * 18), .7, 'lp');
  for (let i = 0; i < n; i++) z[i] *= Math.exp(-(i / SR) * 11) * Math.min(1, i / 60);
  return z;
}
function bassNote(m, dur, cutoff = 700) {
  const n = N(dur), y = new Float32Array(n), f = hz(m); let ph = 0, s = 0;
  for (let i = 0; i < n; i++) { ph += f / SR; ph -= Math.floor(ph); s += TAU * f / 2 / SR; y[i] = (2 * ph - 1) * .6 + Math.sin(s * 2) * .7; }
  const z = svf(y, i => cutoff * (.5 + .9 * Math.exp(-(i / SR) * 9)), .8, 'lp');
  for (let i = 0; i < n; i++) { const t = i / SR; z[i] *= Math.min(1, t * 400) * Math.min(1, (dur - t) * 60); }
  return z;
}
function sweep(dur, up = true) {
  const n = N(dur), y = svf(white(n), i => up ? 400 * Math.pow(30, i / n) : 9000 * Math.pow(1 / 30, i / n), .5, 'bp');
  for (let i = 0; i < n; i++) { const a = i / n; y[i] *= up ? a ** 2.2 : (1 - a) ** 2; }
  return y;
}

// ---------- harmony ----------
const CH = {
  Fsm: { bass: 42, pad: [54, 57, 61, 64], arp: [66, 69, 73, 76, 78, 76, 73, 69] },
  A: { bass: 45, pad: [57, 61, 64, 68, 71], arp: [69, 73, 76, 80, 81, 80, 76, 73] },
  D: { bass: 38, pad: [57, 61, 62, 66], arp: [69, 74, 78, 81, 85, 81, 78, 74] },
  E: { bass: 40, pad: [56, 59, 64, 66], arp: [68, 71, 76, 78, 80, 78, 76, 71] },
};
// groove chord per 2s bar from 13s: E F#m D A, so the 25s peak lands on D
const PROG = ['E', 'Fsm', 'D', 'A'];
const chordAt = t => t < 9 ? 'Fsm' : t < 11 ? 'A' : t < 13 ? 'D' : t < 39 ? PROG[Math.floor((t - 13) / BAR) % 4] : t < 41.75 ? 'Fsm' : 'A';

// ---------- arrangement ----------
const kicks = [];
const inGroove = t => (t >= 13 && t < 30.3) || (t >= 32 && t < 38.5);

// intro (0–8.45): dark F#m pad + tense pulse
add(music, saws(CH.Fsm.pad, 8.6, { cutoff: i => 450 + 1400 * (i / SR / 8.6) ** 2, attack: 1.5, release: .15 }), 0, .55);
for (let t = 0; t < 8.45; t += BEAT / 2) {
  const open = p(t, 0, 8.4);
  add(music, bassNote(t % 1 < .5 ? 30 : 42, .22, 220 + 900 * open), t, .5 * Math.min(1, t / 1.5 + .25), 0);
}
for (let t = 4; t < 8.4; t += S16) add(drums, hat(), t, .05 + .1 * p(t, 4, 8.4) * (Math.round(t / S16) % 2 ? .6 : 1), .25);
add(music, sweep(1.1), 7.35, .1);

// drop (9–13): big kick + sub, bright pad, half-time
add(drums, kick(true), 9, 1); kicks.push(9);
add(drums, crash(), 9, .22);
[[9, 'A', 2], [11, 'D', 2]].forEach(([t, c, d]) => add(music, saws(CH[c].pad, d + .3, { cutoff: 2600, attack: .02, release: .3, voices: 4, detune: .15 }), t, .6));
add(music, bassNote(33, 2, 300), 9, .6);
add(music, bassNote(38, 2, 300), 11, .5);
for (let t = 9.5; t < 13; t += S16 * 2) { const c = CH[chordAt(t)]; const k = Math.round((t - 9) / (S16 * 2)); add(send, pluck(c.arp[k % 8] + 12, .6), t, .1 * p(t, 9.3, 10.5), k % 2 ? .5 : -.5); }
[11, 12].forEach(t => { add(drums, kick(), t, .7); kicks.push(t); });
for (let t = 12; t < 13; t += S16) add(drums, snare(), t, .05 + .25 * p(t, 12, 13), 0);
add(music, sweep(1.0), 12.0, .14);

// groove (13–39)
for (let t = 13; t < 39 - 1e-6; t += BEAT) {
  if (inGroove(t)) { add(drums, kick(), t, .85); kicks.push(t); }
  const bar = (t - 13) % BAR;
  if (t >= 15 && inGroove(t) && (Math.abs(bar - .5) < 1e-6 || Math.abs(bar - 1.5) < 1e-6)) add(drums, clap(), t, .42, 0);
}
for (let t = 13; t < 39 - 1e-6; t += S16) {
  const k = Math.round((t - 13) / S16), off8 = k % 4 === 2;
  const peak = t >= 25 && t < 30.3;
  if (off8 && t < 38.5) add(drums, hat(peak), t, peak ? .13 : .16, .2);
  else if (t >= 20 && inGroove(t) && k % 2 === 1) add(drums, hat(), t, .05 + (peak ? .03 : 0), -.25);
}
// bass: pumping 8ths
for (let t = 13; t < 39 - 1e-6; t += BEAT / 2) {
  const c = CH[chordAt(t)], k = Math.round((t - 13) / (BEAT / 2));
  const breakdown = t >= 30.3 && t < 32;
  const m = c.bass + (k % 4 === 3 ? 12 : 0);
  add(music, bassNote(m, .22, breakdown ? 260 : 650 + 500 * p(t, 13, 25)), t, breakdown ? .35 : .55);
}
// pads per bar
for (let t = 13; t < 39 - 1e-6; t += BAR) {
  const c = CH[chordAt(t)], peak = t >= 25 && t < 31;
  add(music, saws(c.pad, BAR + .25, { cutoff: peak ? 3200 : 1500 + 900 * p(t, 13, 25), attack: .08, release: .25, voices: 3 }), t, peak ? .5 : .42);
}
// arp 16ths with ping-pong delay send
for (let t = 13; t < 39 - 1e-6; t += S16) {
  const c = CH[chordAt(t)], k = Math.round((t - 13) / S16);
  const breakdown = t >= 30.3 && t < 31.85;
  const bright = breakdown ? .25 : .35 + .65 * p(t, 13, 25) * (t > 33 && t < 36 ? .7 : 1);
  const g = (k % 4 === 0 ? .17 : .11) * (t < 14 ? p(t, 13, 14) : 1) * (breakdown ? .6 : 1);
  add(send, pluck(c.arp[k % 8], bright), t, g, (k % 2 ? .35 : -.35));
}
// peak stabs (25–30.3): syncopated chord hits
for (let t = 25; t < 30.3; t += BAR) for (const o of [0, .75, 1.25]) {
  const c = CH[chordAt(t + o)];
  add(music, saws(c.pad.map(m => m + 12), .22, { cutoff: 4800, attack: .004, release: .12, voices: 3, detune: .18 }), t + o, .4, o === .75 ? -.3 : .3);
}
// builds
for (let t = 24; t < 25; t += S16 / (t > 24.5 ? 2 : 1)) add(drums, snare(), t, .06 + .3 * p(t, 24, 25), 0);
add(music, sweep(1.2), 23.8, .16);
add(drums, crash(), 25, .2); add(drums, kick(true), 25, .55);
add(music, sweep(1.4, false), 30.3, .08);
add(drums, crash(), 32, .14);
for (let t = 38; t < 38.5; t += S16) add(drums, snare(), t, .08 + .2 * p(t, 38, 38.5), 0);
add(music, sweep(.6), 38.4, .12);

// breakdown (39–41.75): F#m swell under the bird flight
add(music, saws(CH.Fsm.pad, 2.9, { cutoff: i => 700 + 2200 * (i / SR / 2.9) ** 2, attack: .6, release: .1, voices: 4 }), 39, .55);
add(music, bassNote(30, 2.75, 200), 39, .45);
add(music, sweep(1.6), 40.15, .16);

// final: A major hit, then let it ring out to silence
add(drums, kick(true), 41.75, .95); kicks.push(41.75);
add(drums, crash(), 41.75, .2);
add(music, saws([...CH.A.pad, 45, 52], 3.25, { cutoff: i => 3800 * Math.exp(-(i / SR) * .7) + 400, attack: .01, release: 1.6, voices: 4, detune: .14 }), 41.75, .75);
add(music, bassNote(33, 2.6, 260), 41.75, .5);
CH.A.arp.concat(CH.A.arp.map(m => m + 12)).slice(0, 12).forEach((m, k) => add(send, pluck(m, .8 - k * .04), 41.75 + k * S16, .12 * (1 - k / 14), k % 2 ? .4 : -.4));

// ---------- effects ----------
// ping-pong dotted-8th delay on the send bus
function pingpong(src, time = .375, fb = .38, mix = .32) {
  const d = N(time), oL = new Float32Array(LEN), oR = new Float32Array(LEN);
  const lineL = new Float32Array(LEN), lineR = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const outL = i >= d ? lineL[i - d] : 0, outR = i >= d ? lineR[i - d] : 0;
    lineL[i] = (src.L[i] + src.R[i]) * .5 + outR * fb;
    lineR[i] = outL;
    oL[i] = src.L[i] + outL * mix; oR[i] = src.R[i] + outR * mix;
  }
  return { L: oL, R: oR };
}
function reverb(x, off) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map(d => ({ b: new Float32Array(d + off), i: 0, s: 0 }));
  const aps = [556, 441, 341, 225].map(d => ({ b: new Float32Array(d + off), i: 0 }));
  const y = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let o = 0;
    for (const c of combs) { const v = c.b[c.i]; c.s = v * .7 + c.s * .3; c.b[c.i] = x[n] + c.s * .86; c.i = (c.i + 1) % c.b.length; o += v; }
    o /= combs.length;
    for (const a of aps) { const v = a.b[a.i]; a.b[a.i] = o + v * .5; a.i = (a.i + 1) % a.b.length; o = v - o; }
    y[n] = o;
  }
  return y;
}
const arp = pingpong(send);

// sidechain pump from the kicks, plus ducking under the big SFX impacts
const pump = new Float32Array(LEN).fill(1);
for (const tk of kicks) { const s0 = Math.round(tk * SR); for (let i = 0; i < N(.3); i++) { const j = s0 + i; if (j < LEN) pump[j] = Math.min(pump[j], 1 - .6 * Math.exp(-i / SR / .07)); } }
const duck = new Float32Array(LEN).fill(1);
for (const ts of [5.95, 6.75, 7.55, 31.86]) { const s0 = Math.round(ts * SR); for (let i = 0; i < N(.6); i++) { const j = s0 + i; if (j < LEN) duck[j] = Math.min(duck[j], 1 - .5 * Math.exp(-i / SR / .2)); } }
// silence just before the drop at 9s
for (let i = 0; i < LEN; i++) { const t = i / SR; if (t > 8.45 && t < 9) duck[i] *= 1 - p(t, 8.45, 8.55); }

const verbIn = new Float32Array(LEN);
for (let i = 0; i < LEN; i++) verbIn[i] = (music.L[i] + music.R[i] + arp.L[i] + arp.R[i]) * .5 * .25 + (drums.L[i] + drums.R[i]) * .03;
const wl = reverb(verbIn, 0), wr = reverb(verbIn, 23);

const L = new Float32Array(LEN), R = new Float32Array(LEN);
let peak = 0;
for (let i = 0; i < LEN; i++) {
  const t = i / SR, pm = pump[i];
  const tail = t > 43.2 ? 1 - p(t, 43.2, 44.9) : 1;
  L[i] = ((music.L[i] + arp.L[i]) * pm + drums.L[i] + wl[i] * .8) * duck[i] * tail;
  R[i] = ((music.R[i] + arp.R[i]) * pm + drums.R[i] + wr[i] * .8) * duck[i] * tail;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const g = Math.pow(10, -2 / 20) / peak;
const buf = Buffer.alloc(44 + LEN * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + LEN * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(LEN * 4, 40);
for (let i = 0; i < LEN; i++) {
  buf.writeInt16LE(Math.round(clamp(Math.tanh(L[i] * g * 1.2) / Math.tanh(1.2), -1, 1) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(clamp(Math.tanh(R[i] * g * 1.2) / Math.tanh(1.2), -1, 1) * 32767), 46 + i * 4);
}
fs.writeFileSync(process.argv[2] || 'music.wav', buf);
console.log('peak', peak.toFixed(3));
