#!/usr/bin/env node
import { existsSync, readFileSync, openSync, closeSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import {
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  resetConfigToDefaults,
  getConfigPath,
  LERNSTOFF_DIR,
} from "@lernstoff/core/config";
import {
  getRunningDaemonInfo,
  killDaemonProcess,
  listAllRunningDaemons,
  stopAllRunningDaemons,
} from "./daemon-pid.js";
import { ServiceManager } from "./service-manager.js";
import { CLI_VERSION } from "./version.js";

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

function parseExplicitPort(rawPort: string | boolean | undefined): number | undefined {
  if (rawPort === undefined) return undefined;
  const parsed =
    typeof rawPort === "string" && /^\d+$/.test(rawPort.trim()) ? Number(rawPort) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    console.error(
      `Invalid --port '${String(rawPort)}': must be an integer between 1024 and 65535.`,
    );
    process.exit(1);
  }
  return parsed;
}

// Minimal helper to parse flags and arguments
function parseArgs(args: string[]) {
  const BOOLEAN_FLAGS = new Set([
    "daemon",
    "d",
    "json",
    "lex",
    "vec",
    "hyde",
    "ppr",
    "version",
    "v",
    "help",
    "h",
    "user",
    "dry-run",
    "clean",
    "force",
    "all",
    "foreground",
    "global",
    "remove",
    "sync-claude",
    "no-sync-claude",
  ]);

  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const rest = arg.slice(2);
      const eqIdx = rest.indexOf("=");
      if (eqIdx >= 0) {
        flags[rest.slice(0, eqIdx)] = rest.slice(eqIdx + 1);
      } else {
        const key = rest;
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
        } else if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
          flags[key] = args[i + 1]!;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
        flags[key] = args[i + 1]!;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { flags, positional } = parseArgs(rawArgs);

  if (flags.version || flags.v || positional[0] === "--version" || positional[0] === "-v") {
    console.log(`lernstoff v${CLI_VERSION}`);
    return;
  }

  const vaultPath = resolve(typeof flags.vault === "string" ? flags.vault : process.cwd());
  const command = positional[0] || "help";
  const subCommand = positional[1];

  switch (command) {
    case "init": {
      const { initVault } = await import("@lernstoff/core/vault-init");
      await initVault(vaultPath);
      console.log(`✨ Initialized lernstoff-wiki in: ${vaultPath}`);
      console.log(`   Created .lernstoff/config.json and starter templates.`);
      break;
    }

    case "config": {
      const action = subCommand || "list";
      const key = positional[2];
      const val = positional[3];

      if (action === "path") {
        console.log(getConfigPath(vaultPath));
      } else if (action === "get" && key) {
        const value = getConfigValue(vaultPath, key);
        console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : value);
      } else if (action === "set" && key && val !== undefined) {
        let parsedVal: any = val;
        if (val === "true") parsedVal = true;
        else if (val === "false") parsedVal = false;
        else if (!isNaN(Number(val))) parsedVal = Number(val);

        setConfigValue(vaultPath, key, parsedVal);
        console.log(`Updated ${key} = ${JSON.stringify(parsedVal)}`);

        // Notify daemon if running
        const daemonInfo = getRunningDaemonInfo(vaultPath);
        if (daemonInfo) {
          try {
            await fetch(`http://127.0.0.1:${daemonInfo.port}/api/reload-config`, {
              method: "POST",
            });
          } catch {}
        }
      } else if (action === "reset") {
        const conf = resetConfigToDefaults(vaultPath, key);
        console.log(`Reset configuration to defaults:`, conf);
      } else {
        const conf = loadConfig(vaultPath);
        console.log(JSON.stringify(conf, null, 2));
      }
      break;
    }

    case "server": {
      const action = subCommand || "status";

      if (action === "start") {
        const isDaemon = flags.daemon !== undefined || flags.d !== undefined;
        const explicitPort = parseExplicitPort(flags.port);

        if (explicitPort !== undefined) {
          const current = loadConfig(vaultPath);
          saveConfig(vaultPath, {
            server: { ...current.server, port: explicitPort },
          });
        }

        if (isDaemon) {
          const existing = getRunningDaemonInfo(vaultPath);
          if (existing) {
            if (explicitPort !== undefined && existing.port !== explicitPort) {
              killDaemonProcess(existing.pid);
              getRunningDaemonInfo(vaultPath);
            } else {
              console.log(
                `Daemon already running on http://127.0.0.1:${existing.port} (PID ${existing.pid})`,
              );
              return;
            }
          }

          const lernstoffDir = join(vaultPath, LERNSTOFF_DIR);
          mkdirSync(lernstoffDir, { recursive: true });

          const logPath = join(lernstoffDir, "daemon.log");
          const logFd = openSync(logPath, "a");

          const spawnArgs = [
            process.argv[1] || "",
            "server",
            "start",
            "--foreground",
            ...(explicitPort !== undefined ? ["--port", String(explicitPort)] : []),
            "--vault",
            vaultPath,
          ];

          const child = spawn(process.execPath, spawnArgs, {
            stdio: ["ignore", logFd, logFd],
            detached: true,
            cwd: vaultPath,
            env: process.env,
          });
          child.unref();
          closeSync(logFd);

          // Wait up to 3.5s for daemon to initialize and write pid/port
          const startTime = Date.now();
          while (Date.now() - startTime < 3500) {
            const info = getRunningDaemonInfo(vaultPath);
            if (info && (!existing || info.pid !== existing.pid)) {
              try {
                const res = await fetch(`http://127.0.0.1:${info.port}/health`);
                if (res.ok) break;
              } catch {}
            }
            await new Promise((r) => setTimeout(r, 50));
          }

          console.log(`🚀 Started lernstoff daemon in background (PID ${child.pid})`);
          console.log(`   Logs: ${logPath}`);
        } else {
          // Foreground server mode
          const existing = getRunningDaemonInfo(vaultPath);
          if (existing && existing.pid !== process.pid) {
            console.log(
              `Daemon already running on http://127.0.0.1:${existing.port} (PID ${existing.pid})`,
            );
            return;
          }

          const { DaemonServer } = await import("@lernstoff/core");
          const daemon = new DaemonServer({ vaultPath });
          if (explicitPort !== undefined) {
            daemon.config.server.port = explicitPort;
          }
          const port = await daemon.start();
          console.log(
            `🧠 Lernstoff daemon running on http://127.0.0.1:${port} (PID ${process.pid})`,
          );

          const shutdown = async () => {
            console.log("\nShutting down lernstoff daemon...");
            await daemon.stop();
            process.exit(0);
          };

          process.on("SIGINT", shutdown);
          process.on("SIGTERM", shutdown);
        }
      } else if (action === "list" || action === "ls" || action === "ps") {
        const daemons = await listAllRunningDaemons();
        if (flags.json) {
          console.log(JSON.stringify(daemons, null, 2));
          return;
        }

        if (daemons.length === 0) {
          console.log("No running Lernstoff daemons found.");
          return;
        }

        console.log(
          [
            "PID".padEnd(8),
            "PORT".padEnd(8),
            "STATUS".padEnd(12),
            "UPTIME".padEnd(12),
            "VAULT",
          ].join(" "),
        );
        console.log("-".repeat(70));
        for (const d of daemons) {
          const statusText =
            d.status === "orphaned"
              ? "⚠️ ORPHAN"
              : d.status === "running"
                ? "🟢 OK"
                : "🔴 UNHEALTHY";
          const uptimeText = d.uptime !== undefined ? formatUptime(d.uptime) : "-";
          const vaultText = d.isOrphanedVault ? `${d.vaultPath} (DELETED)` : d.vaultPath;
          console.log(
            [
              String(d.pid).padEnd(8),
              String(d.port ?? "-").padEnd(8),
              statusText.padEnd(12),
              uptimeText.padEnd(12),
              vaultText,
            ].join(" "),
          );
        }
      } else if (action === "stop") {
        if (flags.all === true) {
          const res = await stopAllRunningDaemons();
          if (res.stopped === 0) {
            console.log("No running daemons to stop.");
          } else {
            console.log(`🛑 Stopped ${res.stopped} daemon(s).`);
          }
          return;
        }

        if (flags.pid !== undefined) {
          const pid = Number(flags.pid);
          if (!Number.isInteger(pid) || pid <= 0) {
            console.error(`Invalid --pid '${String(flags.pid)}'.`);
            process.exit(1);
          }
          const stopped = killDaemonProcess(pid);
          if (stopped) {
            console.log(`🛑 Stopped daemon with PID ${pid}`);
          } else {
            console.log(`Failed to stop process with PID ${pid}`);
          }
          return;
        }

        if (flags.port !== undefined) {
          const targetPort = parseExplicitPort(flags.port);
          const daemons = await listAllRunningDaemons();
          const match = daemons.find((d) => d.port === targetPort);
          if (!match) {
            console.log(`No daemon found listening on port ${targetPort}`);
            return;
          }
          killDaemonProcess(match.pid);
          if (match.vaultPath && existsSync(match.vaultPath)) {
            getRunningDaemonInfo(match.vaultPath);
          }
          console.log(`🛑 Stopped daemon on port ${targetPort} (PID ${match.pid})`);
          return;
        }

        const existing = getRunningDaemonInfo(vaultPath);
        ServiceManager.stopSupervision(vaultPath);
        if (!existing) {
          console.log(`No daemon running for vault: ${vaultPath}`);
          const running = await listAllRunningDaemons();
          if (running.length > 0) {
            console.log(`\nℹ️ Found ${running.length} other running daemon(s) on this machine:`);
            for (const d of running) {
              const label = d.isOrphanedVault ? " [ORPHAN / DELETED]" : "";
              console.log(`   - Port ${d.port || "?"} (PID ${d.pid}): ${d.vaultPath}${label}`);
            }
            console.log(`\nTo stop all, run: lernstoff server stop --all`);
            console.log(`To stop a specific vault, run: lernstoff server stop --vault "<path>"`);
          }
          return;
        }
        killDaemonProcess(existing.pid);
        getRunningDaemonInfo(vaultPath);
        console.log(`🛑 Stopped daemon (PID ${existing.pid})`);
      } else if (action === "restart") {
        const explicitPort = parseExplicitPort(flags.port);
        if (explicitPort !== undefined) {
          const current = loadConfig(vaultPath);
          saveConfig(vaultPath, {
            server: { ...current.server, port: explicitPort },
          });
        }

        const existing = getRunningDaemonInfo(vaultPath);
        if (existing) {
          killDaemonProcess(existing.pid);
          getRunningDaemonInfo(vaultPath);
          await new Promise((r) => setTimeout(r, 100));
        }

        const isForeground = flags.foreground === true;
        if (!isForeground) {
          const lernstoffDir = join(vaultPath, LERNSTOFF_DIR);
          mkdirSync(lernstoffDir, { recursive: true });

          const logPath = join(lernstoffDir, "daemon.log");
          const logFd = openSync(logPath, "a");

          const spawnArgs = [
            process.argv[1] || "",
            "server",
            "start",
            "--foreground",
            ...(explicitPort !== undefined ? ["--port", String(explicitPort)] : []),
            "--vault",
            vaultPath,
          ];

          const child = spawn(process.execPath, spawnArgs, {
            stdio: ["ignore", logFd, logFd],
            detached: true,
            cwd: vaultPath,
            env: process.env,
          });
          child.unref();
          closeSync(logFd);

          const startTime = Date.now();
          let restartedPort = explicitPort ?? loadConfig(vaultPath).server.port;
          let restartedPid = child.pid;
          while (Date.now() - startTime < 3500) {
            const info = getRunningDaemonInfo(vaultPath);
            if (info && (!existing || info.pid !== existing.pid)) {
              try {
                const res = await fetch(`http://127.0.0.1:${info.port}/health`);
                if (res.ok) {
                  restartedPort = info.port;
                  restartedPid = info.pid;
                  break;
                }
              } catch {}
            }
            await new Promise((r) => setTimeout(r, 50));
          }

          console.log(`🔄 Restarted daemon on port ${restartedPort} (PID ${restartedPid})`);
        } else {
          const { DaemonServer } = await import("@lernstoff/core");
          const daemon = new DaemonServer({ vaultPath });
          if (explicitPort !== undefined) {
            daemon.config.server.port = explicitPort;
          }
          const port = await daemon.start();
          console.log(`🔄 Restarted daemon on port ${port} (PID ${process.pid})`);

          const shutdown = async () => {
            await daemon.stop();
            process.exit(0);
          };

          process.on("SIGINT", shutdown);
          process.on("SIGTERM", shutdown);
        }
      } else if (action === "status") {
        let existing = getRunningDaemonInfo(vaultPath);
        let foreignDaemon: { port: number; pid: number; vault: string } | null = null;

        if (!existing && flags.vault === undefined) {
          try {
            const res = await fetch("http://127.0.0.1:8188/health", {
              signal: AbortSignal.timeout(600),
            });
            if (res.ok) {
              const data = await res.json();
              if (data && data.status === "ok") {
                if (data.vault && resolve(String(data.vault)) === vaultPath) {
                  existing = { port: 8188, pid: data.pid };
                } else if (data.vault) {
                  foreignDaemon = { port: 8188, pid: data.pid, vault: String(data.vault) };
                }
              }
            }
          } catch {}
        }

        if (flags.json) {
          console.log(
            JSON.stringify(
              existing
                ? { running: true, pid: existing.pid, port: existing.port, vault: vaultPath }
                : { running: false, foreignDaemon: foreignDaemon ?? undefined },
              null,
              2,
            ),
          );
          return;
        }

        const isCurrentDirectoryVault = existsSync(join(vaultPath, LERNSTOFF_DIR));
        if (existing) {
          console.log(`🟢 Daemon Running (PID ${existing.pid}, Port ${existing.port})`);
        } else if (foreignDaemon && !isCurrentDirectoryVault) {
          // In an external directory without --vault: surface running daemon with its vault path
          console.log(
            `🟢 Daemon Running (PID ${foreignDaemon.pid}, Port ${foreignDaemon.port}, Vault: ${foreignDaemon.vault})`,
          );
        } else {
          console.log(`⚪ Daemon Stopped`);
          if (foreignDaemon) {
            console.log(
              `ℹ️ Another daemon (PID ${foreignDaemon.pid}) is active on Port ${foreignDaemon.port} for vault:\n   ${foreignDaemon.vault}`,
            );
            console.log(
              `   Run 'lernstoff server list' to see all daemons, or 'lernstoff server stop --all' to stop them.`,
            );
          }
        }
      } else if (action === "logs") {
        const logPath = join(vaultPath, LERNSTOFF_DIR, "daemon.log");
        if (existsSync(logPath)) {
          const lines = readFileSync(logPath, "utf-8").split("\n").slice(-50).join("\n");
          console.log(lines);
        } else {
          console.log(`No logs found at ${logPath}`);
        }
      }
      break;
    }

    case "service": {
      const action = subCommand || "status";
      if (action === "install") {
        const res = await ServiceManager.installService(vaultPath, process.argv[1]);
        console.log(
          `✅ Installed OS boot auto-start service (${res.platform}): ${res.servicePath}`,
        );
      } else if (action === "uninstall") {
        await ServiceManager.uninstallService(vaultPath);
        console.log(`🗑️  Uninstalled OS boot auto-start service for: ${vaultPath}`);
      } else {
        const status = await ServiceManager.getServiceStatus(vaultPath);
        console.log(`Service Status:`, status);
      }
      break;
    }

    case "mcp": {
      const { runMcpStdio } = await import("./stdio-proxy.js");
      await runMcpStdio(vaultPath);
      break;
    }

    case "search": {
      const query = positional.slice(1).join(" ");
      if (!query) {
        console.error("Usage: lernstoff search <query>");
        process.exit(1);
      }
      const { searchCmd } = await import("./cognitive-cmds.js");
      await searchCmd(vaultPath, query, {
        lex: !!flags.lex,
        vec: !!flags.vec,
        limit: flags.limit ? Number(flags.limit) : 5,
        json: !!flags.json,
      });
      break;
    }

    case "inquiry": {
      const action = (subCommand as any) || "list";
      const textOrId = positional[2];
      const { inquiryCmd } = await import("./cognitive-cmds.js");
      await inquiryCmd(vaultPath, action, textOrId, { json: !!flags.json });
      break;
    }

    case "scratchpad": {
      const action = (subCommand as any) || "list";
      const text = positional.slice(2).join(" ");
      const { scratchpadCmd } = await import("./cognitive-cmds.js");
      await scratchpadCmd(vaultPath, action, text, { json: !!flags.json });
      break;
    }

    case "lint": {
      const { lintCmd } = await import("./cognitive-cmds.js");
      await lintCmd(vaultPath, { json: !!flags.json });
      break;
    }

    case "skill": {
      const { AgentInstaller, DEFAULT_SKILL_MD } = await import("./agent-installer.js");
      const action = subCommand || "show";
      if (action === "install") {
        const target = (flags.target as any) || "all";
        const skills = AgentInstaller.installSkill(target, vaultPath);
        const mcps = AgentInstaller.installMcp(target, vaultPath);
        console.log(`✅ Installed SKILL.md to:\n   ${skills.join("\n   ")}`);
        console.log(`✅ Injected MCP configuration to:\n   ${mcps.join("\n   ")}`);
      } else {
        console.log(DEFAULT_SKILL_MD);
      }
      break;
    }

    case "rule": {
      const {
        installLernstoffRule,
        removeLernstoffRule,
        LERNSTOFF_RULE_SNIPPET,
        LERNSTOFF_MARKER_START,
        LERNSTOFF_MARKER_END,
      } = await import("@lernstoff/core");
      const action = subCommand || "show";
      const target = (flags.target as any) || "all";
      const isGlobal = !!flags.global;
      const projectPath = (flags.project as string) || vaultPath;

      if (action === "show") {
        console.log(
          `${LERNSTOFF_MARKER_START}\n${LERNSTOFF_RULE_SNIPPET}\n${LERNSTOFF_MARKER_END}`,
        );
      } else if (action === "install") {
        const result = installLernstoffRule({
          global: isGlobal,
          target,
          projectPath,
          syncClaude: flags["sync-claude"] !== "false" && !flags["no-sync-claude"],
        });
        console.log(`✅ Installed Lernstoff rule to:\n   ${result.updatedFiles.join("\n   ")}`);
        if (result.syncedClaudeFiles.length > 0) {
          console.log(`🔗 Synced @AGENTS.md into:\n   ${result.syncedClaudeFiles.join("\n   ")}`);
        }
      } else if (action === "remove") {
        const result = removeLernstoffRule({
          global: isGlobal,
          target,
          projectPath,
        });
        console.log(`🗑️ Removed Lernstoff rule from:\n   ${result.updatedFiles.join("\n   ")}`);
      } else {
        console.error(`Unknown rule action '${action}'. Expected: show, install, remove`);
        process.exit(1);
      }
      break;
    }

    case "doctor": {
      const { AgentInstaller } = await import("./agent-installer.js");
      const report = await AgentInstaller.runDoctor({
        vaultPath,
        pullModels: !!flags["pull-models"],
        cleanup: !!flags.cleanup,
      });
      console.log(`\n🩺 Lernstoff Doctor Report:`);
      console.log(JSON.stringify(report, null, 2));
      break;
    }

    case "plugin": {
      const action = subCommand || "install";
      if (action === "install") {
        try {
          const { installObsidianPlugin } = await import("./plugin-installer.js");
          const result = await installObsidianPlugin({ vaultPath, version: CLI_VERSION });
          console.log(
            `✅ Successfully installed Obsidian plugin into:\n   ${result.targetPluginDir}`,
          );
          console.log(
            `   Source: ${result.source === "local" ? "Local bundled assets" : "GitHub Releases"}`,
          );
          console.log(`   Copied: main.js, manifest.json, styles.css`);
          console.log(`   Enabled in community-plugins.json`);
        } catch (err: any) {
          console.error(`❌ Plugin installation failed: ${err.message}`);
          process.exit(1);
        }
      }
      break;
    }

    default: {
      console.log(`
🧠 lernstoff-wiki (v${CLI_VERSION}) - Headless Cognitive Selective Note-Taking Engine

Usage:
  lernstoff init [--vault <path>]
  lernstoff config <get|set|list|reset|path> [key] [value] [--vault <path>]
  lernstoff server <start|stop|restart|status|logs|list> [--daemon|--foreground] [--port <n>] [--all]
  lernstoff service <install|uninstall|status> [--vault <path>]
  lernstoff mcp [--vault <path>]
  lernstoff search <query> [--lex|--vec] [--limit <n>] [--json]
  lernstoff inquiry <list|add|close|reopen> [textOrId] [--json]
  lernstoff scratchpad <list|add|consolidate|gc> [text] [--json]
  lernstoff lint [--vault <path>] [--json]
  lernstoff skill <install|show> [--target <all|claude|cursor|antigravity|codex|workbuddy>]
  lernstoff rule <install|remove|show> [--global] [--target <all|codex|claude|antigravity|workbuddy>] [--project <path>]
  lernstoff plugin install [--vault <path>]
  lernstoff doctor [--pull-models|--cleanup]
`);
      break;
    }
  }
}

main().catch((err) => {
  console.error("CLI Error:", err);
  process.exit(1);
});
