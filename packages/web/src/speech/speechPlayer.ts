/**
 * One voice for the page. Everything the assistant says goes through here: the acknowledgement of
 * a spoken request, the lines while a turn runs, and the answer. A line never talks over another —
 * one that matters more replaces it, one that matters less is dropped — and Stop silences all of it.
 *
 * A text is synthesised in pieces (speechText.ts speechChunks): the first piece plays while the next
 * ones are synthesised, so a long answer starts within a sentence's synthesis instead of the whole
 * text's. A piece the speech service cannot make, or the page cannot play, hands the rest of the
 * text to the browser's own voice when there is one; whatever happens, the player ends idle.
 *
 * Free of Vue and of the store: synthesis, playback and the fallback voice are passed in.
 */

import { speechChunks } from "./speechText";

export type SpeechPriority = "ack" | "progress" | "reply";

const RANK: Readonly<Record<SpeechPriority, number>> = { ack: 1, progress: 2, reply: 3 };

export interface SpeechSink {
  /** Plays a clip to its end. Resolves early, without error, when `signal` aborts; rejects when it cannot play. */
  play(audio: Blob, signal: AbortSignal): Promise<void>;
}

export interface FallbackVoice {
  available(): boolean;
  /** Speaks `text` in the browser's own voice; resolves when it is done or `signal` aborts. */
  speak(text: string, language: string, signal: AbortSignal): Promise<void>;
}

export interface SpeechPlayerOptions {
  synthesize(text: string, language: string, signal: AbortSignal): Promise<Blob>;
  sink: SpeechSink;
  fallback?: FallbackVoice;
  /** Whether the speech service is up; while it is not, the fallback voice speaks. */
  serviceAvailable(): boolean;
  /** Synthesised pieces kept for phrases said again and for replays. */
  cacheEntries?: number;
  /** Pieces synthesised ahead of the one playing. */
  lookahead?: number;
}

export interface SpeakRequest {
  /** Speakable text (speechText.ts toSpeakableText). */
  text: string;
  /** Two-letter code. */
  language: string;
  priority: SpeechPriority;
  /** What the page shows while it plays. */
  label?: string;
}

export type SpeakOutcome = "done" | "stopped" | "dropped" | "failed";

export interface SpeechActivity {
  id: number;
  priority: SpeechPriority;
  label?: string;
  text: string;
  language: string;
  /** The piece playing, from 0. */
  piece: number;
  pieces: number;
  voice: "service" | "browser";
}

