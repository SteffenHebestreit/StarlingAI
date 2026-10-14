import { describe, expect, it } from "vitest";
import { BARGE_IN_VAD_OPTIONS, EnergyVad, PreRoll, encodeWav, levelOf, resample } from "./vad";

const FRAME_MS = 40;

/** Feeds `count` frames of `level`; returns the events with the frame they came on. */
function feed(vad: EnergyVad, level: number, count: number): Array<string> {
  const events: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const event = vad.push(level, FRAME_MS);
    if (event) events.push(`${event}@${index}`);
  }
  return events;
}

describe("EnergyVad", () => {
  it("starts on sustained speech and ends after the configured pause", () => {
    const vad = new EnergyVad({ startMs: 160, endSilenceMs: 800 });
    expect(feed(vad, 0.002, 25)).toEqual([]);
    // 160 ms of speech is four frames: the fourth starts it.
    expect(feed(vad, 0.2, 10)).toEqual(["start@3"]);
    // 800 ms of silence is twenty frames.
    expect(feed(vad, 0.002, 30)).toEqual(["end@19"]);
  });

  it("does not start on a click", () => {
    const vad = new EnergyVad({ startMs: 160 });
    feed(vad, 0.002, 25);
    expect([...feed(vad, 0.3, 2), ...feed(vad, 0.002, 10), ...feed(vad, 0.3, 2)]).toEqual([]);
  });

  it("learns the room's noise, so steady noise does not count as speech", () => {
    // In a quiet room, 0.03 is someone speaking…
    expect(feed(new EnergyVad(), 0.03, 10)).toContain("start@4");
    // …but in a room with a steady hum just under the floor, it is the room; a voice is still a voice.
    const vad = new EnergyVad();
    feed(vad, 0.011, 200);
    expect(vad.noiseLevel).toBeGreaterThan(0.009);
    expect(feed(vad, 0.03, 10)).toEqual([]);
    expect(feed(vad, 0.2, 10)).toEqual(["start@4"]);
  });

  it("needs a clearer, longer voice to interrupt the assistant", () => {
    const vad = new EnergyVad();
    feed(vad, 0.004, 50);
    vad.setOptions(BARGE_IN_VAD_OPTIONS);
    expect(feed(vad, 0.025, 20)).toEqual([]);
    expect(feed(vad, 0.15, 6)).toEqual([]);
    vad.reset();
    expect(feed(vad, 0.15, 12)).toEqual(["start@8"]);
  });

  it("ends speech that runs too long", () => {
    const vad = new EnergyVad({ maxSpeechMs: 1_000, startMs: 40 });
    expect(feed(vad, 0.2, 40)).toEqual(["start@0", "end@24", "start@25"]);
  });
});

describe("PreRoll", () => {
  it("keeps about the last N samples, oldest first", () => {
    const preRoll = new PreRoll(250);
    for (let index = 0; index < 10; index += 1) preRoll.push(new Float32Array(100).fill(index));
    const frames = preRoll.drain();
    expect(frames.map((frame) => frame[0])).toEqual([7, 8, 9]);
    expect(preRoll.drain()).toEqual([]);
  });
});

describe("WAV", () => {
  it("averages down to the target rate", () => {
    expect(Array.from(resample(new Float32Array([0, 0.3, 0.6, 0.3, 0.3, 0.3]), 48_000, 16_000)).map((value) => Number(value.toFixed(2))))
      .toEqual([0.3, 0.3]);
    const same = new Float32Array([1, 2]);
    expect(resample(same, 16_000, 16_000)).toBe(same);
  });

  it("writes 16-bit mono PCM at 16 kHz with a correct header", () => {
    const frames = [new Float32Array(480).fill(0.5), new Float32Array(480).fill(-2)];
    const view = new DataView(encodeWav(frames, 48_000));
    const text = (at: number, length: number) => String.fromCharCode(...new Uint8Array(view.buffer, at, length));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(320 * 2);
    expect(view.byteLength).toBe(44 + 320 * 2);
    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 0x7fff - 0.5));
    // Louder than full scale is clipped, not wrapped.
    expect(view.getInt16(44 + 319 * 2, true)).toBe(-0x8000);
  });

  it("measures a frame's loudness", () => {
    expect(levelOf(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(levelOf(new Float32Array(0))).toBe(0);
  });
});
