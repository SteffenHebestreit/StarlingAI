import { afterEach, describe, expect, it } from "vitest";
import {
  _resetLlmBoundaryForTests,
  registerLlmBoundaryTransformer,
  wrapProviderWithBoundary,
} from "../providers/llm-boundary.js";
import type { ChatProvider, LLMMessage, LLMResponse } from "../providers/lmstudio.js";

afterEach(_resetLlmBoundaryForTests);

function fakeProvider(): { provider: ChatProvider; seen: { messages: LLMMessage[][] } } {
  const seen = { messages: [] as LLMMessage[][] };
  const response: LLMResponse = { content: "Patient [PATIENT_A] ist stabil.", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
  const provider: ChatProvider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    isHealthy: () => true,
    embed: async () => [],
    complete: async (messages) => {
      seen.messages.push(messages);
      return response;
    },
    completeViaStream: async (messages) => {
      seen.messages.push(messages);
      return response;
    },
    stream: async function* (messages) {
      seen.messages.push(messages);
      yield { type: "text_delta", content: "chunk" };
      yield { type: "done" };
    },
  };
  return { provider, seen };
}

const redactor = {
  beforeRequest(messages: LLMMessage[]) {
    return messages.map((m) =>
      typeof m.content === "string" ? { ...m, content: m.content.replaceAll("Frau Müller", "[PATIENT_A]") } : m,
    );
  },
  afterResponse(text: string) {
    return text.replaceAll("[PATIENT_A]", "Frau Müller");
  },
};

