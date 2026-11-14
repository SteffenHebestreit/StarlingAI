import { describe, expect, it } from "vitest";
import { LABEL_HALF, MAX_SATELLITES, ORB_SCREEN_SHARE, LABEL_DROP, LABEL_MIN_DEPTH, LABEL_WIDEST, activityRing, freeHalfWidth, labelPlacement, liveActivity, placeLabels, projectOrbPoint, ringPosition, orbitGeometry, orbitPoint, shortSubject, type ActivityMessage } from "./orbActivity";
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
  // The step ring on a 2000 × 1500 window, as the orb canvas draws it.
  const view = { ring: activityRing(2000, 1500), width: 2000, height: 1500, coreRadius: 110 };

  it("puts the newest step nearest the viewer, below the orb", () => {
    const newest = orbitPoint(4, 5, view);
    expect(newest.depth).toBeCloseTo(1);
    expect(newest.x).toBeCloseTo(0);
    expect(newest.y).toBeGreaterThan(40);
    expect(newest.scale).toBeCloseTo(1);
  });

  it("moves each older step further round and away, dimmer and smaller", () => {
    const points = [4, 3, 2].map((index) => orbitPoint(index, 5, view));
    expect(points[1]!.depth).toBeLessThan(points[0]!.depth);
    expect(points[2]!.depth).toBeLessThan(points[1]!.depth);
    expect(points[2]!.scale).toBeLessThan(points[1]!.scale);
    expect(points[2]!.opacity).toBeLessThan(points[1]!.opacity);
  });

  it("all but hides a step that passes behind the orb's core", () => {
    // Seven slots: the fourth oldest of seven sits straight behind the orb.
    const behind = orbitPoint(3, 7, { ...view, coreRadius: 400 });
    const visible = orbitPoint(3, 7, { ...view, coreRadius: 10 });
    expect(behind.depth).toBeLessThan(0);
    expect(behind.opacity).toBeCloseTo(visible.opacity * 0.35);
  });

  it("spreads a few steps over part of the ring, not round all of it", () => {
    const second = orbitPoint(0, 2, view);
    expect(second.depth).toBeGreaterThan(0.5);
  });

  it("sees the ring in perspective, as the canvas does: its near side lower and wider than its far side is high", () => {
    const front = orbitPoint(0, 1, view);
    const back = projectOrbPoint(ringPosition(-Math.PI / 2, view.ring), 2000, 1500);
    expect(front.y).toBeGreaterThan(-back.y);
  });
});

describe("the step ring, drawn by the canvas and the page alike", () => {
  it("projects the edge of the orb's body where the canvas draws it", () => {
    // OrbCanvas frames the orb's body (radius 1.9) at ORB_SCREEN_SHARE (≈ 0.138) of the window's height.
    expect(projectOrbPoint([1.9, 0, 0], 2000, 1500).x).toBeCloseTo(ORB_SCREEN_SHARE * 1500, 0);
    expect(projectOrbPoint([1.9, 0, 0], 2000, 750).x).toBeCloseTo(ORB_SCREEN_SHARE * 750, 0);
    // A window far narrower than tall widens the canvas's field of view, and shrinks the orb.
    expect(projectOrbPoint([1.9, 0, 0], 200, 1000).x).toBeCloseTo(projectOrbPoint([1.9, 0, 0], 400, 1000).x / 2, 1);
  });

  it("draws y downwards, and a point nearer the viewer larger", () => {
    expect(projectOrbPoint([0, 1, 0], 2000, 1500).y).toBeLessThan(0);
    expect(projectOrbPoint([1, 0, 1], 2000, 1500).x).toBeGreaterThan(projectOrbPoint([1, 0, 0], 2000, 1500).x);
    expect(projectOrbPoint([1, 0, 1], 2000, 1500).scale).toBeGreaterThan(1);
  });

  it("is as wide at its sides as the page's ring, in the orb's units", () => {
    const geometry = orbitGeometry(1800, 1000, 300);
    const ring = activityRing(1800, 1000, 300);
    expect(projectOrbPoint(ringPosition(0, ring), 1800, 1000).x).toBeCloseTo(geometry.rx, 1);
    expect(activityRing(2000, 1500).radius).toBeCloseTo(1.9 * 1.5);
  });

  it("tips its front towards the viewer and below the orb, about 0.28 as tall as wide", () => {
    const [, y, z] = ringPosition(Math.PI / 2, activityRing(2000, 1500));
    expect(y).toBeLessThan(0);
    expect(z).toBeGreaterThan(0);
    expect(Math.sin(activityRing(2000, 1500).tilt)).toBeCloseTo(0.28);
  });
});

