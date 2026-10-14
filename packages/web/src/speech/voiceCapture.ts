/**
 * The microphone. Opened once, it either listens — and records each thing the user says, from just
 * before they started to the pause after they finished — or records straight away until a pause
 * (the mic button), or is paused while the assistant works.
 *
 * Recordings are 16 kHz WAV (vad.ts encodeWav): every speech service reads them, and the start of
 * an utterance is in them — a recorder started only once speech was heard lost its first syllable,
 * and the first utterance of a hands-free conversation went to the detector, not the recording.
 */

import { audioContext } from "./audioOutput";
import { BARGE_IN_VAD_OPTIONS, DEFAULT_VAD_OPTIONS, EnergyVad, PreRoll, encodeWav, levelOf } from "./vad";

export interface Utterance {
  audio: Blob;
  /** How much of it was speech. */
  speechMs: number;
}

export interface UtteranceEvents {
  /** Speech started while listening — the moment to stop the assistant's voice. */
  onSpeechStart?(): void;
  /** A recording ended: what was said, or null when nothing usable was. */
  onUtterance(utterance: Utterance | null): void;
}

export interface VoiceCaptureEvents extends UtteranceEvents {
  /** The microphone's level, 0..1, about twenty times a second. */
  onLevel?(level: number): void;
}

export interface VoiceCaptureOptions {
  /** The pause that ends an utterance. */
  endSilenceMs: number;
  /** Recording straight away, this long with no speech ends the recording. */
  noSpeechTimeoutMs?: number;
}

/** Less speech than this is a cough or a click, not something said. */
const MIN_SPEECH_MS = 300;
/** How far before the detected start of speech a recording begins. */
const PRE_ROLL_MS = 450;

export type RecorderMode = "paused" | "listening" | "recording";

/** Turns microphone frames into utterances. Free of the browser's audio APIs: VoiceCapture feeds it. */
export class UtteranceRecorder {
  private currentMode: RecorderMode = "paused";
  private readonly vad: EnergyVad;
  private preRoll: PreRoll;
  private frames: Float32Array[] = [];
  private capturing = false;
  private heardSpeech = false;
  private speechMs = 0;
  private recordedMs = 0;

  constructor(
    private readonly events: UtteranceEvents,
    private readonly options: VoiceCaptureOptions,
    private sampleRate = 48_000,
  ) {
    this.vad = new EnergyVad({ endSilenceMs: options.endSilenceMs });
    this.preRoll = new PreRoll(this.preRollSamples());
  }

  get mode(): RecorderMode {
    return this.currentMode;
  }

  setSampleRate(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.preRoll = new PreRoll(this.preRollSamples());
  }

  /** Waits for speech and records it, each utterance on its own. Calling it while listening changes nothing. */
  listen(): void {
    if (this.currentMode === "listening") return;
    this.reset();
    this.currentMode = "listening";
  }

  /** Records from now until the user pauses after speaking, or finish(). */
  record(endSilenceMs = this.options.endSilenceMs): void {
    this.reset();
    this.vad.setOptions({ endSilenceMs });
    this.currentMode = "recording";
    this.capturing = true;
  }

  /** Ignores the frames until listen() or record(). */
  pause(): void {
    this.currentMode = "paused";
    this.reset();
  }

  /** While the assistant speaks: only clear, sustained speech counts, not its own voice coming back. */
  setBargeIn(on: boolean): void {
    this.vad.setOptions(on ? BARGE_IN_VAD_OPTIONS : {
      minLevel: DEFAULT_VAD_OPTIONS.minLevel,
      startRatio: DEFAULT_VAD_OPTIONS.startRatio,
      startMs: DEFAULT_VAD_OPTIONS.startMs,
    });
  }

  /** Ends the recording under way now, with what it has. */
  finish(): void {
    if (this.capturing) this.emit();
  }

