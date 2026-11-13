import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { QmdBridge, LERNSTOFF_DIR } from "@lernstoff/core";
import { getRunningDaemonInfo } from "./daemon-pid.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SKILL_MD = `---
name: lernstoff-wiki
description: Cognitive selective note-taking protocol and MCP engine for Obsidian. Activate when exploring codebases, researching architectures, conducting bug postmortems, reading technical papers/docs, recalling prior decisions, or persisting project knowledge to Obsidian.
---

# \`lernstoff-wiki\` Cognitive Protocol

Headless cognitive note-taking engine implementing a 3-stage hippocampal novelty gate, Socratic proposition defense, curiosity inquiry tracking, and Monte Carlo Personalized PageRank memory search.

## 1. Decision Tree & Core Workflows

Choose the matching workflow based on your current task:
- Workflow 1: Research & Crystallize (search_memory -> probe_delta -> Socratic defense -> crystallize_note)
- Workflow 2: Vault Health & Synthesize (lint_wiki -> get_note -> SYNTHESIZE_CLUSTER -> manage_inquiries close)
- Workflow 3: Scratchpad & Consolidate (consolidate_scratchpad inspect -> promote -> gc)

## 2. Non-Negotiable Guardrails

- Proposition-as-Title Rule: Titles MUST express a complete falsifiable claim, NEVER bare nouns or topics.
- Anti-Orphan Requirement: Every permanent note MUST connect >= 2 typed links to existing notes.
- Hippocampal Gate First: NEVER write directly to wiki/ or inbox/scratchpad.md without running lernstoff_probe_delta.
`;

export type TargetAgent = "all" | "claude" | "cursor" | "antigravity" | "codex" | "workbuddy";

export interface InstallAgentOptions {
  target: TargetAgent;
  vaultPath: string;
  homeDir?: string;
}

export interface DoctorReport {
  nodeVersion: string;
  platform: string;
  arch: string;
  vaultPath: string;
  vaultInitialized: boolean;
  daemonRunning: boolean;
  daemonPid?: number;
  daemonPort?: number;
  sqlitePresent: boolean;
  configValid: boolean;
  models: Record<string, string>;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class AgentInstaller {
  public static getHomeDir(): string {
    return process.env.HOME || homedir();
  }

  /**
   * Build the MCP server entry for `lernstoff`. Resolves the absolute binary
   * next to `process.execPath` when available and includes its bin directory in
   * `env.PATH` so GUI hosts (Antigravity, Cursor, Claude Desktop) can locate
   * both `lernstoff` and `node` without a shell profile.
   */
  public static getMcpConfig(vaultPath: string): McpServerEntry {
    const absVault = resolve(vaultPath);
    const binDir = dirname(process.execPath);
    const binName = process.platform === "win32" ? "lernstoff.cmd" : "lernstoff";
    const resolvedBin = join(binDir, binName);
    if (existsSync(resolvedBin)) {
      const basePath = process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
      const pathParts = Array.from(new Set([binDir, ...basePath.split(":")].filter(Boolean)));
      return {
        command: resolvedBin,
        args: ["mcp", "--vault", absVault],
        env: { PATH: pathParts.join(":") },
      };
    }

    return {
      command: "lernstoff",
      args: ["mcp", "--vault", absVault],
    };
  }

  public static installSkill(
    target: TargetAgent,
    vaultPath: string,
    options?: { homeDir?: string },
  ): string[] {
    const absVault = resolve(vaultPath);
    const installedPaths: string[] = [];

    // Locate source skills/lernstoff-wiki directory
    const possibleSkillDirs = [
      join(__dirname, "../assets/skills/lernstoff-wiki"),
      join(__dirname, "assets/skills/lernstoff-wiki"),
      join(process.cwd(), "skills/lernstoff-wiki"),
      join(absVault, "skills/lernstoff-wiki"),
      resolve(__dirname, "../../../skills/lernstoff-wiki"),
      resolve(__dirname, "../../skills/lernstoff-wiki"),
    ];

    let sourceSkillDir: string | null = null;
    for (const d of possibleSkillDirs) {
      if (existsSync(join(d, "SKILL.md"))) {
        sourceSkillDir = d;
        break;
      }
    }

    const home = options?.homeDir || AgentInstaller.getHomeDir();
    const targets: Record<string, string[]> = {
      claude: [join(home, ".claude/skills/lernstoff-wiki")],
      antigravity: [join(home, ".gemini/config/skills/lernstoff-wiki")],
      cursor: [
        join(absVault, ".cursor/skills/lernstoff-wiki"),
        join(home, ".cursor/skills/lernstoff-wiki"),
      ],
      codex: [
        join(absVault, ".agents/skills/lernstoff-wiki"),
        join(home, ".agents/skills/lernstoff-wiki"),
      ],
      workbuddy: [
        join(absVault, ".codebuddy/skills/lernstoff-wiki"),
        join(home, ".workbuddy/skills/lernstoff-wiki"),
      ],
    };

    const copyDirRecursive = (src: string, dest: string) => {
      mkdirSync(dest, { recursive: true });
      const entries = readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDirRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
          copyFileSync(srcPath, destPath);
          installedPaths.push(destPath);
        }
      }
    };

    const keys = target === "all" ? Object.keys(targets) : [target];
    for (const key of keys) {
      const paths = targets[key] || [];
      for (const targetDir of paths) {
        try {
          if (sourceSkillDir) {
            copyDirRecursive(sourceSkillDir, targetDir);
          } else {
            mkdirSync(targetDir, { recursive: true });
            const filePath = join(targetDir, "SKILL.md");
            writeFileSync(filePath, DEFAULT_SKILL_MD, "utf-8");
            installedPaths.push(filePath);
          }
        } catch {}
      }
    }

    return installedPaths;
  }

  public static installMcp(
    target: TargetAgent,
    vaultPath: string,
    options?: { homeDir?: string },
  ): string[] {
    const absVault = resolve(vaultPath);
    const mcpEntry = AgentInstaller.getMcpConfig(absVault);
    const configuredFiles: string[] = [];
    const home = options?.homeDir || AgentInstaller.getHomeDir();

    const configFiles: Record<string, string[]> = {
      claude: [join(home, ".claude.json"), join(absVault, ".mcp.json")],
      cursor: [join(absVault, ".cursor/mcp.json"), join(home, ".cursor/mcp.json")],
      antigravity: [
        join(home, ".gemini/antigravity/mcp_config.json"),
        join(home, ".gemini/config/mcp_config.json"),
      ],
      codex: [join(absVault, ".mcp.json")],
      workbuddy: [join(absVault, ".mcp.json"), join(home, ".workbuddy/mcp.json")],
    };

    const keys = target === "all" ? Object.keys(configFiles) : [target];
    for (const key of keys) {
      const files = configFiles[key] || [];
      for (const file of files) {
        try {
          mkdirSync(dirname(file), { recursive: true });
          let json: any = {};
          if (existsSync(file)) {
            try {
              json = JSON.parse(readFileSync(file, "utf-8"));
            } catch {
              json = {};
            }
          }

          if (!json.mcpServers) json.mcpServers = {};
          json.mcpServers["lernstoff"] = mcpEntry;

          writeFileSync(file, JSON.stringify(json, null, 2), "utf-8");
          configuredFiles.push(file);
        } catch {}
      }
    }

    return configuredFiles;
  }

  public static async runDoctor(options: {
    vaultPath: string;
    pullModels?: boolean;
    cleanup?: boolean;
  }): Promise<DoctorReport> {
    const absVault = resolve(options.vaultPath);
    const lernstoffDir = join(absVault, LERNSTOFF_DIR);
    const configFile = join(lernstoffDir, "config.json");
    const sqliteFile = join(lernstoffDir, "index.sqlite");

    const vaultInitialized = existsSync(configFile);
    const sqlitePresent = existsSync(sqliteFile);
    const daemonInfo = getRunningDaemonInfo(absVault);

    let models: Record<string, string> = {};
    if (vaultInitialized) {
      try {
        const conf = JSON.parse(readFileSync(configFile, "utf-8"));
        models = conf.models || {};
      } catch {}
    }

    if (options.cleanup && sqlitePresent) {
      try {
        const bridge = new QmdBridge({ vaultPath: absVault });
        const store = await bridge.getStore();
        // Trigger SQLite vacuum and cleanup if supported by store
        if (typeof (store as any).cleanup === "function") {
          await (store as any).cleanup();
        }
        await bridge.close();
      } catch {}
    }

    if (options.pullModels) {
      // In offline/test environments, verify model paths exist or trigger download
    }

    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      vaultPath: absVault,
      vaultInitialized,
      daemonRunning: !!daemonInfo,
      daemonPid: daemonInfo?.pid,
      daemonPort: daemonInfo?.port,
      sqlitePresent,
      configValid: vaultInitialized,
      models,
    };
  }
}
