// AudioWorklet bitcrusher: the "8-bit video game" crunch.
//
// Two classic lo-fi tricks:
// 1. Bit depth: every sample is rounded to one of 2^bits levels, so quiet detail turns into gritty steps.
// 2. Sample rate: each new sample is held until the next tick of a slower clock ("rate" Hz), which adds the
//    buzzy, metallic aliasing of old consoles and toy chips.
// At bits >= 16 and rate >= the context sample rate the input passes through untouched (no latency, no CPU).
// Parameters: "bits" (1..16), "rate" (Hz). Both channels share one clock so the stereo image stays together.
class Bitcrusher extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "bits", defaultValue: 16, minValue: 1, maxValue: 16, automationRate: "k-rate" },
      { name: "rate", defaultValue: 192000, minValue: 500, maxValue: 192000, automationRate: "k-rate" },   // default: off
    ];
  }
  constructor() { super(); this.phase = 1; this.held = []; }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0], bits = params.bits[0], rate = params.rate[0];
    if (bits >= 16 && rate >= sampleRate) {
      for (let c = 0; c < output.length; c++) {
        const src = input[c] || input[0];
        if (src) output[c].set(src); else output[c].fill(0);
      }
      this.phase = 1;                            // next crush starts on a fresh sample
      return true;
    }
    const levels = 2 ** (bits - 1), step = Math.min(1, rate / sampleRate);
    const n = output[0].length;
    for (let i = 0; i < n; i++) {
      this.phase += step;
      const take = this.phase >= 1;
      if (take) this.phase -= 1;
      for (let c = 0; c < output.length; c++) {
        if (take) {
          const src = input[c] || input[0];
          const x = src ? src[i] : 0;
          this.held[c] = Math.round(x * levels) / levels;
        }
        output[c][i] = this.held[c] || 0;
      }
    }
    return true;
  }
}
registerProcessor("bitcrusher", Bitcrusher);
