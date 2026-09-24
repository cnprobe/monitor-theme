// WebAudio 合成音效：啄击、命中、击倒。无音频文件依赖。

export class Sfx {
  constructor() {
    this.ctx = null;
    // 静音选择跨刷新保留（玩家按 M 静音后不希望刷新页面又响起来）
    this.muted = false;
    try { this.muted = localStorage.getItem('cf.muted') === '1'; } catch { /* 隐私模式等 */ }
    this.noiseBuf = null;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const len = this.ctx.sampleRate * 0.12;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch { this.ctx = null; }
  }

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem('cf.muted', this.muted ? '1' : '0'); } catch { /* ignore */ }
    return this.muted;
  }

  env(gainNode, t0, peak, dur) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  // 啄空/出招：短促“哒”
  peck() {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 2400; filter.Q.value = 1.2;
    const g = this.ctx.createGain();
    this.env(g, t0, 0.18, 0.09);
    src.connect(filter).connect(g).connect(this.ctx.destination);
    src.start(t0); src.stop(t0 + 0.1);
  }

  // 命中：闷“咚” + 短咯咯声
  hit(dist = 0) {
    if (!this.ctx || this.muted) return;
    const vol = Math.min(0.5, 0.42 / (1 + dist * 0.25));
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, t0);
    osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.1);
    const g = this.ctx.createGain();
    this.env(g, t0, vol, 0.12);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.13);
  }

  // 扇翅：连续两下气流的“呼呼”声
  flap() {
    if (!this.ctx || this.muted) return;
    for (const offset of [0, 0.13]) {
      const t0 = this.ctx.currentTime + offset;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(900, t0);
      filter.frequency.exponentialRampToValueAtTime(300, t0 + 0.12);
      const g = this.ctx.createGain();
      this.env(g, t0, 0.22, 0.12);
      src.connect(filter).connect(g).connect(this.ctx.destination);
      src.start(t0); src.stop(t0 + 0.14);
    }
  }

  // 击倒：下滑音
  ko(dist = 0) {
    if (!this.ctx || this.muted) return;
    const vol = Math.min(0.5, 0.4 / (1 + dist * 0.25));
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(520, t0);
    osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.42);
    const g = this.ctx.createGain();
    this.env(g, t0, vol * 0.7, 0.45);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.5);
  }

  // 被啄方（自己掉血）咯咯惊叫
  cluck() {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(380, t0 + 0.08);
    const g = this.ctx.createGain();
    this.env(g, t0, 0.12, 0.09);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.1);
  }
}
