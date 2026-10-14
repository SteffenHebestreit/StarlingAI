import { describe, expect, it } from "vitest";
import type { HubVoiceInfo } from "@/stores/gateway";
import { cleanVoiceName, voiceCaption, voiceSpeaks, voicesFor } from "./voicePresets";

const voice = (id: string, language?: string, kind: HubVoiceInfo["kind"] = "builtin"): HubVoiceInfo =>
  ({ id, name: id.split(":")[1]!, engine: id.split(":")[0]!, kind, ...(language ? { language } : {}) });

describe("voices for a language", () => {
  const catalog = [
    voice("piper:en_US-amy-medium", "en_US"),
    voice("saved:luna", "German", "saved"),
    voice("piper:de_DE-thorsten-medium", "de_DE"),
    voice("magpie:Sofia", "multilingual"),
  ];

  it("tells a voice's language by its locale or its name", () => {
    expect(voiceSpeaks({ language: "de_DE" }, "de")).toBe(true);
    expect(voiceSpeaks({ language: "German" }, "de")).toBe(true);
    expect(voiceSpeaks({ language: "en_US" }, "de")).toBe(false);
    expect(voiceSpeaks({}, "de")).toBe(true);
    expect(voiceSpeaks({ language: "en_US" }, "*")).toBe(true);
    expect(voiceSpeaks({ language: "multilingual" }, "de")).toBe(true);
  });

  it("offers the voices meant for the language first, then the rest", () => {
    expect(voicesFor(catalog, "de").map((entry) => entry.id)).toEqual([
      "piper:de_DE-thorsten-medium", "saved:luna", "magpie:Sofia", "piper:en_US-amy-medium",
    ]);
  });

  it("names where a voice comes from", () => {
    expect(voiceCaption(voice("saved:luna", "German", "saved"))).toBe("your voice · German");
    expect(voiceCaption(voice("magpie:Sofia"))).toBe("magpie");
  });

  it("keeps a voice name to what the service accepts", () => {
    expect(cleanVoiceName("  Luna <3 neu! ")).toBe("Luna 3 neu");
    expect(cleanVoiceName("x".repeat(60))).toHaveLength(48);
  });
});
