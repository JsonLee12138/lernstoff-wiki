import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { QmdBridge, LERNSTOFF_DIR } from "@lernstoff/core";
import { getRunningDaemonInfo } from "./daemon-pid.js";

export const DEFAULT_SKILL_MD = `---
name: lernstoff-wiki
description: Headless Cognitive Selective Note-Taking Protocol for AI Agents and Obsidian. Use when reading documentation, analyzing papers, researching concepts, managing curiosity inquiry trees, verifying cognitive deltas, and creating evergreen proposition notes.
---

# lernstoff-wiki Cognitive Selective Note-Taking Protocol

When pair-programming, exploring codebases, reading papers, or synthesizing architecture decisions, follow this 4-step selective note-taking protocol to avoid information hoarding ("Collector's Fallacy") and keep the Obsidian Vault high-signal.

## Protocol Workflow
1. Step 1: Probe Cognitive Delta (lernstoff_probe_delta) - NEVER write notes directly to disk.
2. Step 2: Socratic 4-Question Defense (Q1: Delta, Q2: Belief update, Q3: >= 2 outbound links, Q4: Proposition-as-Title).
3. Step 3: Crystallize Proposition Note (lernstoff_crystallize_note).
4. Step 4: Fast Scratchpad Consolidation (lernstoff_consolidate_scratchpad).
`;

export interface InstallAgentOptions {
  target: "all" | "claude" | "cursor" | "antigravity";
  vaultPath: string;
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

export class AgentInstaller {
  public static getMcpConfig(vaultPath: string): { command: string; args: string[] } {
    return {
      command: "lernstoff",
      args: ["mcp", "--vault", resolve(vaultPath)],
    };
  }

  public static installSkill(
    target: "all" | "claude" | "cursor" | "antigravity",
    vaultPath: string,
  ): string[] {
    const absVault = resolve(vaultPath);
    const installedPaths: string[] = [];

    // Resolve SKILL.md template from repo if available, else fallback to embedded
    let skillContent = DEFAULT_SKILL_MD;
    const localSkill = join(absVault, "skills/lernstoff-wiki/SKILL.md");
    if (existsSync(localSkill)) {
      try {
        skillContent = readFileSync(localSkill, "utf-8");
      } catch {}
    }

    const targets: Record<string, string[]> = {
      claude: [join(homedir(), ".claude/skills/lernstoff-wiki/SKILL.md")],
      antigravity: [join(homedir(), ".gemini/config/skills/lernstoff-wiki/SKILL.md")],
      cursor: [
        join(absVault, ".cursor/skills/lernstoff-wiki/SKILL.md"),
        join(homedir(), ".cursor/skills/lernstoff-wiki/SKILL.md"),
      ],
    };

    const keys = target === "all" ? Object.keys(targets) : [target];
    for (const key of keys) {
      const paths = targets[key] || [];
      for (const p of paths) {
        try {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, skillContent, "utf-8");
          installedPaths.push(p);
        } catch {}
      }
    }

    return installedPaths;
  }

  public static installMcp(
    target: "all" | "claude" | "cursor" | "antigravity",
    vaultPath: string,
  ): string[] {
    const absVault = resolve(vaultPath);
    const mcpEntry = AgentInstaller.getMcpConfig(absVault);
    const configuredFiles: string[] = [];

    const configFiles: Record<string, string[]> = {
      claude: [join(homedir(), ".claude.json"), join(absVault, ".mcp.json")],
      cursor: [join(absVault, ".cursor/mcp.json"), join(homedir(), ".cursor/mcp.json")],
      antigravity: [join(homedir(), ".gemini/antigravity/mcp_config.json")],
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
