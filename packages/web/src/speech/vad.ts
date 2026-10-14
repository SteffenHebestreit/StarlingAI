/**
 * Hearing the user: when speech starts and ends in a microphone's frames, the moment before it
 * started (so its first syllable is not lost), and the recording as a WAV a speech service reads.
 *
 * Free of the browser's audio APIs; voiceCapture.ts feeds it frames.
 */

/** The loudness of a frame: its root mean square, 0 for silence, about 0.3 for loud speech. */
export function levelOf(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < frame.length; index += 1) sum += frame[index]! * frame[index]!;
  return Math.sqrt(sum / frame.length);
}

export interface VadOptions {
  /** A frame quieter than this is never speech, however quiet the room. */
  minLevel: number;
  /** Speech is louder than the room's noise by this factor… */
  startRatio: number;
  /** …for this long, before it counts as started. */
  startMs: number;
  /** Below the noise by this factor of it, a frame is silence again. */
  endRatio: number;
  /** This much silence ends the speech. */
  endSilenceMs: number;
  /** Speech this long is ended regardless. */
  maxSpeechMs: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  minLevel: 0.012,
  startRatio: 3,
  startMs: 180,
  endRatio: 1.8,
  endSilenceMs: 1_200,
  maxSpeechMs: 60_000,
};

/** While the assistant speaks: only a clear, sustained voice interrupts it, not its own echo. */
export const BARGE_IN_VAD_OPTIONS: Partial<VadOptions> = { minLevel: 0.03, startRatio: 5, startMs: 350 };

export type VadEvent = "start" | "end" | null;

/** Detects speech by loudness against the room's noise, which it keeps learning while nobody speaks. */
export class EnergyVad {
  private options: VadOptions;
  private noise: number;
  private voicedMs = 0;
  private silentMs = 0;
  private speechMs = 0;
  private speaking = false;

  constructor(options: Partial<VadOptions> = {}) {
    this.options = { ...DEFAULT_VAD_OPTIONS, ...options };
    this.noise = this.options.minLevel / 2;
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  /** The room's noise level as learnt so far. */
  get noiseLevel(): number {
    return this.noise;
  }

  setOptions(options: Partial<VadOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** Feeds one frame's level; says when speech starts or ends. */
  push(level: number, frameMs: number): VadEvent {
    const { minLevel, startRatio, startMs, endRatio, endSilenceMs, maxSpeechMs } = this.options;
    if (!this.speaking) {
      if (level > Math.max(minLevel, this.noise * startRatio)) {
        this.voicedMs += frameMs;
        if (this.voicedMs >= startMs) {
          this.speaking = true;
          this.speechMs = this.voicedMs;
          this.voicedMs = 0;
          this.silentMs = 0;
          return "start";
        }
        return null;
      }
      // A cough or a click fades; the room's noise is learnt from what is not speech.
      this.voicedMs = Math.max(0, this.voicedMs - frameMs / 2);
      this.noise = Math.max(0.0005, this.noise * 0.95 + level * 0.05);
      return null;
    }
    this.speechMs += frameMs;
    this.silentMs = level < Math.max(minLevel * 0.75, this.noise * endRatio) ? this.silentMs + frameMs : 0;
    if (this.silentMs >= endSilenceMs || this.speechMs >= maxSpeechMs) {
      this.reset();
      return "end";
    }
    return null;
  }

  /** Forgets any speech under way; the noise level learnt is kept. */
  reset(): void {
    this.speaking = false;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.speechMs = 0;
  }
}

/** The last frames, about `maxSamples` of them, so a recording that starts when speech is detected begins before it. */
export class PreRoll {
  private frames: Float32Array[] = [];
  private samples = 0;

  constructor(private readonly maxSamples: number) {}

  push(frame: Float32Array): void {
    this.frames.push(frame);
    this.samples += frame.length;
    while (this.frames.length > 1 && this.samples - this.frames[0]!.length >= this.maxSamples) {
      this.samples -= this.frames.shift()!.length;
    }
  }

  /** The frames held, oldest first; the buffer is empty afterwards. */
  drain(): Float32Array[] {
    const frames = this.frames;
    this.frames = [];
    this.samples = 0;
    return frames;
  }
}

/** Mono samples at `fromRate`, at `toRate` (each output sample the mean of the input samples it covers). */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate >= fromRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let at = start; at < end; at += 1) sum += samples[at]!;
    output[index] = end > start ? sum / (end - start) : 0;
  }
  return output;
}

/** Frames of mono samples as a 16-bit PCM WAV file, at `toRate` (16 kHz: what speech recognisers use). */
export function encodeWav(frames: readonly Float32Array[], sampleRate: number, toRate = 16_000): ArrayBuffer {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const joined = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    joined.set(frame, offset);
    offset += frame.length;
  }
  const rate = Math.min(sampleRate, toRate);
  const samples = resample(joined, sampleRate, rate);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(at + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}
