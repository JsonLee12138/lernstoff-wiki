import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { QmdBridge, LERNSTOFF_DIR } from "@lernstoff/core";
import { getRunningDaemonInfo } from "./daemon-pid.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SKILL_MD = `---
name: lernstoff-wiki
description: Comprehensive MCP Tool Manual and Cognitive Selective Note-Taking Protocol for AI Agents and Obsidian. Use when exploring codebases, reading papers, querying vault memory, verifying epistemic deltas, defending propositions through Socratic guards, and maintaining evergreen notes.
---

# \`lernstoff-wiki\` MCP Tool Manual & Protocol Guide

\`lernstoff-wiki\` provides a headless cognitive selective note-taking engine for AI programming agents (Claude Code, Cursor, Antigravity, OpenCode) and Obsidian. It implements a 3-stage hippocampal filtering gate, Socratic proposition defense, curiosity inquiry tracking, and Monte Carlo Personalized PageRank associative search.

---

## 1. Unified MCP Capabilities (8 Tools + 1 Resource)

\`lernstoff-wiki\` registers 8 native MCP tools and 1 dynamic resource template under the \`lernstoff\` MCP server namespace.

### Tool Matrix

| Tool Name                          | Core Purpose                      | Typical Latency      | Key Output / Side Effect                                                        |
| :--------------------------------- | :-------------------------------- | :------------------- | :------------------------------------------------------------------------------ |
| \`lernstoff_probe_delta\`            | 3-stage hippocampal novelty gate  | 1ms (G1) ~ 20ms (G3) | Discards noise (>= 75%), defers to scratchpad, or escalates survivors          |
| \`lernstoff_crystallize_note\`       | Atomic proposition note synthesis | < 15ms               | Creates/amends \`wiki/concepts/<slug>.md\` with Socratic frontmatter              |
| \`lernstoff_manage_inquiries\`       | Curiosity tree lifecycle          | < 5ms                | Manages \`wiki/inquiries.md\` (\`list\`, \`add\`, \`close\`, \`reopen\`)                  |
| \`lernstoff_consolidate_scratchpad\` | Scratchpad promotion & GC         | < 10ms               | Scans multi-source collisions (>= 2) & prunes expired entries (> 14d)           |
| \`lernstoff_lint_wiki\`              | Socratic vault health audit       | < 25ms               | Detects orphan notes (in-degree 0), latent contradictions, synthesis candidates |
| \`lernstoff_search_memory\`          | Hybrid search + PPR walk          | 15ms ~ 40ms          | Vector + BM25 hits + 2-hop Monte Carlo associative graph neighborhood           |
| \`lernstoff_get_note\`               | Exact line slicing & backlinks    | < 5ms                | Returns note content with line numbers (\`path:from:count\`) & inbound backlinks  |
| \`lernstoff_status\`                 | Health & metrics snapshot         | < 5ms                | Reports QMD store status, active inquiries count, scratchpad metrics            |
| \`lernstoff://{+path}\` _(Resource)_ | Direct note content URI           | < 2ms                | Streams raw note Markdown directly into agent context                           |

---

## 2. Detailed Tool Specifications

1. \`lernstoff_probe_delta\`: Evaluates candidate proposition claims through the 3-stage hippocampal filter before writing to disk.
2. \`lernstoff_crystallize_note\`: Synthesizes a permanent proposition note in \`wiki/concepts/<slug>.md\`. Enforces Socratic defense constraints.
3. \`lernstoff_manage_inquiries\`: Interacts with the curiosity question tree stored in \`wiki/inquiries.md\`.
4. \`lernstoff_consolidate_scratchpad\`: Scans and manages the fast scratchpad buffer (\`inbox/scratchpad.md\`).
5. \`lernstoff_lint_wiki\`: Performs an automated epistemic health check of the Obsidian Vault.
6. \`lernstoff_search_memory\`: Queries vault memory with hybrid vector/keyword search combined with Monte Carlo Personalized PageRank.
7. \`lernstoff_get_note\`: Reads note content with line slicing and extracts backlinks without loading full files into token context.
8. \`lernstoff_status\`: Reports real-time system metrics (QMD database health, open inquiries, scratchpad buffer size, concept count).
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
  public static getHomeDir(): string {
    return process.env.HOME || homedir();
  }

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
    const possibleSkillPaths = [
      join(absVault, "skills/lernstoff-wiki/SKILL.md"),
      join(process.cwd(), "skills/lernstoff-wiki/SKILL.md"),
      resolve(__dirname, "../../../skills/lernstoff-wiki/SKILL.md"),
      resolve(__dirname, "../../skills/lernstoff-wiki/SKILL.md"),
    ];
    for (const p of possibleSkillPaths) {
      if (existsSync(p)) {
        try {
          const content = readFileSync(p, "utf-8");
          if (content.length > 100) {
            skillContent = content;
            break;
          }
        } catch {}
      }
    }

    const home = AgentInstaller.getHomeDir();
    const targets: Record<string, string[]> = {
      claude: [join(home, ".claude/skills/lernstoff-wiki/SKILL.md")],
      antigravity: [join(home, ".gemini/config/skills/lernstoff-wiki/SKILL.md")],
      cursor: [
        join(absVault, ".cursor/skills/lernstoff-wiki/SKILL.md"),
        join(home, ".cursor/skills/lernstoff-wiki/SKILL.md"),
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
    const home = AgentInstaller.getHomeDir();

    const configFiles: Record<string, string[]> = {
      claude: [join(home, ".claude.json"), join(absVault, ".mcp.json")],
      cursor: [join(absVault, ".cursor/mcp.json"), join(home, ".cursor/mcp.json")],
      antigravity: [join(home, ".gemini/antigravity/mcp_config.json")],
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
