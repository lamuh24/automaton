import { exec as execCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ulid } from "ulid";
import type {
  ConwayClient,
  CreditTransferResult,
  CreateSandboxOptions,
  DnsRecord,
  DomainRegistration,
  DomainSearchResult,
  ExecResult,
  ModelInfo,
  PortInfo,
  PricingTier,
  SandboxInfo,
} from "../types.js";
import { getHomeDir, resolveHomePath } from "../utils/home.js";
import { createWslVmManager } from "./wsl-vm.js";

const execAsync = promisify(execCallback);
const DEFAULT_LOCAL_BUDGET_CENTS = 1_000_000_000;

export interface LocalInfrastructureOptions {
  workingDirectory?: string;
  workspaceRoot?: string;
  sandboxId?: string;
  computeBudgetCents?: number;
  vmBackend?: "wsl" | "workspace";
  vmImageRoot?: string;
}

interface SandboxRegistry {
  sandboxes: SandboxInfo[];
}

/**
 * Host-native infrastructure adapter.
 *
 * The main instance executes on the current PC. On Windows, child sandboxes are
 * real WSL2 virtual machines by default. Directory-backed workspaces remain an
 * explicit compatibility mode for development and non-Windows hosts.
 */
export function createLocalInfrastructureClient(
  options: LocalInfrastructureOptions = {},
): ConwayClient {
  const workspaceRoot = resolveSafeWorkspaceRoot(options.workspaceRoot);
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const requestedVmBackend =
    options.vmBackend ||
    (process.env.AUTOMATON_VM_BACKEND as "wsl" | "workspace" | undefined) ||
    (process.platform === "win32" ? "wsl" : "workspace");
  const vmBackend = requestedVmBackend === "workspace" ? "workspace" : "wsl";
  const vmManager = vmBackend === "wsl"
    ? createWslVmManager({
        workspaceRoot,
        imageRoot: path.resolve(
          resolveHomePath(
            options.vmImageRoot ||
              process.env.AUTOMATON_VM_IMAGE_ROOT ||
              path.join(path.dirname(workspaceRoot), "vm-images"),
          ),
        ),
      })
    : undefined;

  const sandboxId = normalizeId(options.sandboxId);
  const workingDirectory = sandboxId && vmBackend === "wsl"
    ? "/root"
    : sandboxId
    ? path.join(workspaceRoot, sandboxId)
    : path.resolve(resolveHomePath(options.workingDirectory || process.cwd()));
  if (!(sandboxId && vmBackend === "wsl")) {
    fs.mkdirSync(workingDirectory, { recursive: true });
  }

  const computeBudgetCents = Number.isFinite(options.computeBudgetCents)
    ? Math.max(0, options.computeBudgetCents as number)
    : DEFAULT_LOCAL_BUDGET_CENTS;

  const registryPath = path.join(workspaceRoot, "sandboxes.json");

  const exec = async (command: string, timeout = 30_000): Promise<ExecResult> => {
    if (sandboxId && vmManager) return vmManager.exec(sandboxId, command, timeout);
    const prepared = prepareCommand(command, workingDirectory);
    try {
      const result = await execAsync(prepared, {
        cwd: workingDirectory,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: workingDirectory,
          AUTOMATON_WORKSPACE: workingDirectory,
          AUTOMATON_SANDBOX_ID: sandboxId || "local",
        },
        shell: resolveShell(),
      });
      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: 0,
      };
    } catch (error: any) {
      return {
        stdout: error?.stdout || "",
        stderr: error?.stderr || error?.message || String(error),
        exitCode: error?.code === "ETIMEDOUT" ? 124 : Number(error?.code) || 1,
      };
    }
  };

  const resolveWorkspacePath = (input: string): string => {
    if (input === "/root" || input.startsWith("/root/")) {
      return path.join(workingDirectory, input.slice("/root".length).replace(/^[/\\]+/, ""));
    }
    if (input.startsWith("~")) {
      return path.join(workingDirectory, input.slice(1).replace(/^[/\\]+/, ""));
    }
    if (path.isAbsolute(input)) return path.normalize(input);
    return path.resolve(workingDirectory, input);
  };

  const writeFile = async (filePath: string, content: string): Promise<void> => {
    if (sandboxId && vmManager) return vmManager.writeFile(sandboxId, filePath, content);
    const resolved = resolveWorkspacePath(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
  };

  const readFile = async (filePath: string): Promise<string> => {
    if (sandboxId && vmManager) return vmManager.readFile(sandboxId, filePath);
    return fs.readFileSync(resolveWorkspacePath(filePath), "utf8");
  };

  const exposePort = async (port: number): Promise<PortInfo> => ({
    port,
    publicUrl: `http://localhost:${port}`,
    sandboxId: sandboxId || "local",
  });

  const createSandbox = async (requested: CreateSandboxOptions): Promise<SandboxInfo> => {
    if (vmManager) return vmManager.create(requested);
    const id = createSandboxId(requested.name);
    const sandboxPath = path.join(workspaceRoot, id);
    fs.mkdirSync(sandboxPath, { recursive: false });
    const info: SandboxInfo = {
      id,
      status: "running",
      region: "local",
      vcpu: requested.vcpu || 1,
      memoryMb: requested.memoryMb || 1024,
      diskGb: requested.diskGb || 5,
      terminalUrl: sandboxPath,
      createdAt: new Date().toISOString(),
    };
    const registry = readRegistry(registryPath);
    registry.sandboxes.push(info);
    writeRegistry(registryPath, registry);
    return info;
  };

  const deleteSandbox = async (targetId: string): Promise<void> => {
    const normalized = normalizeId(targetId);
    if (!normalized || normalized === sandboxId) {
      throw new Error("Refusing to delete the active local workspace");
    }
    if (vmManager) return vmManager.delete(normalized);
    const target = path.resolve(workspaceRoot, normalized);
    if (!isWithin(workspaceRoot, target)) {
      throw new Error(`Invalid local workspace ID: ${targetId}`);
    }
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: false });
    const registry = readRegistry(registryPath);
    registry.sandboxes = registry.sandboxes.filter((item) => item.id !== normalized);
    writeRegistry(registryPath, registry);
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    if (vmManager) return vmManager.list();
    const registry = readRegistry(registryPath);
    return registry.sandboxes.filter((item) =>
      fs.existsSync(path.join(workspaceRoot, item.id)),
    );
  };

  const unsupported = (capability: string): never => {
    throw new Error(
      `${capability} is not configured for the local infrastructure backend. ` +
      "Connect that capability through your proprietary workflow adapter.",
    );
  };

  return {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort: async () => undefined,
    createSandbox,
    cloneSandbox: vmManager
      ? (sourceSandboxId, requested) => vmManager.clone(sourceSandboxId, requested)
      : undefined,
    startSandbox: vmManager ? (targetId) => vmManager.start(targetId) : undefined,
    stopSandbox: vmManager ? (targetId) => vmManager.stop(targetId) : undefined,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance: async () => computeBudgetCents,
    getCreditsPricing: async (): Promise<PricingTier[]> => [],
    transferCredits: async (toAddress, amountCents): Promise<CreditTransferResult> => ({
      transferId: `local-${ulid()}`,
      status: "local-noop",
      toAddress,
      amountCents,
      balanceAfterCents: computeBudgetCents,
    }),
    registerAutomaton: async (params) => {
      const registration = {
        automatonId: params.automatonId,
        automatonAddress: params.automatonAddress,
        creatorAddress: params.creatorAddress,
        name: params.name,
        registeredAt: new Date().toISOString(),
        backend: "local",
      };
      const registrationPath = path.join(getHomeDir(), ".automaton", "local-registration.json");
      fs.mkdirSync(path.dirname(registrationPath), { recursive: true });
      fs.writeFileSync(registrationPath, JSON.stringify(registration, null, 2), "utf8");
      return { automaton: registration };
    },
    searchDomains: async (): Promise<DomainSearchResult[]> => unsupported("Domain search"),
    registerDomain: async (): Promise<DomainRegistration> => unsupported("Domain registration"),
    listDnsRecords: async (): Promise<DnsRecord[]> => unsupported("DNS management"),
    addDnsRecord: async (): Promise<DnsRecord> => unsupported("DNS management"),
    deleteDnsRecord: async (): Promise<void> => unsupported("DNS management"),
    listModels: async (): Promise<ModelInfo[]> => [],
    createScopedClient: (targetSandboxId: string) =>
      createLocalInfrastructureClient({
        workspaceRoot,
        sandboxId: targetSandboxId,
        computeBudgetCents,
        vmBackend,
        vmImageRoot: options.vmImageRoot,
      }),
  };
}

