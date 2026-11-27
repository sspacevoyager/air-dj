// AudioWorklet pitch shifter: changes the key of the music without changing its tempo.
//
// Per STFT frame (2048 samples, 75% overlap, Hann):
// 1. Harmonic/percussive split (HPSS, Fitzgerald 2010): a median over time keeps sustained tones, a median over
//    frequency keeps hits. Soft masks split the spectrum into a harmonic part and a percussive part that add back
//    up to the original exactly. Only the harmonic part is transposed; drums pass through untouched and stay punchy.
// 2. Formant preservation: the harmonic part's spectral envelope (cepstral smoothing) is divided out, the flat
//    spectrum is shifted, and the original envelope is applied again, so voices keep their natural timbre
//    instead of turning chipmunk (+) or monster (-).
// 3. Phase-vocoder peak shifting (Laroche & Dolson): each spectral peak and its bins move to peak * pitch, with a
//    phase rotation for the exact (fractional) frequency change that is accumulated hop by hop per destination bin,
//    so partials stay continuous across frames (rotating by shift x absolute time instead would turn the peaks'
//    small frame-to-frame jitter into ever larger phase jumps the longer the node runs).
//
// 4. The shifted harmonic part is rescaled to its original energy, then added to the untouched percussive part.
//
// Latency: FRAME - 128 + LOOKAHEAD * HOP = 3456 samples (~72 ms at 48 kHz) with the defaults (frame 2048, lookahead 3).
// processorOptions { frame, lookahead } pick others, e.g. 4096 / 1 = 4992 samples. At pitch 1 the output = input, delayed.
// Cost: ~6% of one core per channel (measured in Node on this machine).
// Parameters: "pitch" (frequency ratio, 2 ** (semitones / 12)); "formants" (1 = keep timbre, 0 = classic shift);
// "drums" (level of the untouched percussive part: 1 = full song, 0 = tonal part only, used by the octave voices).
const BLOCK = 128;
// Everything below depends on the frame size, so it's built per size: the key shift uses 2048 (tight timing), the
// octave voices 4096 (twice the frequency resolution: notes of a chord stay apart, so big shifts come out clean).
function makeEngine(FRAME, LOOKAHEAD) {
const HOP = FRAME / 4, BINS = FRAME / 2 + 1;
const OLA_GAIN = 1 / 1.5;                      // sum of Hann^2 at 75% overlap
const SPAN = 2 * LOOKAHEAD + 1;                // HPSS time-median window: frames centred on the one being output
const FREQ_KERNEL = (17 * FRAME / 2048) | 1;   // HPSS frequency-median window in bins (~400 Hz), odd
const LIFTER = Math.round(60 * FRAME / 2048);  // cepstral coefficients kept for the envelope: below the pitch period of
                                               // voices up to ~500 Hz, fine enough to follow vocal formants

const WINDOW = new Float32Array(FRAME);
for (let i = 0; i < FRAME; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME);

// in-place iterative radix-2 complex FFT; inverse when inv = true (unscaled)
const BITS = Math.log2(FRAME), REV = new Uint32Array(FRAME);
for (let i = 0; i < FRAME; i++) { let r = 0; for (let b = 0; b < BITS; b++) r |= ((i >> b) & 1) << (BITS - 1 - b); REV[i] = r; }
const COS = new Float64Array(FRAME / 2), SIN = new Float64Array(FRAME / 2);
for (let i = 0; i < FRAME / 2; i++) { COS[i] = Math.cos(2 * Math.PI * i / FRAME); SIN[i] = Math.sin(2 * Math.PI * i / FRAME); }
function fft(re, im, inv) {
  for (let i = 0; i < FRAME; i++) {
    const j = REV[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= FRAME; size <<= 1) {
    const half = size >> 1, step = FRAME / size;
    for (let start = 0; start < FRAME; start += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step], s = inv ? SIN[k * step] : -SIN[k * step];
        const a = start + k, b = a + half;
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

const clampHalf = x => Math.max(-0.5, Math.min(0.5, x));
function median(buf, n) {                      // insertion sort of a small scratch buffer, returns the middle value
  for (let i = 1; i < n; i++) { const v = buf[i]; let j = i - 1; while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; } buf[j + 1] = v; }
  return buf[n >> 1];
}

class Channel {
  constructor() {
    this.input = new Float32Array(FRAME);      // last FRAME input samples
    this.ola = new Float32Array(FRAME);        // overlap-add accumulator; index 0 = next sample out
    this.frames = 0;                           // frames analysed so far
    // ring of the last SPAN analysed spectra (positive bins only)
    this.ringRe = Array.from({ length: SPAN }, () => new Float64Array(BINS));
    this.ringIm = Array.from({ length: SPAN }, () => new Float64Array(BINS));
    this.ringMag = Array.from({ length: SPAN }, () => new Float64Array(BINS));
    const f = () => new Float64Array(FRAME);
    this.re = f(); this.im = f(); this.sre = f(); this.sim = f(); this.cre = f(); this.cim = f();
    this.hr = new Float64Array(BINS); this.hi = new Float64Array(BINS);   // harmonic part (flattened when keeping formants)
    this.shr = new Float64Array(BINS); this.shi = new Float64Array(BINS);   // shifted harmonic part
    this.rot = new Float64Array(BINS);         // accumulated phase rotation per destination bin (radians)
    this.env = new Float64Array(BINS); this.mag = new Float64Array(BINS); this.peaks = new Int32Array(BINS);
    this.scratch = new Float64Array(SPAN); this.win = new Float64Array(FREQ_KERNEL + 1);
  }

  analyse() {                                  // window + FFT the newest input frame into the ring
    const { re, im } = this, slot = this.frames % SPAN;
    for (let i = 0; i < FRAME; i++) { re[i] = this.input[i] * WINDOW[i]; im[i] = 0; }
    fft(re, im, false);
    const R = this.ringRe[slot], I = this.ringIm[slot], M = this.ringMag[slot];
    for (let k = 0; k < BINS; k++) { R[k] = re[k]; I[k] = im[k]; M[k] = Math.hypot(re[k], im[k]); }
    this.frames++;
  }

  envelope(mag) {                              // cepstral envelope of mag -> this.env
    const { cre, cim, env } = this;
    for (let k = 0; k < BINS; k++) cre[k] = Math.log(mag[k] + 1e-9);
    for (let k = 1; k < FRAME / 2; k++) cre[FRAME - k] = cre[k];
    cim.fill(0);
    fft(cre, cim, true);                       // real cepstrum (scale folded in below)
    for (let i = LIFTER; i <= FRAME - LIFTER; i++) { cre[i] = 0; cim[i] = 0; }
    fft(cre, cim, false);
    for (let k = 0; k < BINS; k++) env[k] = cre[k] / FRAME;
    let peak = 0;
    for (let k = 0; k < BINS; k++) { env[k] = Math.exp(env[k]); if (env[k] > peak) peak = env[k]; }
    const floor = peak * 1e-4;                 // don't blow up near-silent bands when dividing
    for (let k = 0; k < BINS; k++) if (env[k] < floor) env[k] = floor;
  }

  frame(pitch, formants, drums) {
    this.analyse();
    if (this.frames < SPAN) return;            // warming up the lookahead window: silence
    const c = (this.frames - 1 - LOOKAHEAD) % SPAN;   // centre frame = the one we output now
    const Xr = this.ringRe[c], Xi = this.ringIm[c], Xm = this.ringMag[c];
    const { sre, sim, hr, hi, mag, peaks, env, scratch } = this;

    if (pitch === 1 && drums === 1) {          // untouched: exact reconstruction
      for (let k = 0; k < BINS; k++) { sre[k] = Xr[k]; sim[k] = Xi[k]; }
    } else {
      // 1. HPSS soft masks; percussive part goes straight to the output
      let eIn = 0;
      const half = FREQ_KERNEL >> 1, win = this.win;   // sliding sorted window for the frequency median
      let wn = 0;
      const add = v => { let j = wn++; while (j > 0 && win[j - 1] > v) { win[j] = win[j - 1]; j--; } win[j] = v; };
      const drop = v => { let j = 0; while (win[j] !== v) j++; for (; j < wn - 1; j++) win[j] = win[j + 1]; wn--; };
      for (let j = 0; j < half && j < BINS; j++) add(Xm[j]);
      for (let k = 0; k < BINS; k++) {
        for (let j = 0; j < SPAN; j++) scratch[j] = this.ringMag[j][k];
        const h = median(scratch, SPAN);
        if (k + half < BINS) add(Xm[k + half]);
        if (k - half - 1 >= 0) drop(Xm[k - half - 1]);
        const p = win[wn >> 1];
        const mH = (h * h) / (h * h + p * p + 1e-30);
        hr[k] = Xr[k] * mH; hi[k] = Xi[k] * mH;
        sre[k] = (Xr[k] - hr[k]) * drums; sim[k] = (Xi[k] - hi[k]) * drums;   // percussive = original - harmonic
        eIn += hr[k] * hr[k] + hi[k] * hi[k];
      }
      // 2. flatten the harmonic part by its envelope (formant preservation)
      for (let k = 0; k < BINS; k++) mag[k] = Math.hypot(hr[k], hi[k]);
      if (formants) {
        this.envelope(mag);
        for (let k = 0; k < BINS; k++) { hr[k] /= env[k]; hi[k] /= env[k]; mag[k] /= env[k]; }
      }
      // 3. peak shifting of the (flattened) harmonic part into shr/shi
      const { shr, shi } = this;
      shr.fill(0); shi.fill(0);
      for (let k = 0; k < BINS; k++) mag[k] *= mag[k];
      let n = 0;
      for (let k = 2; k < BINS - 2; k++) {
        const m = mag[k];
        if (m > mag[k - 1] && m > mag[k - 2] && m > mag[k + 1] && m > mag[k + 2]) { peaks[n++] = k; k += 2; }
      }
      for (let p = 0; p < n; p++) {
        const peak = peaks[p];
        const l = Math.log(mag[peak - 1] + 1e-30), m0 = Math.log(mag[peak] + 1e-30), r = Math.log(mag[peak + 1] + 1e-30);
        const den = l - 2 * m0 + r, frac = den < 0 ? clampHalf(0.5 * (l - r) / den) : 0;
        const delta = (peak + frac) * (pitch - 1);           // exact shift in (fractional) bins
        const shifted = peak + Math.round(delta);
        if (shifted >= BINS) break;
        const lo = p > 0 ? peak - Math.floor((peak - peaks[p - 1]) / 2) : 0;
        const hiB = p < n - 1 ? peak + Math.ceil((peaks[p + 1] - peak) / 2) : BINS;
        const phi = this.rot[shifted] = (this.rot[shifted] + 2 * Math.PI * delta / FRAME * HOP) % (2 * Math.PI);
        const cs = Math.cos(phi), sn = Math.sin(phi);
        for (let k = lo; k < hiB; k++) {
          const t = k + shifted - peak;
          if (t < 0) continue;
          if (t >= BINS) break;
          const g = formants ? env[t] : 1;                     // re-apply the ORIGINAL envelope at the new position
          shr[t] += (hr[k] * cs - hi[k] * sn) * g;
          shi[t] += (hr[k] * sn + hi[k] * cs) * g;
        }
      }
      // 4. keep the harmonic part's loudness (moving bins under a different envelope changes its energy), then mix
      let eOut = 0;
      for (let k = 0; k < BINS; k++) eOut += shr[k] * shr[k] + shi[k] * shi[k];
      const level = eOut > 0 ? Math.min(2, Math.max(0.5, Math.sqrt(eIn / eOut))) : 1;
      for (let k = 0; k < BINS; k++) { sre[k] += shr[k] * level; sim[k] += shi[k] * level; }
    }
    for (let k = 1; k < FRAME / 2; k++) { sre[FRAME - k] = sre[k]; sim[FRAME - k] = -sim[k]; }   // real signal: mirror
    sim[0] = 0; sim[FRAME / 2] = 0;
    fft(sre, sim, true);
    const g = OLA_GAIN / FRAME;
    for (let i = 0; i < FRAME; i++) this.ola[i] += sre[i] * WINDOW[i] * g;
  }
}

return { Channel, HOP };
}
const engines = {};
const engine = (frame, look) => engines[frame + "/" + look] ||= makeEngine(frame, look);

class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitch", defaultValue: 1, minValue: 0.25, maxValue: 8, automationRate: "k-rate" },
      { name: "formants", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "drums", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }
  constructor(options) {
    super(); this.ch = []; this.fill = 0;
    const { frame = 2048, lookahead = 3 } = options?.processorOptions || {};
    ({ Channel: this.Channel, HOP: this.hop } = engine(frame, lookahead));
    this.frameSize = frame;
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0], pitch = params.pitch[0], formants = params.formants[0] >= 0.5, drums = params.drums[0];
    for (let c = 0; c < output.length; c++) {
      const st = this.ch[c] ||= new this.Channel();
      const src = input[c] || input[0];        // mono input -> both outputs
      st.input.copyWithin(0, BLOCK);
      if (src) st.input.set(src, this.frameSize - BLOCK); else st.input.fill(0, this.frameSize - BLOCK);
    }
    this.fill += BLOCK;
    if (this.fill >= this.hop) {
      this.fill = 0;
      for (let c = 0; c < output.length; c++) this.ch[c].frame(pitch, formants, drums);
    }
    for (let c = 0; c < output.length; c++) {
      const st = this.ch[c];
      output[c].set(st.ola.subarray(0, BLOCK));
      st.ola.copyWithin(0, BLOCK); st.ola.fill(0, this.frameSize - BLOCK);
    }
    return true;
  }
}
registerProcessor("pitch-shifter", PitchShifter);
