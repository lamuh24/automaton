import { afterEach, describe, expect, it, vi } from "vitest";
import { createInferenceClient } from "../conway/inference.js";
import {
  LOCAL_GEMMA_CONTEXT_LENGTH,
  LOCAL_GEMMA_GPU_OFFLOAD,
  LOCAL_GEMMA_MODEL,
  LOCAL_GEMMA_PARALLELISM,
  normalizeApiBase,
} from "../inference/lm-studio.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("proprietary inference connection", () => {
  it("uses the installed Gemma identifier and practical default context", () => {
    expect(LOCAL_GEMMA_MODEL).toBe("gemma-local");
    expect(LOCAL_GEMMA_CONTEXT_LENGTH).toBe(24_576);
    expect(LOCAL_GEMMA_GPU_OFFLOAD).toBe("off");
    expect(LOCAL_GEMMA_PARALLELISM).toBe(1);
    expect(normalizeApiBase("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234");
  });

  it("accepts an OpenAI-compatible base URL with an existing /v1 suffix", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "local-response",
      model: "proprietary-model",
      choices: [{ message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetchSpy as typeof fetch;

    const client = createInferenceClient({
      apiUrl: "",
      apiKey: "",
      customApiUrl: "http://127.0.0.1:11434/v1",
      customApiKey: "proprietary-key",
      defaultModel: "proprietary-model",
      maxTokens: 256,
    });

    const result = await client.chat([{ role: "user", content: "ping" }]);

    expect(result.message.content).toBe("ready");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer proprietary-key" }),
      }),
    );
  });
});
