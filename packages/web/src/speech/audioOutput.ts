/**
 * The page's sound: one AudioContext for the voice, the short tones that mark a turn's start, end,
 * a question and a failure, and the microphone (voiceCapture.ts).
 *
 * A browser lets a page make sound only once the user has interacted with it; unlockAudio() is
 * called from the clicks that switch speech on.
 */

import type { SpeechSink } from "./speechPlayer";

type AudioContextConstructor = new () => AudioContext;

let context: AudioContext | null = null;

/** The page's AudioContext, made on first use; null where the browser has none. */
export function audioContext(): AudioContext | null {
  if (context) return context;
  if (typeof window === "undefined") return null;
  const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext) as
    AudioContextConstructor | undefined;
  if (!Ctor) return null;
  context = new Ctor();
  return context;
}

/** Lets the page make sound — call it from a click. */
export function unlockAudio(): void {
  const ctx = audioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
}

async function runningContext(): Promise<AudioContext> {
  const ctx = audioContext();
  if (!ctx) throw new Error("This browser cannot play audio");
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  // A suspended context's clock stands still: a clip started on it would never end.
  if (ctx.state !== "running") throw new Error("Audio is blocked until the page is clicked");
  return ctx;
}

/** Plays synthesised speech through the page's AudioContext. */
export const webAudioSink: SpeechSink = {
  async play(audio, signal) {
    if (signal.aborted) return;
    const ctx = await runningContext();
    const buffer = await ctx.decodeAudioData(await audio.arrayBuffer());
    if (signal.aborted) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(watchdog);
        signal.removeEventListener("abort", onAbort);
        source.disconnect();
        resolve();
      };
      const onAbort = () => {
        try { source.stop(); } catch { /* never started */ }
        finish();
      };
      // `ended` can be missed when the context is suspended mid-clip; the clip's length bounds the wait.
      const watchdog = window.setTimeout(finish, buffer.duration * 1_000 + 2_000);
      source.onended = finish;
      signal.addEventListener("abort", onAbort, { once: true });
      source.start();
    });
  },
};

export type Earcon = "start" | "done" | "attention" | "error" | "listen" | "heard";

interface Tone {
  /** Hz. */
  frequency: number;
  /** Seconds from the earcon's start. */
  at: number;
  /** Seconds. */
  duration: number;
}

/** Each earcon's tones: rising for a start, a bright pair for done, a double ping for a question, falling for a failure. */
export const EARCONS: Readonly<Record<Earcon, readonly Tone[]>> = {
  start: [{ frequency: 660, at: 0, duration: 0.08 }, { frequency: 880, at: 0.08, duration: 0.12 }],
  done: [{ frequency: 784, at: 0, duration: 0.1 }, { frequency: 1_047, at: 0.09, duration: 0.24 }],
  attention: [{ frequency: 988, at: 0, duration: 0.09 }, { frequency: 988, at: 0.16, duration: 0.09 }, { frequency: 1_319, at: 0.32, duration: 0.18 }],
  error: [{ frequency: 440, at: 0, duration: 0.14 }, { frequency: 311, at: 0.14, duration: 0.26 }],
  listen: [{ frequency: 1_175, at: 0, duration: 0.07 }],
  heard: [{ frequency: 880, at: 0, duration: 0.05 }, { frequency: 698, at: 0.06, duration: 0.07 }],
};

/** Plays an earcon; silently does nothing where the page cannot make sound yet. */
export function playEarcon(kind: Earcon, volume = 0.08): void {
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state === "running") {
    scheduleEarcon(ctx, kind, volume);
    return;
  }
  // Once the user has interacted with the page, a suspended context may be resumed from anywhere.
  void ctx.resume().then(() => { if (ctx.state === "running") scheduleEarcon(ctx, kind, volume); }).catch(() => undefined);
}

function scheduleEarcon(ctx: AudioContext, kind: Earcon, volume: number): void {
  const begin = ctx.currentTime + 0.01;
  for (const tone of EARCONS[kind]) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = tone.frequency;
    const start = begin + tone.at;
    const end = start + tone.duration;
    // A soft attack and release: a bare sine starting and stopping clicks.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
}
