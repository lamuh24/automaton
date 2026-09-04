import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getHomeDir } from "../utils/home.js";

const execFile = promisify(execFileCallback);

export const LOCAL_GEMMA_API_URL = "http://127.0.0.1:1234";
export const LOCAL_GEMMA_MODEL = "gemma-local";
export const LOCAL_GEMMA_MODEL_KEY = "google/gemma-4-e4b";
export const LOCAL_GEMMA_CONTEXT_LENGTH = parseContextLength(
  process.env.AUTOMATON_GEMMA_CONTEXT_LENGTH,
);
export const LOCAL_GEMMA_GPU_OFFLOAD = "off";
export const LOCAL_GEMMA_PARALLELISM = 1;

export interface LocalGemmaStatus {
  endpoint: string;
  model: string;
  runner: string;
  started: boolean;
}

/** Ensure the installed LM Studio Gemma model is loaded and locally served. */
export async function ensureLocalGemmaReady(options?: {
  endpoint?: string;
  model?: string;
}): Promise<LocalGemmaStatus> {
  const endpoint = normalizeApiBase(options?.endpoint || LOCAL_GEMMA_API_URL);
  const model = options?.model || LOCAL_GEMMA_MODEL;
  const endpointReady = await endpointHasModel(endpoint, model);
  const lmsPath = findLmsExecutable();

  if (endpointReady) {
    return { endpoint, model, runner: lmsPath || "local OpenAI-compatible server", started: false };
  }

  if (!isLoopback(endpoint)) {
    throw new Error(`Refusing to auto-start a non-local inference endpoint: ${endpoint}`);
  }

  if (!lmsPath) {
    throw new Error(
      "LM Studio's lms.exe was not found. Install LM Studio or set AUTOMATON_INFERENCE_URL " +
      "to another local OpenAI-compatible server.",
    );
  }

  assertLocalInferenceCapacity(LOCAL_GEMMA_CONTEXT_LENGTH);

  const loaded = await runLms(lmsPath, ["ps"]);
  const loadedLine = loaded.stdout.split(/\r?\n/).find((line) => line.includes(model)) || "";
  const modelLoaded = Boolean(loadedLine);
  // Always reload the managed identifier at process startup. Text status does not
  // expose GPU offload, so accepting an already-loaded model could silently reuse
  // an unsafe GPU profile set manually in LM Studio.
  if (modelLoaded) {
    await runLms(lmsPath, ["unload", model]);
  }

  const directRunner = findLowVramLlamaServer();
  const directModel = findLocalGemmaModelFile();
  if (process.platform === "win32" && directRunner && directModel) {
    const url = new URL(endpoint);
    const port = Number(url.port || 80);
    const child = spawn(directRunner, [
      "--model", directModel,
      "--host", url.hostname,
      "--port", String(port),
      "--alias", model,
      "--ctx-size", String(LOCAL_GEMMA_CONTEXT_LENGTH),
      "--n-gpu-layers", "0",
      "--no-kv-offload",
      "--parallel", String(LOCAL_GEMMA_PARALLELISM),
      "--threads", String(Math.max(1, Math.min(10, os.cpus().length))),
      "--jinja",
      "--no-webui",
    ], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();

    for (let attempt = 0; attempt < 90; attempt++) {
      if (await endpointHasModel(endpoint, model)) {
        return { endpoint, model, runner: directRunner, started: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Low-VRAM local Gemma did not become ready at ${endpoint}`);
  }

  await runLms(lmsPath, [
    "load",
    LOCAL_GEMMA_MODEL_KEY,
    "--identifier",
    model,
    "--context-length",
    String(LOCAL_GEMMA_CONTEXT_LENGTH),
    "--gpu",
    LOCAL_GEMMA_GPU_OFFLOAD,
    "--parallel",
    String(LOCAL_GEMMA_PARALLELISM),
    "-y",
  ], 180_000);

  const serverStatus = await runLms(lmsPath, ["server", "status"]);
  if (!/running on port/i.test(serverStatus.stdout)) {
    await runLms(lmsPath, ["server", "start"]);
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    if (await endpointHasModel(endpoint, model)) {
      return { endpoint, model, runner: lmsPath, started: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Local Gemma did not become ready at ${endpoint}`);
}

export async function testLocalGemmaInference(options?: {
  endpoint?: string;
  model?: string;
}): Promise<string> {
  const endpoint = normalizeApiBase(options?.endpoint || LOCAL_GEMMA_API_URL);
  const model = options?.model || LOCAL_GEMMA_MODEL;
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: LOCAL_GEMMA_READY" }],
      max_tokens: 32,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Local Gemma inference failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json() as any;
  const content = String(data.choices?.[0]?.message?.content || "").trim();
  if (!content.includes("LOCAL_GEMMA_READY")) {
    throw new Error(`Unexpected local Gemma response: ${content || "empty response"}`);
  }
  return content;
}

/** Unload the managed model after bounded diagnostics or when resource pressure rises. */
export async function unloadLocalGemma(): Promise<void> {
  const lmsPath = findLmsExecutable();
  if (!lmsPath) return;
  const loaded = await runLms(lmsPath, ["ps"]);
  if (loaded.stdout.includes(LOCAL_GEMMA_MODEL)) {
    await runLms(lmsPath, ["unload", LOCAL_GEMMA_MODEL], 60_000);
  }
}

export function normalizeApiBase(value: string): string {
  return value
    .replace(/\/+$/, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1$/i, "");
}

function findLmsExecutable(): string | null {
  const candidates = [
    path.join(getHomeDir(), ".lmstudio", "bin", "lms.exe"),
    path.join(getHomeDir(), "AppData", "Local", "Programs", "LM Studio", "resources", "app", ".webpack", "lms.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function findLowVramLlamaServer(): string | null {
  const root = path.join(getHomeDir(), ".lmstudio", "extensions", "backends");
  if (!fs.existsSync(root)) return null;
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("llama.cpp-win-x86_64-vulkan-avx2-"))
    .map((entry) => ({
      version: entry.name.slice("llama.cpp-win-x86_64-vulkan-avx2-".length),
      executable: path.join(root, entry.name, "llama-server.exe"),
    }))
    .filter((entry) => fs.existsSync(entry.executable))
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0]?.executable || null;
}

function findLocalGemmaModelFile(): string | null {
  const root = path.join(getHomeDir(), ".lmstudio", "models");
  if (!fs.existsSync(root)) return null;
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (/gemma-4-e4b-it.*\.gguf$/i.test(entry.name) && !/mmproj/i.test(entry.name)) matches.push(candidate);
    }
  }
  matches.sort((a, b) => Number(/q4_k_m/i.test(b)) - Number(/q4_k_m/i.test(a)) || a.localeCompare(b));
  return matches[0] || null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part) || 0);
  const right = b.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function endpointHasModel(endpoint: string, model: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/v1/models`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const data = await response.json() as any;
    return Array.isArray(data.data) && data.data.some((item: any) => item?.id === model);
  } catch {
    return false;
  }
}

async function runLms(
  executable: string,
  args: string[],
  timeout = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFile(executable, args, {
      timeout,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error: any) {
    throw new Error(
      `LM Studio command failed (${args.join(" ")}): ${error?.stderr || error?.message || error}`,
    );
  }
}

function isLoopback(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function assertLocalInferenceCapacity(contextLength: number): void {
  const minimumFreeRam = (contextLength > 65_536 ? 14 : contextLength > 32_768 ? 10 : 8) * 1024 ** 3;
  const freeRam = os.freemem();
  if (freeRam < minimumFreeRam) {
    throw new Error(
      `Gemma requires at least ${(minimumFreeRam / 1024 ** 3).toFixed(0)} GB free RAM before its CPU-only ${contextLength.toLocaleString()}-token context load; ` +
      `${(freeRam / 1024 ** 3).toFixed(1)} GB is available. Close memory-heavy apps and retry.`,
    );
  }

  if (process.platform === "win32") {
    try {
      const systemRoot = path.parse(getHomeDir()).root;
      const stats = fs.statfsSync(systemRoot);
      const freeDisk = Number(stats.bavail) * Number(stats.bsize);
      if (freeDisk < 2 * 1024 ** 3) {
        throw new Error(
          `Windows system drive has only ${(freeDisk / 1024 ** 3).toFixed(1)} GB free. ` +
          "Free at least 2 GB before loading Gemma.",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Windows system drive")) throw error;
    }
  }
}

function parseContextLength(value: string | undefined): number {
  const parsed = Number(value || 24_576);
  if (!Number.isSafeInteger(parsed) || parsed < 4_096 || parsed > 131_072) {
    return 24_576;
  }
  return parsed;
}
