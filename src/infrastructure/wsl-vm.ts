import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import type { CreateSandboxOptions, ExecResult, SandboxInfo } from "../types.js";

export const DEFAULT_WSL_ROOTFS_URL =
  "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz";
export const DEFAULT_WSL_CHECKSUM_URL =
  "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/SHA256SUMS";
const ROOTFS_FILENAME = "ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz";

interface VmRecord {
  info: SandboxInfo;
  distroName: string;
  installPath: string;
}

interface VmRegistry {
  version: 1;
  vms: VmRecord[];
}

export interface WslVmManagerOptions {
  workspaceRoot: string;
  imageRoot: string;
  rootfsUrl?: string;
  checksumUrl?: string;
}

export interface WslVmManager {
  assertReady(): Promise<void>;
  create(options: CreateSandboxOptions): Promise<SandboxInfo>;
  clone(sourceId: string, options: CreateSandboxOptions): Promise<SandboxInfo>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<SandboxInfo[]>;
  exec(id: string, command: string, timeout?: number): Promise<ExecResult>;
  writeFile(id: string, filePath: string, content: string): Promise<void>;
  readFile(id: string, filePath: string): Promise<string>;
}

export function createWslVmManager(options: WslVmManagerOptions): WslVmManager {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const imageRoot = path.resolve(options.imageRoot);
  const registryPath = path.join(workspaceRoot, "vms.json");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(imageRoot, { recursive: true });

  const assertReady = async (): Promise<void> => {
    if (process.platform !== "win32") {
      throw new Error("The WSL2 VM backend requires Windows");
    }
    const version = await runFile("wsl.exe", ["--version"], 15_000);
    if (version.exitCode !== 0) {
      throw new Error(
        "WSL2 is not ready. Enable Windows Subsystem for Linux and Virtual Machine Platform, " +
        "install Microsoft.WSL, then reboot Windows.",
      );
    }
  };

  const ensureRootfs = async (): Promise<string> => {
    await assertReady();
    const rootfsPath = path.join(imageRoot, ROOTFS_FILENAME);
    const checksumPath = path.join(imageRoot, "SHA256SUMS");
    if (!fs.existsSync(rootfsPath)) {
      const partialPath = `${rootfsPath}.partial`;
      if (fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true });
      const download = await runFile(
        "curl.exe",
        [
          "-fL",
          "--retry",
          "3",
          "--output",
          partialPath,
          options.rootfsUrl || process.env.AUTOMATON_WSL_ROOTFS_URL || DEFAULT_WSL_ROOTFS_URL,
        ],
        30 * 60_000,
      );
      if (download.exitCode !== 0) {
        if (fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true });
        throw new Error(`Failed to download the local VM image: ${download.stderr}`);
      }
      fs.renameSync(partialPath, rootfsPath);
    }

    const checksum = await runFile(
      "curl.exe",
      [
        "-fsSL",
        "--output",
        checksumPath,
        options.checksumUrl ||
          process.env.AUTOMATON_WSL_CHECKSUM_URL ||
          DEFAULT_WSL_CHECKSUM_URL,
      ],
      60_000,
    );
    if (checksum.exitCode !== 0) {
      throw new Error(`Failed to download the VM image checksum: ${checksum.stderr}`);
    }
    const expected = parseExpectedChecksum(fs.readFileSync(checksumPath, "utf8"));
    const actual = await sha256File(rootfsPath);
    if (actual !== expected) {
      fs.rmSync(rootfsPath, { force: true });
      throw new Error(`VM image checksum mismatch: expected ${expected}, received ${actual}`);
    }
    return rootfsPath;
  };

  const importVm = async (
    sourceTar: string,
    requested: CreateSandboxOptions,
  ): Promise<VmRecord> => {
    const id = createVmId(requested.name);
    const distroName = `Automaton-${id}`;
    const installPath = path.join(workspaceRoot, id);
    if (fs.existsSync(installPath)) throw new Error(`VM path already exists: ${installPath}`);
    fs.mkdirSync(installPath, { recursive: false });

    const imported = await runFile(
      "wsl.exe",
      ["--import", distroName, installPath, sourceTar, "--version", "2"],
      10 * 60_000,
    );
    if (imported.exitCode !== 0) {
      fs.rmSync(installPath, { recursive: true, force: true });
      throw new Error(`Failed to create WSL2 VM ${id}: ${imported.stderr || imported.stdout}`);
    }

    const info: SandboxInfo = {
      id,
      status: "running",
      region: "local-wsl2",
      vcpu: requested.vcpu || 1,
      memoryMb: requested.memoryMb || 1024,
      diskGb: requested.diskGb || 5,
      terminalUrl: `wsl://${distroName}/root`,
      createdAt: new Date().toISOString(),
    };
    const record: VmRecord = { info, distroName, installPath };

    try {
      const initialized = await execInDistro(
        distroName,
        "mkdir -p /root /var/run/automaton && " +
          "printf '[boot]\\nsystemd=true\\n' > /etc/wsl.conf && " +
          "nohup sh -c 'while :; do sleep 3600; done' >/var/run/automaton/keepalive.log 2>&1 &",
        60_000,
      );
      if (initialized.exitCode !== 0) {
        throw new Error(initialized.stderr || initialized.stdout || "VM initialization failed");
      }
      const registry = readRegistry(registryPath);
      registry.vms.push(record);
      writeRegistry(registryPath, registry);
      return record;
    } catch (error) {
      await runFile("wsl.exe", ["--unregister", distroName], 120_000);
      if (fs.existsSync(installPath)) fs.rmSync(installPath, { recursive: true, force: true });
      throw error;
    }
  };

  const create = async (requested: CreateSandboxOptions): Promise<SandboxInfo> => {
    const rootfsPath = await ensureRootfs();
    return (await importVm(rootfsPath, requested)).info;
  };

  const clone = async (
    sourceId: string,
    requested: CreateSandboxOptions,
  ): Promise<SandboxInfo> => {
    await assertReady();
    const source = findRecord(registryPath, sourceId);
    const exportRoot = path.join(workspaceRoot, ".exports");
    fs.mkdirSync(exportRoot, { recursive: true });
    const exportPath = path.join(exportRoot, `${sourceId}-${ulid().toLowerCase()}.tar`);
    try {
      const stopped = await runFile("wsl.exe", ["--terminate", source.distroName], 60_000);
      if (stopped.exitCode !== 0 && !isMissingDistro(stopped)) {
        throw new Error(`Failed to stop source VM: ${stopped.stderr || stopped.stdout}`);
      }
      const exported = await runFile(
        "wsl.exe",
        ["--export", source.distroName, exportPath, "--format", "tar"],
        10 * 60_000,
      );
      if (exported.exitCode !== 0) {
        throw new Error(`Failed to clone source VM: ${exported.stderr || exported.stdout}`);
      }
      const cloneRecord = await importVm(exportPath, requested);
      await start(sourceId);
      return cloneRecord.info;
    } finally {
      if (fs.existsSync(exportPath)) fs.rmSync(exportPath, { force: true });
    }
  };

  const start = async (id: string): Promise<void> => {
    const record = findRecord(registryPath, id);
    const result = await execInDistro(
      record.distroName,
      "mkdir -p /var/run/automaton; " +
        "pgrep -f 'automaton-keepalive' >/dev/null || " +
        "nohup sh -c 'exec -a automaton-keepalive sh -c \\\"while :; do sleep 3600; done\\\"' " +
        ">/var/run/automaton/keepalive.log 2>&1 &",
      30_000,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start VM ${id}: ${result.stderr || result.stdout}`);
    }
  };

  const stop = async (id: string): Promise<void> => {
    const record = findRecord(registryPath, id);
    const result = await runFile("wsl.exe", ["--terminate", record.distroName], 60_000);
    if (result.exitCode !== 0 && !isMissingDistro(result)) {
      throw new Error(`Failed to stop VM ${id}: ${result.stderr || result.stdout}`);
    }
  };

  const remove = async (id: string): Promise<void> => {
    const record = findRecord(registryPath, id);
    const result = await runFile("wsl.exe", ["--unregister", record.distroName], 120_000);
    if (result.exitCode !== 0 && !isMissingDistro(result)) {
      throw new Error(`Failed to delete VM ${id}: ${result.stderr || result.stdout}`);
    }
    if (fs.existsSync(record.installPath)) {
      fs.rmSync(record.installPath, { recursive: true, force: true });
    }
    const registry = readRegistry(registryPath);
    registry.vms = registry.vms.filter((item) => item.info.id !== id);
    writeRegistry(registryPath, registry);
  };

  const list = async (): Promise<SandboxInfo[]> => {
    await assertReady();
    const registered = parseDistroList(await runFile("wsl.exe", ["--list", "--quiet"], 30_000));
    const running = parseDistroList(
      await runFile("wsl.exe", ["--list", "--running", "--quiet"], 30_000),
    );
    return readRegistry(registryPath).vms
      .filter((record) => registered.has(record.distroName.toLowerCase()))
      .map((record) => ({
        ...record.info,
        status: running.has(record.distroName.toLowerCase()) ? "running" : "stopped",
      }));
  };

  const exec = async (id: string, command: string, timeout = 30_000): Promise<ExecResult> => {
    const record = findRecord(registryPath, id);
    return execInDistro(record.distroName, command, timeout);
  };

  const writeFile = async (id: string, filePath: string, content: string): Promise<void> => {
    const target = normalizeLinuxPath(filePath);
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const result = await exec(
      id,
      `mkdir -p ${shellQuote(path.posix.dirname(target))} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`,
      60_000,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write ${target} in VM ${id}: ${result.stderr || result.stdout}`);
    }
  };

  const readFile = async (id: string, filePath: string): Promise<string> => {
    const target = normalizeLinuxPath(filePath);
    const result = await exec(id, `cat -- ${shellQuote(target)}`, 30_000);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read ${target} in VM ${id}: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };

  return {
    assertReady,
    create,
    clone,
    start,
    stop,
    delete: remove,
    list,
    exec,
    writeFile,
    readFile,
  };
}

