import { describe, expect, it } from "vitest";
import {
  DEFAULT_WSL_ROOTFS_URL,
  toWslMountPath,
} from "../infrastructure/wsl-vm.js";

describe("WSL2 VM infrastructure", () => {
  it("uses an Ubuntu WSL root filesystem image", () => {
    expect(DEFAULT_WSL_ROOTFS_URL).toMatch(/^https:\/\/cloud-images\.ubuntu\.com\//);
    expect(DEFAULT_WSL_ROOTFS_URL).toContain("amd64-wsl.rootfs.tar.gz");
  });

  it("maps Windows paths into WSL mount paths", () => {
    if (process.platform === "win32") {
      expect(toWslMountPath("C:\\work\\automaton")).toBe("/mnt/c/work/automaton");
    }
  });
});
