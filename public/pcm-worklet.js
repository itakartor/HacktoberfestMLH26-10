// Captures mono audio, downsamples to 16 kHz PCM16 and posts ~100 ms chunks.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0;
    this.accN = 0;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.outIdx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch0 = input[0];
    const ch1 = input[1];
    for (let i = 0; i < ch0.length; i++) {
      this.acc += ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i];
      this.accN++;
      this.pos++;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.acc / this.accN));
        this.out[this.outIdx] = s < 0 ? s * 0x8000 : s * 0x7fff;
        this.outIdx++;
        this.acc = 0;
        this.accN = 0;
        if (this.outIdx === this.out.length) {
          this.port.postMessage(this.out.buffer.slice(0));
          this.outIdx = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
