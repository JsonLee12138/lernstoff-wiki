import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initVault } from "@lernstoff/core/vault-init";
import { loadConfig } from "@lernstoff/core/config";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN_PATH = resolve(__dirname, "../dist/bin.mjs");

async function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("Failed to allocate free TCP port")));
      }
    });
  });
}

describe("CLI Components (Daemon PID, Service Manager, Agent Installer, Cognitive Commands)", () => {
  let sandboxRoot: string;
  let tempDir: string;
  let homeDir: string;
  let binDir: string;
  let serviceCallsLog: string;
  let origHome: string | undefined;
  let origPath: string | undefined;

  function runCliBin(
    args: string[],
    timeoutMs = 6000,
  ): Promise<{ code: number; stdout: string; stderr: string; elapsedMs: number }> {
    const start = Date.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_CONFIG_HOME: join(homeDir, ".config"),
      PATH: `${binDir}:${dirname(process.execPath)}:${origPath || ""}`,
      NO_COLOR: "1",
    };
    delete env.VITEST;

    return new Promise((resolveRun) => {
      execFile(
        process.execPath,
        [CLI_BIN_PATH, ...args],
        { cwd: tempDir, env, timeout: timeoutMs },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
          resolveRun({
            code,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            elapsedMs: Date.now() - start,
          });
        },
      );
    });
  }

  beforeEach(async () => {
    origHome = process.env.HOME;
    origPath = process.env.PATH;

    sandboxRoot = mkdtempSync(join(tmpdir(), "lernstoff-cli-test-"));
    tempDir = join(sandboxRoot, "vault");
    homeDir = join(sandboxRoot, "home");
    binDir = join(homeDir, ".local", "bin");
    serviceCallsLog = join(sandboxRoot, "service-calls.log");

    mkdirSync(tempDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    for (const svcBin of ["launchctl", "systemctl"]) {
      const shimPath = join(binDir, svcBin);
      writeFileSync(
        shimPath,
        `#!/bin/sh\necho "${svcBin} $*" >> "${serviceCallsLog}"\nexit 0\n`,
        "utf-8",
      );
      chmodSync(shimPath, 0o755);
    }

    process.env.HOME = homeDir;
    process.env.PATH = `${binDir}:${dirname(process.execPath)}:${origPath || ""}`;

    await initVault(tempDir);
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    process.env.PATH = origPath;

    // Safely terminate ONLY processes referencing this test's unique tempDir
    const pidFile = join(tempDir, ".lernstoff/daemon.pid");
    const pids = new Set<number>();
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      } catch {}
    }
    try {
      const psOut = execSync("ps -ax -o pid=,command=", {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).toString("utf-8");
      for (const line of psOut.split("\n")) {
        if (line.includes(tempDir)) {
          const m = line.trim().match(/^(\d+)\s+/);
          if (m && m[1]) pids.add(parseInt(m[1], 10));
        }
      }
    } catch {}

    for (const pid of pids) {
      try {
        const cmd = execSync(`ps -p ${pid} -o command=`, {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1000,
        }).toString("utf-8");
        if (!cmd.includes(tempDir)) continue;
        process.kill(pid, "SIGTERM");
      } catch {
        continue;
      }
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && isPidAlive(pid)) {
        await new Promise((r) => setTimeout(r, 30));
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

    if (existsSync(sandboxRoot)) {
      rmSync(sandboxRoot, { recursive: true, force: true });
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

  it("pauses OS service supervision via ServiceManager.stopSupervision without deleting service or config files", async () => {
    const installed = await ServiceManager.installService(tempDir, CLI_BIN_PATH);
    expect(installed.success).toBe(true);
    expect(existsSync(installed.servicePath)).toBe(true);
    expect(loadConfig(tempDir).server.autoStartOnBoot).toBe(true);

    writeFileSync(serviceCallsLog, "", "utf-8");
    const stopRes = ServiceManager.stopSupervision(tempDir);

    if (process.platform === "darwin" || process.platform === "linux") {
      expect(stopRes.paused).toBe(true);
      const calls = readFileSync(serviceCallsLog, "utf-8");
      if (process.platform === "darwin") {
        expect(calls).toContain(`launchctl unload ${installed.servicePath}`);
      } else {
        expect(calls).toContain("systemctl --user stop");
      }
    }

    // Service definition and .lernstoff/config.json must remain intact
    expect(existsSync(installed.servicePath)).toBe(true);
    expect(existsSync(join(tempDir, ".lernstoff/config.json"))).toBe(true);
    expect(loadConfig(tempDir).server.autoStartOnBoot).toBe(true);
  });

  it("forwards & persists --port across server start --daemon (replacing port-mismatched daemon), server restart --port, and fast server stop with supervision pause", async () => {
    const port1 = await allocateFreePort();
    let port2 = await allocateFreePort();
    while (port2 === port1) port2 = await allocateFreePort();
    let port3 = await allocateFreePort();
    while (port3 === port1 || port3 === port2) port3 = await allocateFreePort();

    const installed = await ServiceManager.installService(tempDir, CLI_BIN_PATH);
    expect(existsSync(installed.servicePath)).toBe(true);

    // 1. Start daemon with explicit --port port1
    const start1 = await runCliBin([
      "server",
      "start",
      "--daemon",
      "--port",
      String(port1),
      "--vault",
      tempDir,
    ]);
    expect(start1.code).toBe(0);
    expect(loadConfig(tempDir).server.port).toBe(port1);

    const info1 = getRunningDaemonInfo(tempDir);
    expect(info1).not.toBeNull();
    expect(info1!.port).toBe(port1);
    const health1 = await fetch(`http://127.0.0.1:${port1}/health`).then((r) => r.json());
    expect(health1.port).toBe(port1);
    expect(health1.requestedPort).toBe(port1);

    // 2. Starting again with a DIFFERENT explicit --port port2 stops old daemon and starts on port2
    const start2 = await runCliBin([
      "server",
      "start",
      "--daemon",
      "--port",
      String(port2),
      "--vault",
      tempDir,
    ]);
    expect(start2.code).toBe(0);
    expect(isPidAlive(info1!.pid)).toBe(false);
    expect(loadConfig(tempDir).server.port).toBe(port2);

    const info2 = getRunningDaemonInfo(tempDir);
    expect(info2).not.toBeNull();
    expect(info2!.port).toBe(port2);
    expect(info2!.pid).not.toBe(info1!.pid);

    // 3. Restarting with --port port3 persists port3 and forwards it to restarted child
    const restartRes = await runCliBin([
      "server",
      "restart",
      "--port",
      String(port3),
      "--vault",
      tempDir,
    ]);
    expect(restartRes.code).toBe(0);
    expect(isPidAlive(info2!.pid)).toBe(false);
    expect(loadConfig(tempDir).server.port).toBe(port3);

    const info3 = getRunningDaemonInfo(tempDir);
    expect(info3).not.toBeNull();
    expect(info3!.port).toBe(port3);
    const health3 = await fetch(`http://127.0.0.1:${port3}/health`).then((r) => r.json());
    expect(health3.port).toBe(port3);

    // 4. server status and server stop run quickly (< 2s) and pause supervision without deleting files
    const statusRes = await runCliBin(["server", "status", "--vault", tempDir]);
    expect(statusRes.code).toBe(0);
    expect(statusRes.elapsedMs).toBeLessThan(2000);
    expect(statusRes.stdout).toContain(`Port ${port3}`);

    writeFileSync(serviceCallsLog, "", "utf-8");
    const stopRes = await runCliBin(["server", "stop", "--vault", tempDir]);
    expect(stopRes.code).toBe(0);
    expect(stopRes.elapsedMs).toBeLessThan(2000);
    expect(getRunningDaemonInfo(tempDir)).toBeNull();
    expect(isPidAlive(info3!.pid)).toBe(false);

    if (process.platform === "darwin") {
      expect(readFileSync(serviceCallsLog, "utf-8")).toContain("launchctl unload");
    } else if (process.platform === "linux") {
      expect(readFileSync(serviceCallsLog, "utf-8")).toContain("systemctl --user stop");
    }
    expect(existsSync(installed.servicePath)).toBe(true);
    expect(existsSync(join(tempDir, ".lernstoff/config.json"))).toBe(true);
    expect(loadConfig(tempDir).server.autoStartOnBoot).toBe(true);
    expect(loadConfig(tempDir).server.port).toBe(port3);
  }, 25_000);

  it("stops existing unmanaged daemon during ServiceManager.installService to ensure smooth handover to OS service", async () => {
    const testPort = await allocateFreePort();
    const startRes = await runCliBin([
      "server",
      "start",
      "--daemon",
      "--port",
      String(testPort),
      "--vault",
      tempDir,
    ]);
    expect(startRes.code).toBe(0);
    const existing = getRunningDaemonInfo(tempDir);
    expect(existing).not.toBeNull();
    const oldPid = existing!.pid;
    expect(isPidAlive(oldPid)).toBe(true);

    const installRes = await ServiceManager.installService(tempDir, CLI_BIN_PATH);
    expect(installRes.success).toBe(true);
    expect(isPidAlive(oldPid)).toBe(false);
  });

  it("prevents duplicate daemon from running in foreground mode when already running", async () => {
    const testPort = await allocateFreePort();
    const startRes = await runCliBin([
      "server",
      "start",
      "--daemon",
      "--port",
      String(testPort),
      "--vault",
      tempDir,
    ]);
    expect(startRes.code).toBe(0);
    const existing = getRunningDaemonInfo(tempDir);
    expect(existing).not.toBeNull();

    // Try starting in foreground mode
    const fgRes = await runCliBin(["server", "start", "--foreground", "--vault", tempDir]);
    expect(fgRes.code).toBe(0);
    expect(fgRes.stdout).toContain(`Daemon already running on http://127.0.0.1:${existing!.port}`);

    // Clean up
    await runCliBin(["server", "stop", "--vault", tempDir]);
  });
});
