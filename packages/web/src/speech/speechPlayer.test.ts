import { describe, expect, it } from "vitest";
import { SpeechPlayer, type FallbackVoice, type SpeechSink } from "./speechPlayer";

/** A clip's text travels in the Blob, so the sink can say what it played. */
const clip = (text: string) => new Blob([text]);

interface Pending { text: string; signal: AbortSignal; resolve: () => void; reject: (error: Error) => void }

/** Synthesis the test finishes by hand; records every request. */
function manualSynth() {
  const requests: Pending[] = [];
  const synthesize = (text: string, _language: string, signal: AbortSignal) => new Promise<Blob>((resolve, reject) => {
    const entry: Pending = { text, signal, resolve: () => resolve(clip(text)), reject };
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    requests.push(entry);
  });
  return { requests, synthesize };
}

/** Synthesis that answers at once (or fails for the texts named). */
function instantSynth(failFor: string[] = []) {
  const requests: string[] = [];
  const synthesize = async (text: string) => {
    requests.push(text);
    if (failFor.some((part) => text.includes(part))) throw new Error("synthesis failed");
    return clip(text);
  };
  return { requests, synthesize };
}

/** A sink that plays until the test ends the clip, or at once with `instant`. */
function recordingSink(instant = true) {
  const played: string[] = [];
  const playing: Array<{ text: string; end: () => void; signal: AbortSignal }> = [];
  const sink: SpeechSink = {
    async play(audio, signal) {
      const text = await audio.text();
      played.push(text);
      if (instant) return;
      await new Promise<void>((resolve) => {
        playing.push({ text, end: resolve, signal });
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  return { sink, played, playing };
}

function fallbackVoice() {
  const spoken: string[] = [];
  const voice: FallbackVoice = { available: () => true, speak: async (text) => { spoken.push(text); } };
  return { voice, spoken };
}

/** Lets every promise chain that can move, move (a Blob is read across a few turns). */
async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const LONG = "Der erste Satz ist hier. " + "Danach kommt ein weiterer längerer Satz mit etwas mehr Inhalt darin. ".repeat(10);

describe("SpeechPlayer", () => {
  it("synthesises the next pieces while the first one plays", async () => {
    const synth = manualSynth();
    const out = recordingSink(false);
    const player = new SpeechPlayer({ synthesize: synth.synthesize, sink: out.sink, serviceAvailable: () => true, lookahead: 1 });
    const outcome = player.speak({ text: LONG, language: "de", priority: "reply" });
    await flush();
    // The first piece and one ahead are requested before anything plays.
    expect(synth.requests.map((request) => request.text)).toHaveLength(2);
    expect(synth.requests[0]!.text).toBe("Der erste Satz ist hier.");
    synth.requests[0]!.resolve();
    await flush();
    expect(out.playing[0]?.text).toBe("Der erste Satz ist hier.");
    // While the first plays, the second is ready to go and the third is asked for.
    expect(synth.requests).toHaveLength(2);
    for (let index = 1; index < 10; index += 1) {
      synth.requests[index]?.resolve();
      out.playing[index - 1]?.end();
      await flush();
    }
    for (const request of synth.requests) request.resolve();
    for (const playing of out.playing) playing.end();
    await flush();
    out.playing.forEach((playing) => playing.end());
    await expect(outcome).resolves.toBe("done");
    expect(out.played.join(" ").replace(/\s+/g, "")).toBe(LONG.replace(/\s+/g, ""));
    expect(player.current).toBeNull();
  });

  it("drops a line while the answer plays, and the answer replaces a line", async () => {
    const synth = instantSynth();
    const out = recordingSink(false);
    const player = new SpeechPlayer({ synthesize: synth.synthesize, sink: out.sink, serviceAvailable: () => true });
    const progress = player.speak({ text: "Ich suche gerade.", language: "de", priority: "progress" });
    await flush();
    expect(player.current?.priority).toBe("progress");
    const reply = player.speak({ text: "Die Antwort.", language: "de", priority: "reply" });
    await expect(progress).resolves.toBe("stopped");
    await flush();
    expect(player.current?.priority).toBe("reply");
    await expect(player.speak({ text: "Noch dran.", language: "de", priority: "progress" })).resolves.toBe("dropped");
    out.playing.at(-1)!.end();
    await expect(reply).resolves.toBe("done");
    expect(out.played).toEqual(["Ich suche gerade.", "Die Antwort."]);
  });

  it("stops at once: the clip, the syntheses under way, and the state", async () => {
    const synth = manualSynth();
    const out = recordingSink(false);
    const player = new SpeechPlayer({ synthesize: synth.synthesize, sink: out.sink, serviceAvailable: () => true });
    const states: Array<string | null> = [];
    player.onChange((activity) => states.push(activity ? activity.priority : null));
    const outcome = player.speak({ text: LONG, language: "de", priority: "reply" });
    await flush();
    synth.requests[0]!.resolve();
    await flush();
    player.stop();
    await expect(outcome).resolves.toBe("stopped");
    expect(out.playing[0]!.signal.aborted).toBe(true);
    expect(synth.requests.slice(1).every((request) => request.signal.aborted)).toBe(true);
    expect(player.current).toBeNull();
    expect(states.at(-1)).toBeNull();
    // Nothing more is played after the stop.
    expect(out.played).toEqual(["Der erste Satz ist hier."]);
  });

  // Replay right after Stop asks for the same pieces while the stopped syntheses are still failing;
  // joined to them, the replay failed too and fell back to the browser's voice.
  it("does not share a stopped speech's syntheses with the speech after it", async () => {
    const synth = manualSynth();
    const out = recordingSink();
    const fallback = fallbackVoice();
    const player = new SpeechPlayer({ synthesize: synth.synthesize, sink: out.sink, fallback: fallback.voice, serviceAvailable: () => true });
    const first = player.speak({ text: "Ein kurzer Satz zum Test.", language: "de", priority: "reply" });
    await flush();
    const second = player.speak({ text: "Ein kurzer Satz zum Test.", language: "de", priority: "reply" });
    await expect(first).resolves.toBe("stopped");
    await flush();
    synth.requests.at(-1)!.resolve();
    await expect(second).resolves.toBe("done");
    expect(synth.requests).toHaveLength(2);
    expect(fallback.spoken).toEqual([]);
    expect(out.played).toEqual(["Ein kurzer Satz zum Test."]);
  });

  it("hands the rest to the browser's voice when a piece cannot be synthesised, and ends idle", async () => {
    const synth = instantSynth(["weiterer"]);
    const out = recordingSink();
    const fallback = fallbackVoice();
    const player = new SpeechPlayer({ synthesize: synth.synthesize, sink: out.sink, fallback: fallback.voice, serviceAvailable: () => true });
    await expect(player.speak({ text: LONG, language: "de", priority: "reply" })).resolves.toBe("done");
    expect(out.played).toEqual(["Der erste Satz ist hier."]);
    expect(fallback.spoken).toHaveLength(1);
    expect(fallback.spoken[0]!.startsWith("Danach kommt")).toBe(true);
    expect(player.current).toBeNull();
  });

  it("fails without a fallback voice, and is free for the next line", async () => {
    const synth = instantSynth(["kaputt"]);
    const out = recordingSink();
    const player = new SpeechPlayer({ synthesize: synth.synthesize, sink: out.sink, serviceAvailable: () => true });
    await expect(player.speak({ text: "Das ist kaputt.", language: "de", priority: "progress" })).resolves.toBe("failed");
    expect(player.current).toBeNull();
    await expect(player.speak({ text: "Das geht.", language: "de", priority: "ack" })).resolves.toBe("done");
  });

  it("speaks with the browser's voice while the speech service is down", async () => {
    const synth = instantSynth();
    const out = recordingSink();
    const fallback = fallbackVoice();
    const player = new SpeechPlayer({ synthesize: synth.synthesize, sink: out.sink, fallback: fallback.voice, serviceAvailable: () => false });
    await expect(player.speak({ text: "Hallo.", language: "de", priority: "ack" })).resolves.toBe("done");
    expect(synth.requests).toEqual([]);
    expect(fallback.spoken).toEqual(["Hallo."]);
  });

  it("synthesises a phrase once, ahead of time or the first time it is said", async () => {
    const synth = instantSynth();
    const out = recordingSink();
    const player = new SpeechPlayer({ synthesize: synth.synthesize, sink: out.sink, serviceAvailable: () => true });
    await player.prefetch("Ich bin dran.", "de");
    await player.speak({ text: "Ich bin dran.", language: "de", priority: "ack" });
    await player.speak({ text: "Ich bin dran.", language: "de", priority: "ack" });
    await player.speak({ text: "Ich bin dran.", language: "en", priority: "ack" });
    expect(synth.requests).toEqual(["Ich bin dran.", "Ich bin dran."]);
    player.clearCache();
    await player.speak({ text: "Ich bin dran.", language: "de", priority: "ack" });
    expect(synth.requests).toHaveLength(3);
  });
});
