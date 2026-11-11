import { describe, expect, it } from "vitest";
import { LABEL_HALF, MAX_SATELLITES, freeHalfWidth, labelFits, liveActivity, orbitGeometry, orbitPoint, shortSubject, type ActivityMessage } from "./orbActivity";
import type { TurnStep } from "./turnSteps";

/**
 * THE RUNNING TURN AT THE ORB. Its progress messages and its steps used to fill the chat while it
 * worked (a "Zwischenstand" bubble each, a step list in the live bubble); the orb now shows its
 * newest words and its steps, and the chat keeps questions and answers.
 */
const T0 = Date.UTC(2026, 10, 11, 21, 37, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000);

const message = (overrides: Partial<ActivityMessage>): ActivityMessage => ({
  id: "m",
  role: "assistant",
  content: "",
  timestamp: at(0),
  ...overrides,
});

const tool = (id: string, overrides: Partial<TurnStep> = {}): TurnStep => ({
  id,
  kind: "tool",
  name: "web_fetch",
  depth: 1,
  status: "done",
  startedAt: T0 + 10_000,
  endedAt: T0 + 11_000,
  args: { url: `https://example.test/${id}` },
  ...overrides,
});

const turn = (live: Partial<ActivityMessage>, before: ActivityMessage[] = []): ActivityMessage[] => [
  // A turn's progress messages sit before its answer (progressMessage.ts placeProgressMessage).
  message({ id: "q0", role: "user", content: "Was gibt es Neues zu Qwen 4?", timestamp: at(-600) }),
  message({ id: "p-old", content: "Ein Zwischenstand der alten Frage.", progress: true, timestamp: at(-595) }),
  message({ id: "a0", content: "Die alte Antwort.", timestamp: at(-590) }),
  message({ id: "q1", role: "user", content: "Recherchiere, was es Neues gibt zu Qwen 4", timestamp: at(0) }),
  ...before,
  message({ id: "streaming", timestamp: at(1), ...live }),
];

describe("liveActivity", () => {
  it("is nothing when no turn runs", () => {
    expect(liveActivity([message({ id: "q", role: "user" }), message({ id: "a", content: "x" })], T0, "de")).toBeNull();
  });

  it("speaks with the turn's newest progress message, never an earlier turn's", () => {
    const messages = turn({}, [
      message({ id: "p1", content: "Ich schaue mir die neuesten Informationen an.", progress: true, timestamp: at(60) }),
      message({ id: "p2", content: "Ich lese gerade eine Webseite.", progress: true, timestamp: at(120) }),
    ]);
    expect(liveActivity(messages, T0 + 130_000, "de")?.headline).toBe("Ich lese gerade eine Webseite.");
    // The previous turn's progress message sits before its answer, and is not this turn's.
    expect(liveActivity(turn({ statusText: "Suche Spezialisten" }), T0 + 5_000, "de")?.headline).toBe("Suche Spezialisten");
  });

  it("lets a narration line newer than the last progress message speak", () => {
    const messages = turn({
      steps: [{ id: "n1", kind: "note", name: "reviewing", depth: 0, status: "done", startedAt: T0 + 200_000, text: "Prüfe die Quellen." }],
    }, [message({ id: "p1", content: "Ich lese gerade eine Webseite.", progress: true, timestamp: at(120) })]);
    expect(liveActivity(messages, T0 + 210_000, "de")?.headline).toBe("Prüfe die Quellen.");
    // An older narration line does not talk over a progress message that came after it.
    const older = turn({
      steps: [{ id: "n1", kind: "note", name: "reviewing", depth: 0, status: "done", startedAt: T0 + 60_000, text: "Prüfe die Quellen." }],
    }, [message({ id: "p1", content: "Ich lese gerade eine Webseite.", progress: true, timestamp: at(120) })]);
    expect(liveActivity(older, T0 + 130_000, "de")?.headline).toBe("Ich lese gerade eine Webseite.");
  });

  it("falls back to the plain working phrase when the turn has said nothing yet", () => {
    expect(liveActivity(turn({}), T0 + 2_000, "de")?.headline).toBe("Ich bin dran …");
    expect(liveActivity(turn({}), T0 + 2_000, "en")?.headline).toBe("Working on it…");
  });

  it("names the newest running step, with how long it has run", () => {
    const live = liveActivity(turn({
      steps: [
        tool("s1"),
        tool("s2", { status: "running", startedAt: T0 + 20_000, endedAt: undefined }),
        tool("s3", { status: "running", startedAt: T0 + 30_000, endedAt: undefined, args: { url: "https://omniakey.test/qwen-4" } }),
      ],
    }), T0 + 42_000, "de");
    expect(live?.current?.stepId).toBe("s3");
    expect(live?.current?.label).toContain("omniakey.test");
    expect(live?.current?.duration).toBe("12s");
    expect(live?.elapsed).toBe("42s");
  });

  it("puts the steps on the ring oldest first, the newest last, and keeps only the latest few", () => {
    const steps = Array.from({ length: MAX_SATELLITES + 3 }, (_, index) => tool(`s${index}`));
    const live = liveActivity(turn({ steps }), T0 + 60_000, "de");
    expect(live?.satellites).toHaveLength(MAX_SATELLITES);
    expect(live?.satellites[0]?.id).toBe("s3");
    expect(live?.satellites.at(-1)?.id).toBe(`s${MAX_SATELLITES + 2}`);
    expect(live?.satellites.every((satellite) => satellite.nested)).toBe(true);
  });

  it("marks a failed step as failed", () => {
    const live = liveActivity(turn({ steps: [tool("s1", { status: "failed", result: "Error: 404" })] }), T0 + 20_000, "de");
    expect(live?.satellites[0]?.status).toBe("failed");
  });
});

