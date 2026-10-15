import { describe, expect, it } from "vitest";
import { UtteranceRecorder, type Utterance } from "./voiceCapture";

const RATE = 16_000;
/** 40 ms at 16 kHz. */
const FRAME = 640;
const frame = (value: number) => new Float32Array(FRAME).fill(value);

function recorder(options: { endSilenceMs?: number; noSpeechTimeoutMs?: number } = {}) {
  const utterances: Array<Utterance | null> = [];
  let starts = 0;
  const instance = new UtteranceRecorder(
    { onSpeechStart: () => { starts += 1; }, onUtterance: (utterance) => utterances.push(utterance) },
    { endSilenceMs: options.endSilenceMs ?? 1_200, ...(options.noSpeechTimeoutMs ? { noSpeechTimeoutMs: options.noSpeechTimeoutMs } : {}) },
    RATE,
  );
  return { instance, utterances, starts: () => starts };
}

const feed = (target: UtteranceRecorder, value: number, count: number) => {
  for (let index = 0; index < count; index += 1) target.push(frame(value));
};

/** The WAV's samples (16-bit PCM after a 44-byte header). */
async function samplesOf(utterance: Utterance): Promise<Int16Array> {
  return new Int16Array((await utterance.audio.arrayBuffer()).slice(44));
}

describe("UtteranceRecorder", () => {
  // A recorder started once speech was detected lost what came before the detection: the first
  // syllable — and, in a conversation, the first utterance went to the detector, not the recording.
  it("records an utterance from before its detected start to the pause after it", async () => {
    const { instance, utterances, starts } = recorder();
    instance.listen();
    feed(instance, 0.001, 20);
    feed(instance, 0.2, 10);
    expect(starts()).toBe(1);
    feed(instance, 0.001, 40);
    expect(utterances).toHaveLength(1);
    const samples = await samplesOf(utterances[0]!);
    // Every loud frame is in it, including the ones heard before speech was recognised as such.
    expect(samples.filter((sample) => sample > 0.1 * 0x7fff)).toHaveLength(10 * FRAME);
    expect(samples[0]).toBeLessThan(0.01 * 0x7fff);
    expect(utterances[0]!.speechMs).toBeGreaterThanOrEqual(400);
  });

  it("keeps listening for the next utterance", () => {
    const { instance, utterances } = recorder();
    instance.listen();
    for (let round = 0; round < 2; round += 1) {
      feed(instance, 0.001, 15);
      feed(instance, 0.2, 12);
      feed(instance, 0.001, 35);
    }
    expect(utterances.filter(Boolean)).toHaveLength(2);
  });

  it("drops a cough, and ignores the microphone while paused", () => {
    const { instance, utterances, starts } = recorder();
    instance.listen();
    feed(instance, 0.001, 20);
    feed(instance, 0.2, 6);
    feed(instance, 0.001, 40);
    expect(utterances).toEqual([null]);
    instance.pause();
    feed(instance, 0.2, 20);
    expect(starts()).toBe(1);
    expect(utterances).toEqual([null]);
  });

  it("records straight away for the mic button, and gives up when nothing is said", () => {
    const { instance, utterances } = recorder({ noSpeechTimeoutMs: 2_000 });
    instance.record(800);
    feed(instance, 0.001, 49);
    expect(utterances).toEqual([]);
    feed(instance, 0.001, 1);
    expect(utterances).toEqual([null]);
    expect(instance.mode).toBe("paused");
  });

  it("ends a mic-button recording on the pause after speech, or when finished by hand", () => {
    const paused = recorder();
    paused.instance.record(800);
    feed(paused.instance, 0.2, 15);
    feed(paused.instance, 0.001, 19);
    expect(paused.utterances).toEqual([]);
    feed(paused.instance, 0.001, 1);
    expect(paused.utterances[0]?.speechMs).toBe(600);

    const byHand = recorder();
    byHand.instance.record();
    feed(byHand.instance, 0.2, 15);
    byHand.instance.finish();
    expect(byHand.utterances[0]?.speechMs).toBe(600);
    expect(byHand.instance.mode).toBe("paused");
  });
});
