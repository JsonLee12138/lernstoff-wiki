import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
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

export type InstallScope = "both" | "global" | "project";

export interface InstallAgentOptions {
  target: TargetAgent;
  vaultPath: string;
  homeDir?: string;
  scope?: InstallScope;
  projectPath?: string;
}

export interface DoctorReport {
  nodeVersion: string;
  platform: string;
  arch: string;
  cliPath: string | null;
  vaultPath: string;
  vaultInitialized: boolean;
  daemonRunning: boolean;
  daemonPid?: number;
  daemonPort?: number;
  sqlitePresent: boolean;
  configValid: boolean;
  models: Record<string, string>;
  cachedModels: string[];
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
   * Detect the absolute path to the `lernstoff` CLI executable on this system.
   */
  public static detectCliExecutablePath(): string | null {
    const binName = process.platform === "win32" ? "lernstoff.cmd" : "lernstoff";
    const binDir = dirname(process.execPath);
    const alongsideNode = join(binDir, binName);
    if (existsSync(alongsideNode)) {
      try {
        return realpathSync(alongsideNode);
      } catch {
        return alongsideNode;
      }
    }

    try {
      const cmd = process.platform === "win32" ? "where lernstoff" : "which lernstoff";
      const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 })
        .toString("utf-8")
        .split(/\r?\n/)[0]
        ?.trim();
      if (out && existsSync(out)) {
        try {
          return realpathSync(out);
        } catch {
          return out;
        }
      }
    } catch {}

    const argv1 = process.argv[1];
    if (argv1 && existsSync(argv1)) {
      try {
        return realpathSync(argv1);
      } catch {
        return resolve(argv1);
      }
    }

    return null;
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
    options?: { homeDir?: string; scope?: InstallScope; projectPath?: string },
  ): string[] {
    const absVault = resolve(vaultPath);
    const projectDir = resolve(options?.projectPath || vaultPath);
    const scope: InstallScope = options?.scope || "both";
    const home = options?.homeDir || AgentInstaller.getHomeDir();
    const installedPaths: string[] = [];

    // Locate source skills across candidate directories
    const candidateRoots = [
      join(__dirname, "../assets/skills"),
      join(__dirname, "assets/skills"),
      join(process.cwd(), "skills"),
      join(absVault, "skills"),
      resolve(__dirname, "../../../skills"),
      resolve(__dirname, "../../skills"),
    ];

    const discoveredSkills = new Map<string, string>();
    for (const rootDir of candidateRoots) {
      if (existsSync(rootDir)) {
        try {
          const entries = readdirSync(rootDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const skillDir = join(rootDir, entry.name);
              if (existsSync(join(skillDir, "SKILL.md")) && !discoveredSkills.has(entry.name)) {
                discoveredSkills.set(entry.name, skillDir);
              }
            }
          }
        } catch {}
      }
    }

    // Fallback if no skills discovered on disk
    if (discoveredSkills.size === 0) {
      discoveredSkills.set("lernstoff-wiki", "");
    }

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

    const keys: TargetAgent[] =
      target === "all" ? ["claude", "cursor", "antigravity", "codex", "workbuddy"] : [target];

    for (const [skillName, sourceSkillDir] of discoveredSkills.entries()) {
      const targetDirs = new Set<string>();

      const getSkillTargets = (agent: TargetAgent): { global: string[]; project: string[] } => {
        switch (agent) {
          case "claude":
            return {
              global: [join(home, ".claude/skills", skillName)],
              project: [join(projectDir, ".claude/skills", skillName)],
            };
          case "antigravity":
            return {
              global: [join(home, ".gemini/config/skills", skillName)],
              project: [join(projectDir, ".agents/skills", skillName)],
            };
          case "cursor":
            return {
              global: [join(home, ".cursor/skills", skillName)],
              project: [join(projectDir, ".cursor/skills", skillName)],
            };
          case "codex":
            return {
              global: [join(home, ".agents/skills", skillName)],
              project: [join(projectDir, ".agents/skills", skillName)],
            };
          case "workbuddy":
            return {
              global: [join(home, ".workbuddy/skills", skillName)],
              project: [join(projectDir, ".codebuddy/skills", skillName)],
            };
          default:
            return { global: [], project: [] };
        }
      };

      for (const agent of keys) {
        const paths = getSkillTargets(agent);
        if (scope === "global" || scope === "both") {
          for (const p of paths.global) targetDirs.add(p);
        }
        if (scope === "project" || scope === "both") {
          for (const p of paths.project) targetDirs.add(p);
        }
      }

      for (const targetDir of targetDirs) {
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

    return Array.from(new Set(installedPaths));
  }

  public static installMcp(
    target: TargetAgent,
    vaultPath: string,
    options?: { homeDir?: string; scope?: InstallScope; projectPath?: string },
  ): string[] {
    const absVault = resolve(vaultPath);
    const projectDir = resolve(options?.projectPath || vaultPath);
    const scope: InstallScope = options?.scope || "both";
    const mcpEntry = AgentInstaller.getMcpConfig(absVault);
    const configuredFiles: string[] = [];
    const home = options?.homeDir || AgentInstaller.getHomeDir();

    const getMcpConfigs = (agent: TargetAgent): { global: string[]; project: string[] } => {
      switch (agent) {
        case "claude":
          return {
            global: [join(home, ".claude.json")],
            project: [join(projectDir, ".mcp.json")],
          };
        case "cursor":
          return {
            global: [join(home, ".cursor/mcp.json")],
            project: [join(projectDir, ".cursor/mcp.json")],
          };
        case "antigravity":
          return {
            global: [
              join(home, ".gemini/antigravity/mcp_config.json"),
              join(home, ".gemini/config/mcp_config.json"),
            ],
            project: [],
          };
        case "codex":
          return {
            global: [],
            project: [join(projectDir, ".mcp.json")],
          };
        case "workbuddy":
          return {
            global: [join(home, ".workbuddy/mcp.json")],
            project: [join(projectDir, ".mcp.json")],
          };
        default:
          return { global: [], project: [] };
      }
    };

    const keys: TargetAgent[] =
      target === "all" ? ["claude", "cursor", "antigravity", "codex", "workbuddy"] : [target];

    const targetFiles = new Set<string>();
    for (const agent of keys) {
      const paths = getMcpConfigs(agent);
      if (scope === "global" || scope === "both") {
        for (const p of paths.global) targetFiles.add(p);
      }
      if (scope === "project" || scope === "both") {
        for (const p of paths.project) targetFiles.add(p);
      }
    }

    for (const file of targetFiles) {
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

    return Array.from(new Set(configuredFiles));
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
      try {
        const require = createRequire(import.meta.url);
        const qmdPkgPath = require.resolve("@tobilu/qmd/package.json");
        const qmdBin = join(dirname(qmdPkgPath), "bin/qmd");
        if (existsSync(qmdBin)) {
          execSync(`"${process.execPath}" "${qmdBin}" pull`, {
            stdio: "inherit",
            timeout: 300_000,
          });
        }
      } catch {}
    }

    const cacheHome = process.env.XDG_CACHE_HOME || join(AgentInstaller.getHomeDir(), ".cache");
    const qmdModelsDir = join(cacheHome, "qmd", "models");
    let cachedModels: string[] = [];
    if (existsSync(qmdModelsDir)) {
      try {
        cachedModels = readdirSync(qmdModelsDir).filter((f) => f.endsWith(".gguf"));
      } catch {}
    }

    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cliPath: AgentInstaller.detectCliExecutablePath(),
      vaultPath: absVault,
      vaultInitialized,
      daemonRunning: !!daemonInfo,
      daemonPid: daemonInfo?.pid,
      daemonPort: daemonInfo?.port,
      sqlitePresent,
      configValid: vaultInitialized,
      models,
      cachedModels,
    };
  }
}
