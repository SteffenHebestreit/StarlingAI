import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory credential store so saveScene/getScene round-trip without touching the
// real encrypted on-disk store (no SAI_MASTER_KEY, no salt file, no side effects).
const store = new Map<string, string>();
vi.mock("../credentials/store.js", () => ({
  getCredential: (k: string) => store.get(k) ?? null,
  setCredential: (k: string, v: string) => { store.set(k, v); },
  deleteCredential: (k: string) => { store.delete(k); },
  listCredentialNames: () => [...store.keys()],
}));
// No config-file scenes, so getScene/listAllScenes fall through to the store branch.
vi.mock("../config/loader.js", () => ({ getConfig: () => ({ scenes: {} }) }));

const { saveScene, getScene, listAllScenes, deleteScene } = await import("../credentials/scenes.js");

describe("saveScene — non-lossy structured-extras round-trip (was dropping allowedAgents/params/triggers)", () => {
  beforeEach(() => store.clear());

  it("round-trips allowedAgents / params / expectArtifact / humanInLoopSteps through the store", () => {
    saveScene("pois_near", {
      description: "Show POIs near a place",
      task: "geocode {place}, then query nearby POIs",
      allowedAgents: ["cartographer", "backend_coder"],
      params: { place: { description: "city or address" } },
      humanInLoopSteps: ["serve_app"],
      expectArtifact: true,
    });
    const s = getScene("pois_near");
    expect(s).not.toBeNull();
    expect(s!.source).toBe("store");
    expect(s!.allowedAgents).toEqual(["cartographer", "backend_coder"]);
    expect(s!.params).toEqual({ place: { description: "city or address" } });
    expect(s!.humanInLoopSteps).toEqual(["serve_app"]);
    expect(s!.expectArtifact).toBe(true);
    // and through the list view
    const listed = listAllScenes().find((x) => x.name === "pois_near");
    expect(listed?.allowedAgents).toEqual(["cartographer", "backend_coder"]);
    expect(listed?.expectArtifact).toBe(true);
  });

  it("a scene saved with no extras reads back cleanly (back-compat, no meta blob)", () => {
    saveScene("plain", { description: "d", task: "t" });
    expect(store.has("scene:plain:meta")).toBe(false);
    const s = getScene("plain");
    expect(s?.allowedAgents).toBeUndefined();
    expect(s?.expectArtifact).toBeUndefined();
  });

  it("re-saving without extras clears a previously-stored meta blob", () => {
    saveScene("toggle", { description: "d", task: "t", allowedAgents: ["x"] });
    expect(store.has("scene:toggle:meta")).toBe(true);
    saveScene("toggle", { description: "d", task: "t" });
    expect(store.has("scene:toggle:meta")).toBe(false);
    expect(getScene("toggle")?.allowedAgents).toBeUndefined();
  });

  it("deleteScene removes the meta blob too", () => {
    saveScene("temp", { description: "d", task: "t", allowedAgents: ["x"] });
    deleteScene("temp");
    expect(getScene("temp")).toBeNull();
    expect(store.has("scene:temp:meta")).toBe(false);
  });
});