export function toWslMountPath(input: string): string {
  const normalized = path.resolve(input).replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) return normalized;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function execInDistro(distroName: string, command: string, timeout: number): Promise<ExecResult> {
  return runFile(
    "wsl.exe",
    ["--distribution", distroName, "--user", "root", "--", "bash", "-lc", command],
    timeout,
  );
}

function runFile(file: string, args: string[], timeout: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: cleanOutput(stdout),
          stderr: cleanOutput(stderr || error?.message || ""),
          exitCode: error
            ? (error as NodeJS.ErrnoException & { killed?: boolean }).killed
              ? 124
              : Number((error as NodeJS.ErrnoException).code) || 1
            : 0,
        });
      },
    );
  });
}

function cleanOutput(value: string | Buffer): string {
  return String(value || "").replace(/\u0000/g, "").replace(/\r\n/g, "\n");
}

function createVmId(name: string | undefined): string {
  const prefix = (name || "vm")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "vm";
  return `${prefix}-${ulid().toLowerCase()}`;
}

function normalizeVmId(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(trimmed)) {
    throw new Error(`Invalid VM ID: ${value}`);
  }
  return trimmed;
}

function normalizeLinuxPath(value: string): string {
  const target = value.startsWith("~") ? `/root/${value.slice(1).replace(/^\/+/, "")}` : value;
  const normalized = path.posix.normalize(target.startsWith("/") ? target : `/root/${target}`);
  if (normalized !== "/root" && !normalized.startsWith("/root/")) {
    throw new Error(`VM file path must stay under /root: ${value}`);
  }
  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseExpectedChecksum(contents: string): string {
  const line = contents
    .split(/\r?\n/)
    .find((item) => item.trim().endsWith(`  ${ROOTFS_FILENAME}`));
  const checksum = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error(`No checksum found for ${ROOTFS_FILENAME}`);
  }
  return checksum;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function parseDistroList(result: ExecResult): Set<string> {
  if (result.exitCode !== 0) return new Set();
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim().replace(/^\*\s*/, "").toLowerCase())
      .filter(Boolean),
  );
}

function isMissingDistro(result: ExecResult): boolean {
  return /not found|does not exist|WSL_E_DISTRO_NOT_FOUND/i.test(`${result.stdout}\n${result.stderr}`);
}

function findRecord(registryPath: string, id: string): VmRecord {
  const normalized = normalizeVmId(id);
  const record = readRegistry(registryPath).vms.find((item) => item.info.id === normalized);
  if (!record) throw new Error(`Unknown local VM: ${id}`);
  return record;
}

function readRegistry(registryPath: string): VmRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    return { version: 1, vms: Array.isArray(parsed.vms) ? parsed.vms : [] };
  } catch {
    return { version: 1, vms: [] };
  }
}

function writeRegistry(registryPath: string, registry: VmRegistry): void {
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");
}
