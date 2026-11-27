// The demo song: a 124 BPM house track made in code, so anyone can try the app without music files of their own
// (and with no rights to worry about). Computed in well under a second, then handed over as a WAV file like any
// song you add.

export const DEMO_ID = "demo";                  // its playlist id: it isn't stored, it is made again when needed
export const DEMO_NAME = "Air DJ demo (124 BPM).wav";

const BPM = 124, BEAT = 60 / BPM, BAR = 4 * BEAT, SR = 44100;
// A minor: Am - F - C - G, one chord a bar. Roots for the bass (Hz), chord tones for stabs, pad and arp.
const ROOTS = [55, 43.65, 65.41, 49];
const CHORDS = [[220, 261.63, 329.63], [174.61, 220, 261.63], [196, 261.63, 329.63], [196, 246.94, 293.66]];
// 48 bars in 8-bar sections: which parts play
const SECTIONS = [
  { kick: 1, hat: 1 },                                        // intro
  { kick: 1, hat: 1, bass: 1 },
  { kick: 1, hat: 1, bass: 1, clap: 1, stab: 1 },
  { pad: 1, arp: 1 },                                         // breakdown: no drums
  { kick: 1, hat: 1, bass: 1, clap: 1, stab: 1, arp: 1 },     // drop
  { kick: 1, hat: 1, bass: 1, clap: 1, arp: 1 },
];
const BARS = SECTIONS.length * 8;

// Each sound is made once as samples (cached), then added onto the beat grid: fast, and the same song every time.
export async function makeDemoSong() {
  const n = Math.ceil((BARS * BAR + 1.5) * SR), L = new Float32Array(n), R = new Float32Array(n);
  let seed = 1;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;   // fixed noise: same song every time
  const cache = new Map(), once = (key, make) => cache.get(key) || cache.set(key, make()).get(key);
  // a sound: len s of samples from wave(t, i), shaped by an attack / exponential decay, through an optional filter
  const sound = (len, wave, { attack = 0.003, decay = len, filter } = {}) => {
    const x = new Float32Array(Math.ceil(len * SR));
    for (let i = 0; i < x.length; i++) {
      const t = i / SR, env = Math.min(1, t / attack) * Math.exp(-5 * t / decay) * Math.min(1, (len - t) / 0.01);
      x[i] = wave(t, i) * env;
    }
    return filter ? biquad(x, ...filter) : x;
  };
  const add = (x, t, level, pan = 0) => {
    const o = Math.round(t * SR), gl = level * Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = level * Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
    for (let i = 0; i < x.length && o + i < n; i++) { L[o + i] += x[i] * gl; R[o + i] += x[i] * gr; }
  };
  const saw = f => t => 2 * ((t * f) % 1) - 1, square = f => t => ((t * f) % 1 < 0.5 ? 1 : -1);
  const kick = () => once("kick", () => { let ph = 0; return sound(0.45, t => Math.sin(ph += 2 * Math.PI * (42 + 108 * Math.exp(-t * 28)) / SR), { decay: 0.5 }); });
  const clap = () => once("clap", () => sound(0.18, t => rand() * (t < 0.036 ? (Math.floor(t / 0.012) % 2 ? 0.6 : 1) : 1), { decay: 0.12, filter: ["bandpass", 1500, 1.2] }));
  const hat = () => once("hat", () => sound(0.09, rand, { decay: 0.05, filter: ["highpass", 8000, 0.7] }));
  const tick = () => once("tick", () => sound(0.03, rand, { decay: 0.02, filter: ["highpass", 9000, 0.7] }));
  const bass = f => once("b" + f, () => sound(0.2, saw(f), { decay: 0.25, filter: ["lowpass", 520, 4] }));
  const stab = f => once("s" + f, () => sound(0.22, saw(f), { decay: 0.2, filter: ["lowpass", 2200, 2] }));
  const pad = f => once("p" + f, () => sound(BAR * 1.05, t => 4 / Math.PI * Math.asin(Math.sin(2 * Math.PI * f * t)) / 2, { attack: BAR * 0.4, decay: 20 }));
  const arp = (f, cut) => once(`a${f}|${cut}`, () => sound(0.12, square(f), { decay: 0.1, filter: ["lowpass", cut, 0.7] }));
  const riser = () => once("riser", () => sound(2 * BEAT, rand, { attack: 2 * BEAT * 0.9, decay: 99, filter: ["bandpass", 3000, 0.8] }));

  for (let bar = 0; bar < BARS; bar++) {
    const on = SECTIONS[Math.floor(bar / 8)], t0 = bar * BAR, k = bar % 4, chord = CHORDS[k];
    const fill = bar % 8 === 7;                                // the last bar of a section: a lift into the next
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * BEAT;
      if (on.kick) add(kick(), t, 0.9);
      if (on.clap && (b === 1 || b === 3)) add(clap(), t, 0.5);
      if (on.hat) {
        add(hat(), t + BEAT / 2, 0.22, 0.2);                   // offbeat
        if (fill || bar >= 32) add(tick(), t + BEAT * 0.75, 0.12, -0.2);
      }
      if (on.bass) for (const s of [0.5, 0.75]) add(bass(ROOTS[k] * (s === 0.75 && b === 3 ? 2 : 1)), t + s * BEAT, 0.35);
      if (on.stab && (b === 0 || b === 2)) chord.forEach((f, i) => add(stab(f * (1 + (i - 1) * 0.003)), t + BEAT / 2, 0.1, (i - 1) * 0.4));
    }
    if (on.pad) chord.forEach((f, i) => add(pad(f), t0, 0.14, (i - 1) * 0.5));
    if (on.arp) for (let s = 0; s < 16; s++)
      add(arp(chord[s % 3] * (s % 6 < 3 ? 2 : 1), 1400 + 150 * (bar % 8)), t0 + s * BEAT / 4, 0.06, s % 2 ? 0.3 : -0.3);
    if (fill && !on.pad) add(riser(), t0 + 2 * BEAT, 0.25);
  }
  // master: gentle soft clip, then the peak to -1 dB
  let peak = 0;
  for (const ch of [L, R]) for (let i = 0; i < n; i++) { ch[i] = Math.tanh(1.3 * ch[i]); peak = Math.max(peak, Math.abs(ch[i])); }
  const gain = 0.89 / (peak || 1);
  for (const ch of [L, R]) for (let i = 0; i < n; i++) ch[i] *= gain;
  return new File([wav([L, R])], DEMO_NAME, { type: "audio/wav", lastModified: 0 });
}

// RBJ biquad (low / high / band pass) over a whole sound
function biquad(x, type, f, q) {
  const w = 2 * Math.PI * f / SR, a = Math.sin(w) / (2 * q), cw = Math.cos(w);
  const b = type === "lowpass" ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : type === "highpass" ? [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2] : [a, 0, -a];
  const a0 = 1 + a, a1 = -2 * cw, a2 = 1 - a, y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// 16-bit PCM WAV of channels of samples
function wav(chans) {
  const ch = chans.length, n = chans[0].length, data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => [...s].forEach((x, i) => data.setUint8(o + i, x.charCodeAt(0)));
  str(0, "RIFF"); data.setUint32(4, 36 + n * ch * 2, true); str(8, "WAVEfmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, SR, true); data.setUint32(28, SR * ch * 2, true);
  data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); str(36, "data"); data.setUint32(40, n * ch * 2, true);
  for (let i = 0, o = 44; i < n; i++) for (let j = 0; j < ch; j++, o += 2) data.setInt16(o, Math.max(-1, Math.min(1, chans[j][i])) * 0x7fff, true);
  return data.buffer;
}
