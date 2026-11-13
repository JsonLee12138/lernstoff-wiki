import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LERNSTOFF_MARKER_START = "<!-- lernstoff:start -->";
export const LERNSTOFF_MARKER_END = "<!-- lernstoff:end -->";

export const LERNSTOFF_RULE_SNIPPET = `### Lernstoff Wiki & Memory Routing Rules

1. **Search Before Research**:
   - Before researching unfamiliar code, diagnosing recurring issues, or formulating architecture designs, always query repository memory via \`lernstoff_search_memory\`.

2. **Triggering \`lernstoff-wiki\` Skill**:
   - Invoke \`skills/lernstoff-wiki\` (or \`/lernstoff-wiki\`) whenever:
     * Post-research or post-debugging yields durable, falsifiable engineering propositions.
     * Open inquiries reach >= 5 related concept notes and require higher-order synthesis (\`SYNTHESIZE_CLUSTER\`).
     * Periodic maintenance or buffer promotion (\`lernstoff_consolidate_scratchpad\`) is requested.

3. **Cognitive Gatekeeping Red Line**:
   - **Never bypass the hippocampal gate**: All candidate claims, external findings, and notes must pass through \`lernstoff_probe_delta\` and \`lernstoff_crystallize_note\` with Socratic defense.
   - Direct unstructured edits to \`wiki/\` or \`inbox/scratchpad.md\` are strictly prohibited.`;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function upsertMarkedBlock(existingContent: string, newBlock: string): string {
  const formattedBlock = `${LERNSTOFF_MARKER_START}\n${newBlock.trim()}\n${LERNSTOFF_MARKER_END}`;
  const pattern = new RegExp(
    `${escapeRegex(LERNSTOFF_MARKER_START)}[\\s\\S]*?${escapeRegex(LERNSTOFF_MARKER_END)}`,
    "m",
  );

  if (pattern.test(existingContent)) {
    return existingContent.replace(pattern, () => formattedBlock);
  }

  if (!existingContent.trim()) {
    return `${formattedBlock}\n`;
  }

  const prefix = existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
  const separator = prefix.endsWith("\n\n") ? "" : "\n";
  return `${prefix}${separator}${formattedBlock}\n`;
}

export function removeMarkedBlock(existingContent: string): string {
  const pattern = new RegExp(
    `\\n?${escapeRegex(LERNSTOFF_MARKER_START)}[\\s\\S]*?${escapeRegex(LERNSTOFF_MARKER_END)}\\n?`,
    "g",
  );

  if (!pattern.test(existingContent)) {
    return existingContent;
  }

  const stripped = existingContent.replace(pattern, "\n");
  if (!stripped.trim()) {
    return "";
  }

  return stripped.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export type RuleTarget = "all" | "codex" | "claude" | "antigravity" | "workbuddy";

export interface RuleInstallOptions {
  global?: boolean;
  target?: RuleTarget;
  projectPath?: string;
  homeDir?: string;
  syncClaude?: boolean;
}

export function resolveGlobalRuleFiles(homeDir?: string, target: RuleTarget = "all"): string[] {
  const home = homeDir || process.env.HOME || homedir();
  const map: Record<Exclude<RuleTarget, "all">, string> = {
    codex: join(home, ".codex", "AGENTS.md"),
    claude: join(home, ".claude", "CLAUDE.md"),
    antigravity: join(home, ".gemini", "GEMINI.md"),
    workbuddy: join(home, ".workbuddy", "rules", "lernstoff.md"),
  };

  if (target === "all") {
    return Object.values(map);
  }
  return map[target] ? [map[target]] : [];
}

export function installLernstoffRule(options: RuleInstallOptions): {
  updatedFiles: string[];
  syncedClaudeFiles: string[];
} {
  const updatedFiles: string[] = [];
  const syncedClaudeFiles: string[] = [];

  if (options.global) {
    const targets = resolveGlobalRuleFiles(options.homeDir, options.target || "all");
    for (const filePath of targets) {
      const parentDir = dirname(filePath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
      const nextContent = upsertMarkedBlock(existing, LERNSTOFF_RULE_SNIPPET);
      writeFileSync(filePath, nextContent, "utf-8");
      updatedFiles.push(filePath);
    }
    return { updatedFiles, syncedClaudeFiles };
  }

  // Project scope
  const projectDir = resolve(options.projectPath || process.cwd());
  const agentsPath = join(projectDir, "AGENTS.md");
  const existingAgents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf-8") : "";
  const nextAgents = upsertMarkedBlock(existingAgents, LERNSTOFF_RULE_SNIPPET);
  writeFileSync(agentsPath, nextAgents, "utf-8");
  updatedFiles.push(agentsPath);

  // Check CLAUDE.md sync
  if (options.syncClaude !== false) {
    const claudePath = join(projectDir, "CLAUDE.md");
    if (existsSync(claudePath)) {
      const claudeContent = readFileSync(claudePath, "utf-8");
      if (
        !claudeContent.includes("@AGENTS.md") &&
        !claudeContent.includes(LERNSTOFF_MARKER_START)
      ) {
        const prefix = claudeContent.endsWith("\n") ? claudeContent : `${claudeContent}\n`;
        const nextClaude = `${prefix}@AGENTS.md\n`;
        writeFileSync(claudePath, nextClaude, "utf-8");
        syncedClaudeFiles.push(claudePath);
      }
    }
  }

  return { updatedFiles, syncedClaudeFiles };
}

export function removeLernstoffRule(options: RuleInstallOptions): {
  updatedFiles: string[];
} {
  const updatedFiles: string[] = [];

  if (options.global) {
    const targets = resolveGlobalRuleFiles(options.homeDir, options.target || "all");
    for (const filePath of targets) {
      if (existsSync(filePath)) {
        const existing = readFileSync(filePath, "utf-8");
        const cleaned = removeMarkedBlock(existing);
        if (cleaned !== existing) {
          writeFileSync(filePath, cleaned, "utf-8");
          updatedFiles.push(filePath);
        }
      }
    }
    return { updatedFiles };
  }

  // Project scope
  const projectDir = resolve(options.projectPath || process.cwd());
  const agentsPath = join(projectDir, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const existing = readFileSync(agentsPath, "utf-8");
    const cleaned = removeMarkedBlock(existing);
    if (cleaned !== existing) {
      writeFileSync(agentsPath, cleaned, "utf-8");
      updatedFiles.push(agentsPath);
    }
  }

  const claudePath = join(projectDir, "CLAUDE.md");
  if (existsSync(claudePath)) {
    const existingClaude = readFileSync(claudePath, "utf-8");
    const cleanedClaude = removeMarkedBlock(existingClaude);
    if (cleanedClaude !== existingClaude) {
      writeFileSync(claudePath, cleanedClaude, "utf-8");
      updatedFiles.push(claudePath);
    }
  }

  return { updatedFiles };
}
