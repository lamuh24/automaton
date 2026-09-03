import fs from "fs";

export interface EnvironmentInfo {
  type: string;
  sandboxId: string;
}

export function detectEnvironment(): EnvironmentInfo {
  // 1. Check env var
  if (process.env.AUTOMATON_WORKSPACE_ID) {
    const sandboxId = process.env.AUTOMATON_WORKSPACE_ID.trim();
    if (sandboxId) {
      return { type: "automaton-workspace", sandboxId };
    }
  }

  // 2. Check sandbox config file
  try {
    if (fs.existsSync("/etc/automaton/workspace.json")) {
      const data = JSON.parse(fs.readFileSync("/etc/automaton/workspace.json", "utf-8"));
      if (data.id) {
        const sandboxId = String(data.id).trim();
        if (sandboxId) {
          return { type: "automaton-workspace", sandboxId };
        }
      }
    }
  } catch {}

  // 3. Check Docker
  if (fs.existsSync("/.dockerenv")) {
    return { type: "docker", sandboxId: "" };
  }

  // 4. Fall back to platform
  return { type: process.platform, sandboxId: "" };
}
