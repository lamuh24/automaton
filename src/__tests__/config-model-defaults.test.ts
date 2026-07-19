import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfig } from "../config.js";

const BASE_PARAMS = {
  name: "Test Automaton",
  genesisPrompt: "Test safely",
  creatorMessage: "",
  creatorAddress: "0x0000000000000000000000000000000000000000",
  registeredWithConway: false,
  sandboxId: "",
  walletAddress: "0x0000000000000000000000000000000000000000",
  apiKey: "test-conway-key",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider-aware model defaults", () => {
  it("keeps Conway-compatible defaults without direct OpenAI access", () => {
    vi.stubEnv("OPENAI_API_KEY", "");

    const config = createConfig(BASE_PARAMS);

    expect(config.inferenceModel).toBe("gpt-5.2");
    expect(config.modelStrategy?.lowComputeModel).toBe("gpt-5-mini");
  });

  it("uses the GPT-5.6 family when OpenAI is provided by environment", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");

    const config = createConfig(BASE_PARAMS);

    expect(config.openaiApiKey).toBeUndefined();
    expect(config.inferenceModel).toBe("gpt-5.6-sol");
    expect(config.modelStrategy).toMatchObject({
      inferenceModel: "gpt-5.6-sol",
      lowComputeModel: "gpt-5.6-terra",
      criticalModel: "gpt-5.6-luna",
    });
  });
});
