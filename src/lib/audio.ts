/** Web Audio must first be armed directly inside a user gesture. */
export class AlarmAudio {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private oscillators = new Set<OscillatorNode>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private volume = 0.6;
  private ringing = false;

  async arm(): Promise<void> {
    if (!this.context || this.context.state === "closed") {
      const AudioContextClass =
        globalThis.AudioContext ||
        (
          globalThis as typeof globalThis & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;
      if (!AudioContextClass)
        throw new Error("このブラウザはアラーム音に対応していません。");
      this.context = new AudioContextClass();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
    }
    if (this.context.state === "suspended") await this.context.resume();
    if (this.context.state !== "running")
      throw new Error(
        "アラーム音を有効にできませんでした。もう一度操作してください。",
      );
    // A silent impulse unlocks audio output on mobile Safari.
    const source = this.context.createBufferSource();
    source.buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
    source.connect(this.context.destination);
    source.onended = () => source.disconnect();
    source.start();
  }

  start(volume = this.volume): void {
    if (!this.context || this.context.state !== "running" || !this.gain)
      throw new Error("先にスリープモードでアラーム音を有効にしてください。");
    this.setVolume(volume);
    if (this.ringing) return;
    this.ringing = true;
    this.chime();
    this.timer = setInterval(() => this.chime(), 3_600);
  }

  setVolume(volume: number): void {
    this.volume = Number.isFinite(volume)
      ? Math.min(1, Math.max(0, volume))
      : 0.6;
    if (this.context && this.gain)
      this.gain.gain.setTargetAtTime(
        this.volume,
        this.context.currentTime,
        0.08,
      );
  }

  stop(): void {
    this.ringing = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const oscillator of this.oscillators) {
      try {
        oscillator.stop();
      } catch {
        /* A completed oscillator is already stopped. */
      }
      oscillator.disconnect();
    }
    this.oscillators.clear();
  }

  async dispose(): Promise<void> {
    this.stop();
    this.gain?.disconnect();
    this.gain = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close();
  }

  private chime(): void {
    if (
      !this.ringing ||
      !this.context ||
      !this.gain ||
      this.context.state !== "running"
    )
      return;
    const context = this.context;
    for (const [index, frequency] of [523.25, 659.25, 783.99].entries()) {
      const start = context.currentTime + index * 0.38;
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(0.23, start + 0.04);
      envelope.gain.exponentialRampToValueAtTime(0.001, start + 1.2);
      oscillator.connect(envelope);
      envelope.connect(this.gain);
      this.oscillators.add(oscillator);
      oscillator.onended = () => {
        this.oscillators.delete(oscillator);
        oscillator.disconnect();
        envelope.disconnect();
      };
      oscillator.start(start);
      oscillator.stop(start + 1.25);
    }
  }
}