/** Waits for `promise`, or rejects as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export class SpeechPlayer {
  private active: { activity: SpeechActivity; abort: AbortController } | null = null;
  private nextId = 1;
  private readonly cache = new Map<string, Blob>();
  private readonly inflight = new Map<string, { promise: Promise<Blob>; signal: AbortSignal }>();
  private readonly listeners = new Set<(activity: SpeechActivity | null) => void>();

  constructor(private readonly options: SpeechPlayerOptions) {}

  /** What is being said now, or null. */
  get current(): SpeechActivity | null {
    return this.active ? { ...this.active.activity } : null;
  }

  onChange(listener: (activity: SpeechActivity | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Says `request`. Speech of higher priority than it is left playing and it is dropped; speech of
   * the same or lower priority is stopped for it.
   */
  async speak(request: SpeakRequest): Promise<SpeakOutcome> {
    const text = request.text.trim();
    if (!text) return "done";
    if (this.active && RANK[this.active.activity.priority] > RANK[request.priority]) return "dropped";
    const useService = this.options.serviceAvailable();
    const fallback = this.options.fallback?.available() ? this.options.fallback : undefined;
    if (!useService && !fallback) return "failed";
    this.stop();

    const abort = new AbortController();
    const pieces = speechChunks(text);
    const activity: SpeechActivity = {
      id: this.nextId++,
      priority: request.priority,
      ...(request.label ? { label: request.label } : {}),
      text,
      language: request.language,
      piece: 0,
      pieces: pieces.length,
      voice: useService ? "service" : "browser",
    };
    this.active = { activity, abort };
    this.emit();
    try {
      if (useService) return await this.playPieces(pieces, activity, abort.signal, fallback);
      await fallback!.speak(text, request.language, abort.signal);
      return abort.signal.aborted ? "stopped" : "done";
    } catch {
      return abort.signal.aborted ? "stopped" : "failed";
    } finally {
      if (this.active?.activity.id === activity.id) {
        this.active = null;
        this.emit();
      }
    }
  }

  /** Stops what is being said — only when it has `priority`, if one is named. */
  stop(priority?: SpeechPriority): void {
    if (!this.active) return;
    if (priority && this.active.activity.priority !== priority) return;
    const { abort } = this.active;
    this.active = null;
    abort.abort();
    this.emit();
  }

  /** Synthesises `text` ahead, so saying it later starts at once. Best effort. */
  async prefetch(text: string, language: string): Promise<void> {
    for (const piece of speechChunks(text.trim())) {
      await this.audioFor(piece, language, new AbortController().signal).catch(() => undefined);
    }
  }

  /** Forgets every synthesised piece — the voice that made them has changed. */
  clearCache(): void {
    this.cache.clear();
  }

  private async playPieces(
    pieces: string[],
    activity: SpeechActivity,
    signal: AbortSignal,
    fallback: FallbackVoice | undefined,
  ): Promise<SpeakOutcome> {
    const lookahead = Math.max(0, this.options.lookahead ?? 2);
    const audio: Array<Promise<Blob> | undefined> = [];
    const request = (index: number) => {
      if (index >= pieces.length || audio[index]) return;
      const pending = this.audioFor(pieces[index]!, activity.language, signal);
      // Rejections are read when the piece's turn comes; until then they are not unhandled.
      pending.catch(() => undefined);
      audio[index] = pending;
    };

    for (let index = 0; index < pieces.length; index += 1) {
      for (let ahead = index; ahead <= index + lookahead; ahead += 1) request(ahead);
      try {
        const clip = await audio[index]!;
        if (signal.aborted) return "stopped";
        this.update(activity, { piece: index });
        await this.options.sink.play(clip, signal);
        if (signal.aborted) return "stopped";
      } catch {
        if (signal.aborted) return "stopped";
        if (!fallback) return "failed";
        this.update(activity, { piece: index, voice: "browser" });
        await fallback.speak(pieces.slice(index).join(" "), activity.language, signal);
        return signal.aborted ? "stopped" : "done";
      }
    }
    return "done";
  }

  private audioFor(text: string, language: string, signal: AbortSignal): Promise<Blob> {
    const key = `${language}\u0000${text}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    // A synthesis already under way is shared — unless the speech that asked for it was stopped,
    // which cancels it: its rejection is still on its way, and joining it would fail this one too.
    const running = this.inflight.get(key);
    if (running && !running.signal.aborted) return untilAborted(running.promise, signal);
    const promise = this.options.synthesize(text, language, signal).then((blob) => {
      this.remember(key, blob);
      return blob;
    });
    const entry = { promise, signal };
    this.inflight.set(key, entry);
    const forget = () => { if (this.inflight.get(key) === entry) this.inflight.delete(key); };
    promise.then(forget, forget);
    return untilAborted(promise, signal);
  }

  private remember(key: string, blob: Blob): void {
    const limit = Math.max(1, this.options.cacheEntries ?? 48);
    this.cache.delete(key);
    this.cache.set(key, blob);
    while (this.cache.size > limit) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private update(activity: SpeechActivity, change: Partial<Pick<SpeechActivity, "piece" | "voice">>): void {
    Object.assign(activity, change);
    if (this.active?.activity.id === activity.id) this.emit();
  }

  private emit(): void {
    const snapshot = this.current;
    for (const listener of this.listeners) listener(snapshot);
  }
}
