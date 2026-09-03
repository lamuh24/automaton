import { createWslVmManager, toWslMountPath } from "../src/infrastructure/wsl-vm.js";

const workspaceRoot = process.env.AUTOMATON_WORKSPACE_ROOT || "E:/Automaton/workspaces";
const imageRoot = process.env.AUTOMATON_VM_IMAGE_ROOT || "E:/VM-Platform/Images";

async function main(): Promise<void> {
  const manager = createWslVmManager({ workspaceRoot, imageRoot });
  const createdIds: string[] = [];
  const report: Record<string, unknown> = {
    backend: "wsl2",
    workspaceRoot,
    imageRoot,
  };

  try {
    await manager.assertReady();
    const source = await manager.create({
      name: "live-check",
      vcpu: 1,
      memoryMb: 1024,
      diskGb: 5,
    });
    createdIds.push(source.id);
    report.created = source;

    const kernel = await manager.exec(source.id, "uname -a");
    if (kernel.exitCode !== 0) throw new Error(kernel.stderr || "uname failed");
    report.kernel = kernel.stdout.trim();

    const resources = await manager.exec(
      source.id,
      "printf 'cpus='; nproc; grep '^MemTotal:' /proc/meminfo",
    );
    if (resources.exitCode !== 0) {
      throw new Error(resources.stderr || "WSL resource inspection failed");
    }
    report.resources = resources.stdout.trim();

    await manager.writeFile(source.id, "/root/connection.txt", "local-workflows-ready");
    const repository = toWslMountPath(process.cwd()).replace(/'/g, "'\\''");
    const git = await manager.exec(
      source.id,
      `git clone --quiet --no-hardlinks --no-checkout '${repository}' /root/repo-copy`,
      120_000,
    );
    if (git.exitCode !== 0) throw new Error(git.stderr || "local Git clone failed");
    report.gitClone = "ready";

    const clone = await manager.clone(source.id, {
      name: "live-check-clone",
      vcpu: 1,
      memoryMb: 1024,
      diskGb: 5,
    });
    createdIds.push(clone.id);
    report.cloned = clone;

    const inherited = await manager.readFile(clone.id, "/root/connection.txt");
    if (inherited !== "local-workflows-ready") throw new Error("clone marker mismatch");

    await manager.stop(clone.id);
    report.afterStop = await manager.list();
    await manager.start(clone.id);
    const restarted = await manager.exec(clone.id, "printf vm-restarted");
    if (restarted.exitCode !== 0 || !restarted.stdout.includes("vm-restarted")) {
      throw new Error(restarted.stderr || "VM restart failed");
    }

    report.restart = "ready";
    report.status = "ready";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    for (const id of createdIds.reverse()) {
      try {
        await manager.delete(id);
      } catch (error) {
        report.cleanupError = error instanceof Error ? error.message : String(error);
      }
    }
    report.cleanup = "disposable VMs removed";
    console.log(JSON.stringify(report, null, 2));
  }
}

await main();