describe("orbitGeometry", () => {
  it("sizes the ring to the orb, which follows the window's height", () => {
    const tall = orbitGeometry(2000, 1500);
    const short = orbitGeometry(2000, 750);
    expect(tall.rx).toBeCloseTo(2 * short.rx);
    expect(tall.rx).toBeGreaterThan(ORB_SCREEN_SHARE * 1500);
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

  it("names a plan that is still running as running, in the status line and on the ring", () => {
    const plan = tool("plan", { name: "record_plan", status: "running", args: { steps: [{}, {}, {}, {}] } });
    const read = tool("s1", { status: "done", args: { url: "https://example.org/a" } });
    const live = liveActivity(turn({ steps: [plan, read] }), T0 + 77_000, "de");
    // The plan is the only step still open: it was "4 Schritte geplant" beside a spinner.
    expect(live?.current?.label).toBe("Plan läuft · 4 Schritte");
    expect(live?.satellites[0]?.short).toBe("Plan läuft · 4 Schritte");
    expect(liveActivity(turn({ steps: [plan, read] }), T0 + 77_000, "en")?.current?.label).toBe("Running the plan · 4 steps");
    // A step with a subject carries it alone as well, for a label with little room; one without has none.
    expect(live?.satellites[1]?.subject).toBe("example.org");
    expect(live?.satellites[0]?.subject).toBeUndefined();
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

  it("keeps the ring and its labels inside that band, but never inside the orb", () => {
    const roomy = orbitGeometry(2000, 1500, 2000);
    expect(roomy.rx).toBeCloseTo(ORB_SCREEN_SHARE * 1500 * 1.5);
    // Room for a ring between the orb and its widest: it reaches as far as its labels allow.
    const fits = orbitGeometry(1800, 1000, 300);
    expect(fits.rx + LABEL_HALF).toBeCloseTo(300);
    // 1280 × 800 leaves too little: the ring keeps clear of the orb, and its sides go without labels.
    const tight = orbitGeometry(1280, 800, freeHalfWidth(1280, 800));
    expect(tight.rx).toBeCloseTo(ORB_SCREEN_SHARE * 800 * 1.05);
  });

  it("gives the room up that the round controls' lane takes at the outer edge", () => {
    // Roomy: the bubble gets narrower by the lane and still ends at the orb's zone.
    expect(freeHalfWidth(2000, 1500, 16, 60)).toBeCloseTo(freeHalfWidth(2000, 1500));
    // At its 28rem the bubble cannot give more, and comes nearer by the lane.
    expect(freeHalfWidth(1100, 900, 16, 60)).toBeCloseTo(freeHalfWidth(1100, 900) - 60);
    // At 52rem it was not using the room anyway: the lane only moves it in.
    expect(freeHalfWidth(3440, 1440, 16, 60)).toBeCloseTo(freeHalfWidth(3440, 1440) - 60);
  });
});

describe("labelPlacement", () => {
  // The live window: 1788 × 1418, a ring 259 px to each side, 364 px free either side of the centre.
  const free = freeHalfWidth(1788, 1418);
  const rx = orbitGeometry(1788, 1418, free).rx;

  it("hangs the front step's label centred under it, at full width", () => {
    expect(labelPlacement(0, 1, rx, free)).toEqual({ lean: 0, maxWidth: LABEL_WIDEST });
  });

  it("leans a label beside the front outwards, away from the ring's descending arc", () => {
    // One slot round from the front on a seven-slot ring: 51° — 0.78 of the half-width, depth 0.62.
    const left = labelPlacement(-0.78 * rx, 0.62, rx, free)!;
    const right = labelPlacement(0.78 * rx, 0.62, rx, free)!;
    expect(left.lean).toBe(-1);
    expect(right.lean).toBe(1);
    // All of it on the outer side of its point, and none of it in the messages.
    expect(0.78 * rx + right.maxWidth).toBeLessThanOrEqual(free);
    expect(right.maxWidth).toBe(left.maxWidth);
    expect(right.maxWidth).toBeGreaterThan(120);
  });

  it("leans gradually near the front, so the label does not jump as the ring sways", () => {
    const slight = labelPlacement(0.1 * rx, 0.99, rx, free)!;
    expect(slight.lean).toBeGreaterThan(0);
    expect(slight.lean).toBeLessThan(0.25);
  });

  it("leaves a step further round the ring a point: small and out of focus, its label was unreadable", () => {
    // Two slots round: at the ring's end, depth -0.22 — labelled before, 7 px tall.
    expect(labelPlacement(-0.97 * rx, -0.22, rx, free)).toBeNull();
    expect(labelPlacement(0.9 * rx, LABEL_MIN_DEPTH - 0.01, rx, free)).toBeNull();
    expect(labelPlacement(0.9 * rx, LABEL_MIN_DEPTH, rx, free)).not.toBeNull();
  });

  it("leaves a step a point where the messages leave its label no room", () => {
    // 1280 × 800: 172 px free, the ring 116 px wide — beside the front there are 74 px left.
    const tightFree = freeHalfWidth(1280, 800);
    const tightRx = orbitGeometry(1280, 800, tightFree).rx;
    expect(labelPlacement(0.78 * tightRx, 0.62, tightRx, tightFree)).toBeNull();
    expect(labelPlacement(0, 1, tightRx, tightFree)).toEqual({ lean: 0, maxWidth: LABEL_WIDEST });
  });
});

describe("placeLabels", () => {
  it("keeps the nearer label and leaves the one it would cover a point", () => {
    // The 1600 × 900 ring: the front step's label lay across the step beside it.
    const shown = placeLabels([
      { id: "front", x: 0, y: 38, scale: 1, text: "Read a web page · arxiv.org" },
      { id: "side", x: 95, y: 30, scale: 0.9, text: "Looked for the right specialist" },
    ]);
    expect([...shown]).toEqual(["front"]);
  });

  it("shows every label that has room", () => {
    const shown = placeLabels([
      { id: "front", x: 0, y: 38, scale: 1, text: "Read a web page · arxiv.org" },
      { id: "left", x: -260, y: 10, scale: 0.8, text: "Searched the web" },
      { id: "right", x: 260, y: 10, scale: 0.8, text: "Delegated to Researcher" },
    ]);
    expect(shown.size).toBe(3);
  });

  it("measures a label by its text and its depth", () => {
    // Side by side at 150 px: two short labels fit, two long ones touch.
    const short = placeLabels([{ id: "a", x: 0, y: 0, scale: 1, text: "Websuche" }, { id: "b", x: 150, y: 0, scale: 1, text: "Websuche" }]);
    expect(short.size).toBe(2);
    const long = placeLabels([{ id: "a", x: 0, y: 0, scale: 1, text: "Read a web page · techtarget.com" }, { id: "b", x: 150, y: 0, scale: 1, text: "Read a web page · techtarget.com" }]);
    expect(long.size).toBe(1);
    const far = placeLabels([{ id: "a", x: 0, y: 0, scale: 0.5, text: "Read a web page · techtarget.com" }, { id: "b", x: 150, y: 0, scale: 0.5, text: "Read a web page · techtarget.com" }]);
    expect(far.size).toBe(2);
  });

  it("measures a leaning label on the side it hangs", () => {
    const text = "Read a web page · arxiv.org";
    // Centred, the front label and the one beside it at 150 px overlap; leaning out, they do not.
    const centred = placeLabels([{ id: "front", x: 0, y: 30, scale: 1, text }, { id: "side", x: 150, y: 30, scale: 1, text }]);
    expect(centred.size).toBe(1);
    const leaning = placeLabels([{ id: "front", x: 0, y: 30, scale: 1, text, lean: 0, maxWidth: 210 }, { id: "side", x: 150, y: 30, scale: 1, text, lean: 1, maxWidth: 150 }]);
    expect(leaning.size).toBe(2);
    // A label cut to its room is measured at that width, not at its text's.
    const cut = placeLabels([{ id: "a", x: 0, y: 0, scale: 1, text, lean: 1, maxWidth: 100 }, { id: "b", x: 110, y: 0, scale: 1, text, lean: 1, maxWidth: 100 }]);
    expect(cut.size).toBe(2);
    expect(LABEL_DROP).toBeGreaterThan(11);
  });

  it("does not count labels on different rows as covering", () => {
    const shown = placeLabels([{ id: "a", x: 0, y: 0, scale: 1, text: "Read a web page · arxiv.org" }, { id: "b", x: 10, y: 40, scale: 1, text: "Read a web page · arxiv.org" }]);
    expect(shown.size).toBe(2);
  });
});
