import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHomeDir, resolveHomePath } from "../utils/home.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

describe("home directory resolution", () => {
  it("prefers HOME when it is set", () => {
    process.env.HOME = "C:\\custom-home";
    process.env.USERPROFILE = "C:\\profile-home";

    expect(getHomeDir()).toBe("C:\\custom-home");
  });

  it("uses USERPROFILE when HOME is absent", () => {
    delete process.env.HOME;
    process.env.USERPROFILE = "C:\\profile-home";

    expect(getHomeDir()).toBe("C:\\profile-home");
  });

  it("resolves slash and backslash tilde paths", () => {
    process.env.HOME = "C:\\custom-home";

    expect(resolveHomePath("~/.automaton/state.db")).toBe(
      path.join(process.env.HOME, ".automaton", "state.db"),
    );
    expect(resolveHomePath("~\\.automaton\\state.db")).toBe(
      path.join(process.env.HOME, ".automaton\\state.db"),
    );
  });
});