  push(frame: Float32Array, level = levelOf(frame)): void {
    if (this.currentMode === "paused") return;
    const frameMs = this.durationOf(frame);
    const event = this.vad.push(level, frameMs);

    if (this.currentMode === "listening" && !this.capturing) {
      this.preRoll.push(frame);
      if (event === "start") {
        this.capturing = true;
        this.frames = this.preRoll.drain();
        for (const held of this.frames) if (this.voiced(levelOf(held))) this.speechMs += this.durationOf(held);
        this.events.onSpeechStart?.();
      }
      return;
    }
    if (!this.capturing) return;
    this.frames.push(frame);
    this.recordedMs += frameMs;
    if (this.voiced(level)) this.speechMs += frameMs;
    if (event === "start") this.heardSpeech = true;
    if (event === "end") {
      this.emit();
      return;
    }
    if (this.currentMode === "recording" && !this.heardSpeech && this.recordedMs >= (this.options.noSpeechTimeoutMs ?? 8_000)) this.emit();
  }

  private preRollSamples(): number {
    return Math.round((this.sampleRate * PRE_ROLL_MS) / 1_000);
  }

  private durationOf(frame: Float32Array): number {
    return (frame.length / this.sampleRate) * 1_000;
  }

  /** Whether a frame is the user's voice rather than the room — what counts as speech in a recording. */
  private voiced(level: number): boolean {
    return level > Math.max(DEFAULT_VAD_OPTIONS.minLevel, this.vad.noiseLevel * 2);
  }

  private emit(): void {
    const frames = this.frames;
    const speechMs = this.speechMs;
    const wasRecording = this.currentMode === "recording";
    this.reset();
    if (wasRecording) this.currentMode = "paused";
    const usable = speechMs >= MIN_SPEECH_MS && frames.length > 0;
    this.events.onUtterance(usable
      ? { audio: new Blob([encodeWav(frames, this.sampleRate)], { type: "audio/wav" }), speechMs }
      : null);
  }

  private reset(): void {
    this.capturing = false;
    this.heardSpeech = false;
    this.frames = [];
    this.speechMs = 0;
    this.recordedMs = 0;
    this.preRoll.drain();
    this.vad.reset();
    this.vad.setOptions({ endSilenceMs: this.options.endSilenceMs });
  }
}

/** The microphone, read through the page's AudioContext into an UtteranceRecorder. */
export class VoiceCapture {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private mute: GainNode | null = null;
  private readonly recorder: UtteranceRecorder;

  constructor(private readonly events: VoiceCaptureEvents, options: VoiceCaptureOptions) {
    this.recorder = new UtteranceRecorder(events, options);
  }

  get isOpen(): boolean {
    return this.stream !== null;
  }

  /** Opens the microphone, asking for permission the first time. */
  async open(): Promise<void> {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable in this browser");
    const ctx = audioContext();
    if (!ctx) throw new Error("This browser cannot process audio");
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.stream = stream;
    this.recorder.setSampleRate(ctx.sampleRate);
    this.source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but everywhere; an AudioWorklet would need a module of its own.
    this.processor = ctx.createScriptProcessor(2_048, 1, 1);
    this.mute = ctx.createGain();
    this.mute.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      const frame = new Float32Array(event.inputBuffer.getChannelData(0));
      const level = levelOf(frame);
      this.events.onLevel?.(Math.min(1, level * 4));
      this.recorder.push(frame, level);
    };
    this.source.connect(this.processor);
    // A processor runs only while connected to the output; muted, so the user does not hear themselves.
    this.processor.connect(this.mute).connect(ctx.destination);
  }

  listen(): void { this.recorder.listen(); }
  record(endSilenceMs?: number): void { this.recorder.record(endSilenceMs); }
  pause(): void { this.recorder.pause(); }
  setBargeIn(on: boolean): void { this.recorder.setBargeIn(on); }
  finish(): void { this.recorder.finish(); }

  /** Releases the microphone. */
  close(): void {
    this.recorder.pause();
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.mute?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.processor = null;
    this.mute = null;
    this.source = null;
    this.stream = null;
  }
}