function resolveShell(): string | undefined {
  if (process.env.AUTOMATON_SHELL?.trim()) return process.env.AUTOMATON_SHELL.trim();
  if (process.platform !== "win32") return undefined;
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  return fs.existsSync(gitBash) ? gitBash : process.env.ComSpec;
}

function prepareCommand(command: string, workingDirectory: string): string {
  if (process.platform !== "win32" || !resolveShell()?.toLowerCase().includes("bash")) {
    return command;
  }
  const bashPath = workingDirectory.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1");
  const quoted = `'${bashPath.replace(/'/g, `'\\''`)}'`;
  return command.replace(/\/root(?=\/|\s|$)/g, quoted);
}

function normalizeId(value: string | undefined): string {
  const trimmed = (value || "").trim();
  if (!trimmed || trimmed === "local" || trimmed === "undefined" || trimmed === "null") return "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(trimmed)) {
    throw new Error(`Invalid local workspace ID: ${value}`);
  }
  return trimmed;
}

function createSandboxId(name: string | undefined): string {
  const prefix = (name || "workspace")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";
  return `${prefix}-${ulid().toLowerCase()}`;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readRegistry(registryPath: string): SandboxRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    return { sandboxes: Array.isArray(parsed.sandboxes) ? parsed.sandboxes : [] };
  } catch {
    return { sandboxes: [] };
  }
}

function writeRegistry(registryPath: string, registry: SandboxRegistry): void {
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");
}

export function resolveSafeWorkspaceRoot(configured?: string): string {
  const requested = path.resolve(
    resolveHomePath(
      configured || process.env.AUTOMATON_WORKSPACE_ROOT || "~/.automaton/workspaces",
    ),
  );
  if (process.platform !== "win32" || process.env.AUTOMATON_WORKSPACE_ROOT) {
    return requested;
  }

  const defaultOnSystemDrive = path.resolve(resolveHomePath("~/.automaton/workspaces"));
  if (requested.toLowerCase() !== defaultOnSystemDrive.toLowerCase()) return requested;
  if (freeBytes(path.parse(requested).root) >= 20 * 1024 ** 3) return requested;

  const largerDrive = findLocalDriveWithSpace(20 * 1024 ** 3);
  return largerDrive ? path.join(largerDrive, "Automaton", "workspaces") : requested;
}

function findLocalDriveWithSpace(minimumBytes: number): string | null {
  let best: { root: string; free: number } | null = null;
  for (let code = "D".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (!fs.existsSync(root)) continue;
    const free = freeBytes(root);
    if (free >= minimumBytes && (!best || free > best.free)) best = { root, free };
  }
  return best?.root || null;
}

function freeBytes(root: string): number {
  try {
    const stats = fs.statfsSync(root);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return 0;
  }
}