describe("orbitPoint", () => {
  const geometry = { rx: 250, ry: 75, coreRadius: 110 };

  it("puts the newest step nearest the viewer, below the orb", () => {
    const newest = orbitPoint(4, 5, geometry);
    expect(newest.depth).toBeCloseTo(1);
    expect(newest.x).toBeCloseTo(0);
    expect(newest.y).toBeCloseTo(geometry.ry);
    expect(newest.scale).toBeCloseTo(1);
  });

  it("moves each older step further round and away, dimmer and smaller", () => {
    const points = [4, 3, 2].map((index) => orbitPoint(index, 5, geometry));
    expect(points[1]!.depth).toBeLessThan(points[0]!.depth);
    expect(points[2]!.depth).toBeLessThan(points[1]!.depth);
    expect(points[2]!.scale).toBeLessThan(points[1]!.scale);
    expect(points[2]!.opacity).toBeLessThan(points[1]!.opacity);
  });

  it("all but hides a step that passes behind the orb's core", () => {
    // Seven slots: the fourth oldest of seven sits straight behind the orb.
    const behind = orbitPoint(3, 7, { ...geometry, coreRadius: 400 });
    const visible = orbitPoint(3, 7, { ...geometry, coreRadius: 10 });
    expect(behind.depth).toBeLessThan(0);
    expect(behind.opacity).toBeCloseTo(visible.opacity * 0.35);
  });

  it("spreads a few steps over part of the ring, not round all of it", () => {
    const second = orbitPoint(0, 2, geometry);
    expect(second.depth).toBeGreaterThan(0.5);
  });
});

describe("orbitGeometry", () => {
  it("sizes the ring to the orb, which follows the window's height", () => {
    const tall = orbitGeometry(2000, 1500);
    const short = orbitGeometry(2000, 750);
    expect(tall.rx).toBeCloseTo(2 * short.rx);
    expect(tall.rx).toBeGreaterThan(0.1385 * 1500);
    expect(tall.ry).toBeLessThan(tall.rx / 2);
  });

  it("shrinks with the orb in a window far narrower than it is tall", () => {
    expect(orbitGeometry(200, 1000).rx).toBeCloseTo(orbitGeometry(400, 1000).rx / 2);
    expect(orbitGeometry(400, 1000).rx).toBeCloseTo(orbitGeometry(800, 1000).rx);
  });
});

describe("the ring between the messages", () => {
  it("carries a web address as its host, and cuts anything else", () => {
    expect(shortSubject("https://www.omniakey.com/blog/qwen-4-release-date")).toBe("omniakey.com");
    expect(shortSubject("Qwen 4 model Alibaba 2025 release date and variants")).toBe("Qwen 4 model Alibaba 20…");
    expect(shortSubject("Qwen 4")).toBe("Qwen 4");
  });

  it("labels a satellite with its step and the short subject", () => {
    const live = liveActivity(turn({ steps: [tool("s1", { args: { url: "https://www.tech-insider.org/qwen4-four-variants" } })] }), T0 + 20_000, "de");
    expect(live?.satellites[0]?.short).toBe("Webseite lesen · tech-insider.org");
    expect(live?.satellites[0]?.label).toContain("https://www.tech-insider.org/qwen4-four-variants");
  });

  it("measures the band the chat page leaves free around the orb", () => {
    // 2000 × 1500: bubbles of 52rem are wider than the room, so each ends at the orb's zone.
    expect(freeHalfWidth(2000, 1500)).toBeCloseTo(0.24 * 1500 + 24);
    // 1440 × 900: the room left is 460 px, more than 28rem, less than 52rem.
    expect(freeHalfWidth(1440, 900)).toBeCloseTo(0.24 * 900 + 24);
    // A narrow window: the bubbles keep 28rem and come closer to the centre.
    expect(freeHalfWidth(1100, 900)).toBeCloseTo(1100 / 2 - 20 - 448);
    expect(freeHalfWidth(900, 900)).toBe(0);
    // An ultrawide window: the bubbles stop at 52rem, far out at the edges.
    expect(freeHalfWidth(3440, 1440)).toBeCloseTo(3440 / 2 - 20 - 832);
  });

  it("keeps the ring and its labels inside that band, but never inside the orb's torus", () => {
    const roomy = orbitGeometry(2000, 1500, 2000);
    expect(roomy.rx).toBeCloseTo(0.1385 * 1500 * 1.5);
    // Room for a ring between the torus and its widest: it reaches as far as its labels allow.
    const fits = orbitGeometry(1800, 1000, 300);
    expect(fits.rx + LABEL_HALF).toBeCloseTo(300);
    // 1280 × 800 leaves too little: the ring keeps clear of the torus, and its sides go without labels.
    const tight = orbitGeometry(1280, 800, freeHalfWidth(1280, 800));
    expect(tight.rx).toBeCloseTo(0.1385 * 800 * 1.05);
  });

  it("shows a label only where it stays out of the messages", () => {
    const free = freeHalfWidth(1280, 800);
    expect(labelFits(0, free)).toBe(true);
    expect(labelFits(free - LABEL_HALF, free)).toBe(true);
    expect(labelFits(-(free - LABEL_HALF + 1), free)).toBe(false);
  });
});
