#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  initVault,
  loadConfig,
  getConfigValue,
  setConfigValue,
  resetConfigToDefaults,
  getConfigPath,
  DaemonServer,
  LERNSTOFF_DIR,
} from "@lernstoff/core";
import { getRunningDaemonInfo, killDaemonProcess } from "./daemon-pid.js";
import { runMcpStdio } from "./stdio-proxy.js";
import { ServiceManager } from "./service-manager.js";
import { AgentInstaller, DEFAULT_SKILL_MD } from "./agent-installer.js";
import { searchCmd, inquiryCmd, scratchpadCmd, lintCmd } from "./cognitive-cmds.js";

const require = createRequire(import.meta.url);
const CLI_VERSION: string = (() => {
  try {
    return require("../package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Minimal helper to parse flags and arguments
function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
        flags[key] = args[i + 1]!;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-")) {
      flags[arg.slice(1)] = true;
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
    console.log(CLI_VERSION);
    return;
  }

  const vaultPath = resolve(typeof flags.vault === "string" ? flags.vault : process.cwd());
  const command = positional[0] || "help";
  const subCommand = positional[1];

  switch (command) {
    case "init": {
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

        if (isDaemon) {
          const existing = getRunningDaemonInfo(vaultPath);
          if (existing) {
            console.log(
              `Daemon already running on http://127.0.0.1:${existing.port} (PID ${existing.pid})`,
            );
            return;
          }

          const logPath = join(vaultPath, LERNSTOFF_DIR, "daemon.log");
          const logFd = openSync(logPath, "a");

          const child = spawn(
            process.execPath,
            [process.argv[1] || "", "server", "start", "--foreground", "--vault", vaultPath],
            {
              stdio: ["ignore", logFd, logFd],
              detached: true,
              cwd: vaultPath,
              env: process.env,
            },
          );
          child.unref();
          closeSync(logFd);

          console.log(`🚀 Started lernstoff daemon in background (PID ${child.pid})`);
          console.log(`   Logs: ${logPath}`);
        } else {
          // Foreground server mode
          const daemon = new DaemonServer({ vaultPath });
          if (flags.port) {
            daemon.config.server.port = Number(flags.port);
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
      } else if (action === "stop") {
        const existing = getRunningDaemonInfo(vaultPath);
        if (!existing) {
          console.log(`No daemon running for vault: ${vaultPath}`);
          return;
        }
        killDaemonProcess(existing.pid);
        console.log(`🛑 Stopped daemon (PID ${existing.pid})`);
      } else if (action === "restart") {
        const existing = getRunningDaemonInfo(vaultPath);
        if (existing) {
          killDaemonProcess(existing.pid);
        }
        const daemon = new DaemonServer({ vaultPath });
        const port = await daemon.start();
        console.log(`🔄 Restarted daemon on port ${port} (PID ${process.pid})`);
      } else if (action === "status") {
        const existing = getRunningDaemonInfo(vaultPath);
        if (existing) {
          console.log(`🟢 Daemon Running (PID ${existing.pid}, Port ${existing.port})`);
        } else {
          console.log(`⚪ Daemon Stopped`);
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
      await runMcpStdio(vaultPath);
      break;
    }

    case "search": {
      const query = positional.slice(1).join(" ");
      if (!query) {
        console.error("Usage: lernstoff search <query>");
        process.exit(1);
      }
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
      await inquiryCmd(vaultPath, action, textOrId, { json: !!flags.json });
      break;
    }

    case "scratchpad": {
      const action = (subCommand as any) || "list";
      const text = positional.slice(2).join(" ");
      await scratchpadCmd(vaultPath, action, text, { json: !!flags.json });
      break;
    }

    case "lint": {
      await lintCmd(vaultPath, { json: !!flags.json });
      break;
    }

    case "skill": {
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

    case "doctor": {
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
        const obsidianDir = join(vaultPath, ".obsidian");
        const targetPluginDir = join(obsidianDir, "plugins", "lernstoff-wiki");
        mkdirSync(targetPluginDir, { recursive: true });

        // Look for plugin assets in known locations
        const candidateDirs = [
          join(import.meta.dirname, "../../obsidian-plugin/dist"),
          join(import.meta.dirname, "../node_modules/@lernstoff/obsidian-plugin/dist"),
          join(process.cwd(), "packages/obsidian-plugin/dist"),
        ];
        let foundDir: string | null = null;
        for (const dir of candidateDirs) {
          if (existsSync(join(dir, "main.js")) && existsSync(join(dir, "manifest.json"))) {
            foundDir = dir;
            break;
          }
        }

        if (!foundDir) {
          console.error(
            "Could not find compiled plugin assets (main.js, manifest.json). Please run 'pnpm build' first.",
          );
          process.exit(1);
        }

        copyFileSync(join(foundDir, "main.js"), join(targetPluginDir, "main.js"));
        copyFileSync(join(foundDir, "manifest.json"), join(targetPluginDir, "manifest.json"));
        if (existsSync(join(foundDir, "styles.css"))) {
          copyFileSync(join(foundDir, "styles.css"), join(targetPluginDir, "styles.css"));
        }

        // Enable in community-plugins.json if it exists
        const communityPluginsPath = join(obsidianDir, "community-plugins.json");
        try {
          let plugins: string[] = [];
          if (existsSync(communityPluginsPath)) {
            plugins = JSON.parse(readFileSync(communityPluginsPath, "utf-8"));
          }
          if (!plugins.includes("lernstoff-wiki")) {
            plugins.push("lernstoff-wiki");
            writeFileSync(communityPluginsPath, JSON.stringify(plugins, null, 2), "utf-8");
          }
        } catch {}

        console.log(`✅ Successfully installed Obsidian plugin into:\n   ${targetPluginDir}`);
        console.log(`   Copied: main.js, manifest.json, styles.css`);
        console.log(`   Enabled in community-plugins.json`);
      }
      break;
    }

    default: {
      console.log(`
🧠 lernstoff-wiki (v${CLI_VERSION}) - Headless Cognitive Selective Note-Taking Engine

Usage:
  lernstoff init [--vault <path>]
  lernstoff config <get|set|list|reset|path> [key] [value] [--vault <path>]
  lernstoff server <start|stop|restart|status|logs> [--daemon|--foreground] [--port <n>]
  lernstoff service <install|uninstall|status> [--vault <path>]
  lernstoff mcp [--vault <path>]
  lernstoff search <query> [--lex|--vec] [--limit <n>] [--json]
  lernstoff inquiry <list|add|close|reopen> [textOrId] [--json]
  lernstoff scratchpad <list|add|consolidate|gc> [text] [--json]
  lernstoff lint [--vault <path>] [--json]
  lernstoff skill <install|show> [--target <all|claude|cursor|antigravity>]
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
