import fs from "node:fs";
import path from "node:path";
import { createConfig, getConfigPath, saveConfig } from "../src/config.js";
import { writeDefaultHeartbeatConfig } from "../src/heartbeat/config.js";
import { getAutomatonDir, getWallet } from "../src/identity/wallet.js";
import { LOCAL_GEMMA_API_URL } from "../src/inference/lm-studio.js";
import { generateSoulMd, installDefaultSkills } from "../src/setup/defaults.js";
import { DEFAULT_TREASURY_POLICY } from "../src/types.js";

const name = process.env.AUTOMATON_NAME?.trim() || "Lamuh Automaton";
const genesisPrompt = process.env.AUTOMATON_GENESIS_PROMPT?.trim() || [
  "You are Lamuh Automaton, a local-first autonomous operator running on Lamuh's main PC.",
  "Use Lamuh's proprietary workflows, local files, local Git, local WSL2 virtual machines,",
  "and the local Gemma model served by LM Studio. Do not use Conway services, cloud model",
  "APIs, or API keys. Protect user data, prefer reversible changes, stay within configured",
  "resource limits, and verify work before reporting completion.",
].join(" ");

async function main(): Promise<void> {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    throw new Error(`Automaton is already configured at ${configPath}`);
  }

  const { chainIdentity, chainType } = await getWallet("evm");
  const automatonDir = getAutomatonDir();
  const workspaceRoot = process.env.AUTOMATON_WORKSPACE_ROOT || "E:/Automaton/workspaces";

  const config = createConfig({
    name,
    genesisPrompt,
    creatorAddress: chainIdentity.address,
    registeredLocally: true,
    runtimeBackend: "local",
    localVmBackend: "wsl",
    sandboxId: "",
    walletAddress: chainIdentity.address,
    inferenceApiUrl: LOCAL_GEMMA_API_URL,
    hostWorkingDirectory: process.cwd(),
    localWorkspaceRoot: workspaceRoot,
    treasuryPolicy: { ...DEFAULT_TREASURY_POLICY },
    chainType,
  });

  saveConfig(config);
  writeDefaultHeartbeatConfig();

  const constitutionSource = path.join(process.cwd(), "constitution.md");
  const constitutionTarget = path.join(automatonDir, "constitution.md");
  if (fs.existsSync(constitutionSource)) {
    fs.copyFileSync(constitutionSource, constitutionTarget);
    fs.chmodSync(constitutionTarget, 0o444);
  }

  fs.writeFileSync(
    path.join(automatonDir, "SOUL.md"),
    generateSoulMd(name, chainIdentity.address, chainIdentity.address, genesisPrompt),
    { mode: 0o600 },
  );
  installDefaultSkills(config.skillsDir || "~/.automaton/skills");

  console.log(JSON.stringify({
    status: "configured",
    name,
    address: chainIdentity.address,
    runtimeBackend: config.runtimeBackend,
    inferenceModel: config.inferenceModel,
    inferenceApiUrl: config.inferenceApiUrl,
    localVmBackend: config.localVmBackend,
    localWorkspaceRoot: config.localWorkspaceRoot,
    configPath,
  }, null, 2));
}

await main();
