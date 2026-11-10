import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "@lernstoff/core";
import { isPidAlive, getRunningDaemonInfo } from "../src/daemon-pid.js";
import { ServiceManager } from "../src/service-manager.js";
import { AgentInstaller } from "../src/agent-installer.js";
import {
  buildEditorUri,
  termLink,
  inquiryCmd,
  scratchpadCmd,
  lintCmd,
} from "../src/cognitive-cmds.js";

describe("CLI Components (Daemon PID, Service Manager, Agent Installer, Cognitive Commands)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-cli-test-"));
    await initVault(tempDir);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies PID liveness and parses running daemon info", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(9999999)).toBe(false);

    expect(getRunningDaemonInfo(tempDir)).toBeNull();

    // Create fake running daemon info with current process PID
    const pidFile = join(tempDir, ".lernstoff/daemon.pid");
    const portFile = join(tempDir, ".lernstoff/daemon.port");
    writeFileSync(pidFile, String(process.pid), "utf-8");
    writeFileSync(portFile, "8250", "utf-8");

    // Since current process command line contains vitest/node, test reading
    const info = getRunningDaemonInfo(tempDir);
    // If command line doesn't match lernstoff daemon fingerprint, returns null and cleans up stale
    if (info) {
      expect(info.pid).toBe(process.pid);
      expect(info.port).toBe(8250);
    } else {
      expect(existsSync(pidFile)).toBe(false);
    }
  });

  it("generates valid macOS LaunchAgent plist and Linux systemd service units", () => {
    const slug = ServiceManager.getServiceSlug(tempDir);
    expect(slug).toBeDefined();

    const plistXml = ServiceManager.generateLaunchdPlist(tempDir, "/usr/local/bin/lernstoff");
    expect(plistXml).toContain(`ai.lernstoff.wiki.${slug}`);
    expect(plistXml).toContain("<key>RunAtLoad</key>");
    expect(plistXml).toContain("<true/>");
    expect(plistXml).toContain("<key>KeepAlive</key>");
    expect(plistXml).toContain("/usr/local/bin/lernstoff");

    const systemdUnit = ServiceManager.generateSystemdService(tempDir, "/usr/local/bin/lernstoff");
    expect(systemdUnit).toContain(`Description=Lernstoff Wiki Headless Cognitive Engine (${slug})`);
    expect(systemdUnit).toContain("Restart=always");
    expect(systemdUnit).toContain("WantedBy=default.target");
  });

  it("installs SKILL.md and injects MCP configuration into agent files", () => {
    // 1. Install Skill
    const installedSkills = AgentInstaller.installSkill("cursor", tempDir);
    expect(installedSkills.length).toBeGreaterThanOrEqual(1);
    const skillPath = join(tempDir, ".cursor/skills/lernstoff-wiki/SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const skillContent = readFileSync(skillPath, "utf-8");
    expect(skillContent).toContain("lernstoff-wiki");
    expect(skillContent).toContain("lernstoff_probe_delta");

    // 2. Install MCP configuration
    const configuredFiles = AgentInstaller.installMcp("cursor", tempDir);
    expect(configuredFiles.length).toBeGreaterThanOrEqual(1);
    const mcpPath = join(tempDir, ".cursor/mcp.json");
    expect(existsSync(mcpPath)).toBe(true);
    const mcpJson = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(mcpJson.mcpServers.lernstoff).toBeDefined();
    expect(mcpJson.mcpServers.lernstoff.command).toBe("lernstoff");
    expect(mcpJson.mcpServers.lernstoff.args).toContain(tempDir);
  });

  it("runs Doctor inspection reporting environment health", async () => {
    const report = await AgentInstaller.runDoctor({
      vaultPath: tempDir,
      pullModels: false,
      cleanup: false,
    });

    expect(report.vaultInitialized).toBe(true);
    expect(report.vaultPath).toBe(tempDir);
    expect(report.nodeVersion).toBe(process.version);
    expect(report.configValid).toBe(true);
    expect(report.models).toBeDefined();
  });

  it("formats editor URI with obsidian:// scheme and executes cognitive subcommands", async () => {
    // 1. Test buildEditorUri and termLink
    const uri = buildEditorUri("obsidian://open?path={path}&line={line}", "/path/to/note.md", 15);
    expect(uri).toContain("obsidian://open?path=");
    expect(uri).toContain("line=15");

    const link = termLink("note.md", "obsidian://open?path=foo", false);
    expect(link).toBe("note.md");

    // 2. Test inquiryCmd (list & add)
    const listRes = await inquiryCmd(tempDir, "list", undefined, { json: true });
    expect(Array.isArray(listRes)).toBe(true);
    expect(listRes.length).toBeGreaterThanOrEqual(1);

    const addRes = await inquiryCmd(tempDir, "add", "What is the optimal chunk size?", {
      json: true,
    });
    expect(addRes.action).toBe("add");

    // 3. Test scratchpadCmd (add & consolidate)
    const addScratch = await scratchpadCmd(tempDir, "add", "Need to evaluate ZFS vs ext4", {
      json: true,
    });
    expect(addScratch.added).toContain("ZFS vs ext4");

    const consolidateRes = await scratchpadCmd(tempDir, "consolidate", undefined, { json: true });
    expect(consolidateRes.activeCount).toBeGreaterThanOrEqual(1);

    // 4. Test lintCmd
    const lintRes = await lintCmd(tempDir, { json: true });
    expect(lintRes.summary).toBeDefined();
    expect(lintRes.summary.totalNotes).toBe(0);
  });
});