describe("llm boundary transformers", () => {
  it("is the identity when nothing is registered", async () => {
    const { provider, seen } = fakeProvider();
    const wrapped = wrapProviderWithBoundary(provider);
    const result = await wrapped.complete([{ role: "user", content: "Frau Müller hustet." }], []);
    expect(seen.messages[0]![0]!.content).toBe("Frau Müller hustet.");
    expect(result.content).toBe("Patient [PATIENT_A] ist stabil.");
  });

  it("redacts outbound and rehydrates inbound on complete()", async () => {
    registerLlmBoundaryTransformer("test", redactor);
    const { provider, seen } = fakeProvider();
    const wrapped = wrapProviderWithBoundary(provider);
    const original: LLMMessage[] = [{ role: "user", content: "Frau Müller hustet." }];
    const result = await wrapped.complete(original, []);
    // outbound view transformed…
    expect(seen.messages[0]![0]!.content).toBe("[PATIENT_A] hustet.");
    // …caller's array untouched…
    expect(original[0]!.content).toBe("Frau Müller hustet.");
    // …inbound text rehydrated.
    expect(result.content).toBe("Patient Frau Müller ist stabil.");
  });

  it("covers completeViaStream and the outbound side of stream()", async () => {
    registerLlmBoundaryTransformer("test", redactor);
    const { provider, seen } = fakeProvider();
    const wrapped = wrapProviderWithBoundary(provider);
    await wrapped.completeViaStream!([{ role: "user", content: "Frau Müller" }], []);
    const chunks = [];
    for await (const chunk of wrapped.stream([{ role: "user", content: "Frau Müller" }], [])) chunks.push(chunk);
    expect(seen.messages.every((batch) => batch[0]!.content === "[PATIENT_A]")).toBe(true);
    expect(chunks).toHaveLength(2);
  });

  it("pipes streamed deltas through createStreamTransform (marker split across chunks)", async () => {
    registerLlmBoundaryTransformer("stream-test", {
      createStreamTransform() {
        let buf = "";
        return {
          push(delta: string) {
            buf += delta;
            // hold back a trailing unclosed "[" (a potential split marker)
            const open = buf.lastIndexOf("[");
            const end = open !== -1 && !buf.slice(open).includes("]") ? open : buf.length;
            const emit = buf.slice(0, end).replaceAll("[PATIENT_A]", "Frau Müller");
            buf = buf.slice(end);
            return emit;
          },
          flush() { const out = buf.replaceAll("[PATIENT_A]", "Frau Müller"); buf = ""; return out; },
        };
      },
    });
    const provider: ChatProvider = {
      checkHealth: async () => ({ healthy: true }),
      verifyToolCallSupport: async () => true,
      isHealthy: () => true,
      embed: async () => [],
      complete: async () => ({ content: "", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" }),
      stream: async function* () {
        yield { type: "text_delta", content: "Patient [PAT" };
        yield { type: "text_delta", content: "IENT_A] ist stabil." };
        yield { type: "done" };
      },
    };
    const wrapped = wrapProviderWithBoundary(provider);
    let text = "";
    for await (const chunk of wrapped.stream([{ role: "user", content: "x" }], [])) {
      if (chunk.type === "text_delta" && chunk.content) text += chunk.content;
      expect(chunk.content ?? "").not.toContain("[PAT"); // never a half-rehydrated marker
    }
    expect(text).toBe("Patient Frau Müller ist stabil.");
  });

  it("fails closed when beforeRequest throws", async () => {
    registerLlmBoundaryTransformer("test", {
      beforeRequest() {
        throw new Error("redactor broken");
      },
    });
    const { provider } = fakeProvider();
    const wrapped = wrapProviderWithBoundary(provider);
    await expect(wrapped.complete([{ role: "user", content: "x" }], [])).rejects.toThrow(/redactor broken/);
  });

  it("fails open when afterResponse throws", async () => {
    registerLlmBoundaryTransformer("test", {
      afterResponse() {
        throw new Error("rehydrator broken");
      },
    });
    const { provider } = fakeProvider();
    const wrapped = wrapProviderWithBoundary(provider);
    const result = await wrapped.complete([{ role: "user", content: "x" }], []);
    expect(result.content).toBe("Patient [PATIENT_A] ist stabil.");
  });
});

/**
 * A LATENT CONTRACT HOLE, NOT A PRODUCTION DROP.
 *
 * The Proxy's complete() arm was a 3-parameter closure while the completeViaStream and stream()
 * arms forwarded their 4th `options` argument. Nothing reaches the dropping arm today:
 * createChatProvider builds only LMStudioProvider, AnthropicProvider or FailoverChatProvider,
 * all three implement completeViaStream, and both call sites branch on completeViaStream first.
 * But completeViaStream is OPTIONAL on ChatProvider — a conforming provider that implements
 * complete() alone would have silently lost the per-call thinking controls, the max_tokens
 * ceiling and tool_choice. Closed so the optional method cannot become load-bearing by accident.
 *
 * The double below implements complete() and NOTHING else on that path, and the call goes
 * through the wrapper: a bare double would never touch the Proxy and would pass either way.
 */
describe("the boundary forwards per-call options on every arm", () => {
  it("complete()-only provider: the options bag reaches it through the Proxy", async () => {
    registerLlmBoundaryTransformer("test", redactor);
    const seen: Array<unknown> = [];
    const completeOnly = {
      checkHealth: async () => ({ healthy: true }),
      verifyToolCallSupport: async () => true,
      isHealthy: () => true,
      embed: async () => [],
      complete: async (_m: LLMMessage[], _t: unknown, _s: unknown, options?: unknown) => {
        seen.push(options);
        return { content: "ok", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" } as LLMResponse;
      },
      stream: async function* () { yield { type: "done" as const }; },
    } as unknown as ChatProvider;
    // The hole exists precisely because this is absent.
    expect(completeOnly.completeViaStream).toBeUndefined();

    const wrapped = wrapProviderWithBoundary(completeOnly);
    const bag = { toolChoice: "required" as const, maxTokens: 512, controls: { enableThinking: false } };
    await wrapped.complete([{ role: "user", content: "x" }], [], undefined, bag);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(bag);
  });
});
