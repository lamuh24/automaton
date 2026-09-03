import os from "node:os";
import path from "node:path";

/** Return the current user's home directory on every supported platform. */
export function getHomeDir(): string {
  const configuredHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  if (configuredHome) return configuredHome;

  const systemHome = os.homedir().trim();
  if (systemHome) return systemHome;

  return process.platform === "win32" ? process.cwd() : "/root";
}

/** Resolve a leading ~ path without changing non-home-relative paths. */
export function resolveHomePath(input: string): string {
  if (input === "~") return getHomeDir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(getHomeDir(), input.slice(2));
  }
  return input;
}
