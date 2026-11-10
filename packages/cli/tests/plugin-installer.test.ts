import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installObsidianPlugin,
  findLocalPluginAssetsDir,
  getPluginCandidateDirs,
} from "../src/plugin-installer.js";

describe("Obsidian Plugin Installer", () => {
  let tempVault: string;

  beforeEach(() => {
    tempVault = mkdtempSync(join(tmpdir(), "lernstoff-plugin-test-"));
  });

  afterEach(() => {
    if (existsSync(tempVault)) {
      rmSync(tempVault, { recursive: true, force: true });
    }
  });

  it("locates compiled plugin assets in candidate directories", () => {
    const candidateDirs = getPluginCandidateDirs();
    expect(candidateDirs.length).toBeGreaterThan(0);

    const foundDir = findLocalPluginAssetsDir();
    expect(foundDir).not.toBeNull();
    expect(existsSync(join(foundDir!, "main.js"))).toBe(true);
    expect(existsSync(join(foundDir!, "manifest.json"))).toBe(true);
  });

  it("installs plugin files and enables in community-plugins.json", async () => {
    const result = await installObsidianPlugin({ vaultPath: tempVault });

    expect(result.source).toBe("local");
    const pluginDir = join(tempVault, ".obsidian", "plugins", "lernstoff-wiki");
    expect(result.targetPluginDir).toBe(pluginDir);

    // Verify files copied
    expect(existsSync(join(pluginDir, "main.js"))).toBe(true);
    expect(existsSync(join(pluginDir, "manifest.json"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf-8"));
    expect(manifest.id).toBe("lernstoff-wiki");

    // Verify community-plugins.json created and updated
    const communityPluginsPath = join(tempVault, ".obsidian", "community-plugins.json");
    expect(existsSync(communityPluginsPath)).toBe(true);
    const plugins = JSON.parse(readFileSync(communityPluginsPath, "utf-8"));
    expect(plugins).toContain("lernstoff-wiki");
  });

  it("idempotently handles existing community-plugins.json without duplicates", async () => {
    const communityPluginsPath = join(tempVault, ".obsidian", "community-plugins.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempVault, ".obsidian"), { recursive: true });
    writeFileSync(
      communityPluginsPath,
      JSON.stringify(["existing-plugin", "lernstoff-wiki"]),
      "utf-8",
    );

    await installObsidianPlugin({ vaultPath: tempVault });

    const plugins = JSON.parse(readFileSync(communityPluginsPath, "utf-8"));
    expect(plugins.filter((p: string) => p === "lernstoff-wiki").length).toBe(1);
    expect(plugins).toContain("existing-plugin");
  });

  it("can download release assets from GitHub Releases", async () => {
    const { downloadReleaseAsset } = await import("../src/plugin-installer.js");
    const manifestBuf = await downloadReleaseAsset("0.1.0-beta.4", "manifest.json");
    expect(manifestBuf).not.toBeNull();
    const manifest = JSON.parse(manifestBuf!.toString("utf-8"));
    expect(manifest.id).toBe("lernstoff-wiki");
  });
});
