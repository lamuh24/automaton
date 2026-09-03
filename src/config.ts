/**
 * Automaton Configuration
 *
 * Loads and saves the automaton's configuration from ~/.automaton/automaton.json
 */

import fs from "fs";
import path from "path";
import type { AutomatonConfig, TreasuryPolicy, ModelStrategyConfig, SoulConfig } from "./types.js";
import { DEFAULT_CONFIG, DEFAULT_TREASURY_POLICY, DEFAULT_MODEL_STRATEGY_CONFIG, DEFAULT_SOUL_CONFIG } from "./types.js";
import { getAutomatonDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { createLogger } from "./observability/logger.js";
import type { ChainType } from "./identity/chain.js";
import { resolveHomePath } from "./utils/home.js";

const logger = createLogger("config");
const CONFIG_FILENAME = "automaton.json";

export function getConfigPath(): string {
  return path.join(getAutomatonDir(), CONFIG_FILENAME);
}

/**
 * Load the automaton config from disk.
 * Merges with defaults for any missing fields.
 */
export function loadConfig(): AutomatonConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const apiKey = raw.conwayApiKey ||
      (raw.runtimeBackend === "conway" ? loadApiKeyFromConfig() : "");

    // Deep-merge treasury policy with defaults
    const treasuryPolicy: TreasuryPolicy = {
      ...DEFAULT_TREASURY_POLICY,
      ...(raw.treasuryPolicy ?? {}),
    };

    // Validate all treasury values are positive numbers
    for (const [key, value] of Object.entries(treasuryPolicy)) {
      if (key === "x402AllowedDomains") continue; // array, not number
      if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) {
        logger.warn(`Invalid treasury value for ${key}: ${value}, using default`);
        (treasuryPolicy as any)[key] = (DEFAULT_TREASURY_POLICY as any)[key];
      }
    }

    // Deep-merge model strategy config with defaults
    const modelStrategy: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      ...(raw.modelStrategy ?? {}),
    };

    // Deep-merge soul config with defaults
    const soulConfig: SoulConfig = {
      ...DEFAULT_SOUL_CONFIG,
      ...(raw.soulConfig ?? {}),
    };

    const config = {
      ...DEFAULT_CONFIG,
      ...raw,
      sandboxId:
        typeof raw.sandboxId === "string"
          ? raw.sandboxId.trim()
          : DEFAULT_CONFIG.sandboxId,
      conwayApiKey: apiKey,
      treasuryPolicy,
      modelStrategy,
      soulConfig,
      chainType: raw.chainType || "evm",
    } as AutomatonConfig;

    if ((config.runtimeBackend || "local") === "local") {
      config.inferenceApiUrl = raw.inferenceApiUrl || DEFAULT_CONFIG.inferenceApiUrl;
      config.inferenceApiKey = undefined;
      config.openaiApiKey = undefined;
      config.anthropicApiKey = undefined;
      config.ollamaBaseUrl = undefined;
      config.socialRelayUrl = undefined;
      config.inferenceModel = "gemma-local";
      config.modelStrategy = {
        ...modelStrategy,
        inferenceModel: "gemma-local",
        lowComputeModel: "gemma-local",
        criticalModel: "gemma-local",
        hourlyBudgetCents: 0,
        sessionBudgetCents: 0,
        perCallCeilingCents: 0,
      };
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Save the automaton config to disk.
 * Includes treasuryPolicy in the persisted config.
 */
export function saveConfig(config: AutomatonConfig): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  const toSave: Record<string, unknown> = {
    ...config,
    treasuryPolicy: config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: config.soulConfig ?? DEFAULT_SOUL_CONFIG,
  };
  if ((config.runtimeBackend || "local") === "local") {
    delete toSave.registeredWithConway;
    delete toSave.conwayApiUrl;
    delete toSave.conwayApiKey;
    delete toSave.openaiApiKey;
    delete toSave.anthropicApiKey;
    delete toSave.inferenceApiKey;
    delete toSave.ollamaBaseUrl;
    delete toSave.socialRelayUrl;
  }
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), {
    mode: 0o600,
  });
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  return resolveHomePath(p);
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  registeredLocally?: boolean;
  registeredWithConway?: boolean;
  sandboxId: string;
  walletAddress: string;
  apiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  inferenceApiUrl?: string;
  inferenceApiKey?: string;
  runtimeBackend?: "local" | "conway";
  hostWorkingDirectory?: string;
  localWorkspaceRoot?: string;
  localVmBackend?: "wsl" | "workspace";
  parentAddress?: string;
  treasuryPolicy?: TreasuryPolicy;
  chainType?: ChainType;
}): AutomatonConfig {
  const normalizedSandboxId = (params.sandboxId || "").trim();
  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredLocally: params.registeredLocally ?? params.runtimeBackend !== "conway",
    ...(params.runtimeBackend === "conway"
      ? { registeredWithConway: params.registeredWithConway || false }
      : {}),
    sandboxId: normalizedSandboxId,
    runtimeBackend: params.runtimeBackend || "local",
    conwayApiUrl: DEFAULT_CONFIG.conwayApiUrl || "",
    conwayApiKey: params.apiKey || "",
    openaiApiKey: params.openaiApiKey,
    anthropicApiKey: params.anthropicApiKey,
    ollamaBaseUrl: params.ollamaBaseUrl,
    inferenceApiUrl: params.inferenceApiUrl || DEFAULT_CONFIG.inferenceApiUrl,
    inferenceApiKey: params.inferenceApiKey,
    hostWorkingDirectory: params.hostWorkingDirectory || process.cwd(),
    localWorkspaceRoot: params.localWorkspaceRoot || DEFAULT_CONFIG.localWorkspaceRoot,
    localVmBackend: params.localVmBackend ||
      (process.platform === "win32" ? "wsl" : "workspace"),
    localComputeBudgetCents: DEFAULT_CONFIG.localComputeBudgetCents,
    inferenceModel: DEFAULT_CONFIG.inferenceModel || "gemma-local",
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: DEFAULT_CONFIG.maxChildren || 3,
    parentAddress: params.parentAddress,
    treasuryPolicy: params.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    chainType: params.chainType || "evm",
  };
}
