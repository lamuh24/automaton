import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import { createLocalInfrastructureClient } from "../infrastructure/local-client.js";

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-local-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("local infrastructure client", () => {
  it("executes commands on the host in the configured working directory", async () => {
    const client = createLocalInfrastructureClient({
      workingDirectory: tempRoot,
      workspaceRoot: path.join(tempRoot, "workspaces"),
      vmBackend: "workspace",
    });

    const result = await client.exec("git --version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("git version");
  });

  it("maps sandbox-style /root paths into the host workspace", async () => {
    const client = createLocalInfrastructureClient({
      workingDirectory: tempRoot,
      workspaceRoot: path.join(tempRoot, "workspaces"),
      vmBackend: "workspace",
    });

    await client.writeFile("/root/project/readme.md", "local workflow");
    expect(fs.readFileSync(path.join(tempRoot, "project", "readme.md"), "utf8"))
      .toBe("local workflow");
    await expect(client.readFile("/root/project/readme.md")).resolves.toBe("local workflow");
  });

  it("creates, scopes, lists, and deletes isolated child workspaces", async () => {
    const workspaceRoot = path.join(tempRoot, "workspaces");
    const client = createLocalInfrastructureClient({
      workingDirectory: tempRoot,
      workspaceRoot,
      vmBackend: "workspace",
    });

    const sandbox = await client.createSandbox({ name: "child task" });
    const scoped = client.createScopedClient(sandbox.id);
    await scoped.writeFile("/root/result.txt", "done");

    expect(fs.readFileSync(path.join(workspaceRoot, sandbox.id, "result.txt"), "utf8"))
      .toBe("done");
    await expect(client.listSandboxes()).resolves.toEqual([
      expect.objectContaining({ id: sandbox.id, region: "local", status: "running" }),
    ]);

    await client.deleteSandbox(sandbox.id);
    await expect(client.listSandboxes()).resolves.toEqual([]);
  });

  it("uses a configurable logical compute budget without remote credits", async () => {
    const client = createLocalInfrastructureClient({
      workingDirectory: tempRoot,
      workspaceRoot: path.join(tempRoot, "workspaces"),
      computeBudgetCents: 4242,
      vmBackend: "workspace",
    });

    await expect(client.getCreditsBalance()).resolves.toBe(4242);
  });
});

describe("local tool surface", () => {
  it("keeps host workflow tools and hides Conway-only financial/domain tools", () => {
    const names = createBuiltinTools("", "local").map((tool) => tool.name);
    expect(names).toContain("exec");
    expect(names).toContain("git_clone");
    expect(names).toContain("create_sandbox");
    expect(names).toContain("clone_sandbox");
    expect(names).toContain("start_sandbox");
    expect(names).toContain("stop_sandbox");
    expect(names).not.toContain("topup_credits");
    expect(names).not.toContain("transfer_credits");
    expect(names).not.toContain("register_domain");
    expect(names).not.toContain("register_erc8004");
    expect(names).not.toContain("send_message");
    expect(names).not.toContain("message_child");
  });
});
