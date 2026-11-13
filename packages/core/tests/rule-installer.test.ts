import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LERNSTOFF_MARKER_START,
  LERNSTOFF_MARKER_END,
  LERNSTOFF_RULE_SNIPPET,
  upsertMarkedBlock,
  removeMarkedBlock,
  installLernstoffRule,
  removeLernstoffRule,
} from "../src/rule-installer.js";

describe("Rule Installer - Pure Functions & Idempotency", () => {
  it("upsertMarkedBlock creates marked block in empty content", () => {
    const result = upsertMarkedBlock("", "hello world");
    expect(result).toContain(LERNSTOFF_MARKER_START);
    expect(result).toContain("hello world");
    expect(result).toContain(LERNSTOFF_MARKER_END);
  });

  it("upsertMarkedBlock preserves existing content outside markers", () => {
    const existing = "# Custom Project Rules\n\nDo not push to main.\n";
    const result = upsertMarkedBlock(existing, "new lernstoff rule");
    expect(result.startsWith("# Custom Project Rules")).toBe(true);
    expect(result).toContain("Do not push to main.");
    expect(result).toContain("new lernstoff rule");
  });

  it("upsertMarkedBlock is idempotent when updated with new text", () => {
    const initial = upsertMarkedBlock("# Header\n", "version 1");
    const updated = upsertMarkedBlock(initial, "version 2");
    expect(updated).not.toContain("version 1");
    expect(updated).toContain("version 2");
    expect(updated.indexOf(LERNSTOFF_MARKER_START)).toBe(
      updated.lastIndexOf(LERNSTOFF_MARKER_START),
    );
  });

  it("removeMarkedBlock cleanly strips marker block and preserves user content", () => {
    const content =
      "# Header\n\n<!-- lernstoff:start -->\nRule body\n<!-- lernstoff:end -->\n\n# Footer\n";
    const cleaned = removeMarkedBlock(content);
    expect(cleaned).not.toContain(LERNSTOFF_MARKER_START);
    expect(cleaned).not.toContain("Rule body");
    expect(cleaned).toContain("# Header");
    expect(cleaned).toContain("# Footer");
  });

  it("removeMarkedBlock leaves content unchanged if markers are absent", () => {
    const content = "# Standard rules\n\nNo markers here.\n";
    expect(removeMarkedBlock(content)).toBe(content);
  });
});

describe("Rule Installer - Project Scope", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "lernstoff-rule-proj-"));
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("installs rule into project AGENTS.md when file does not exist", () => {
    const res = installLernstoffRule({ projectPath: projectDir, global: false });
    const agentsPath = join(projectDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);
    expect(res.updatedFiles).toContain(agentsPath);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain(LERNSTOFF_MARKER_START);
    expect(content).toContain(LERNSTOFF_RULE_SNIPPET);
    expect(content).toContain(LERNSTOFF_MARKER_END);
  });

  it("idempotently updates existing AGENTS.md without duplicating blocks", () => {
    const agentsPath = join(projectDir, "AGENTS.md");
    writeFileSync(agentsPath, "# User System Rules\n\nStrict TDD.\n", "utf-8");

    installLernstoffRule({ projectPath: projectDir, global: false });
    const firstRun = readFileSync(agentsPath, "utf-8");
    expect(firstRun).toContain("# User System Rules");
    expect(firstRun).toContain("Strict TDD.");

    installLernstoffRule({ projectPath: projectDir, global: false });
    const secondRun = readFileSync(agentsPath, "utf-8");
    expect(secondRun).toBe(firstRun);
  });

  it("syncs CLAUDE.md by appending @AGENTS.md if CLAUDE.md exists", () => {
    const claudePath = join(projectDir, "CLAUDE.md");
    writeFileSync(claudePath, "# Anthropic Rules\n", "utf-8");

    const res = installLernstoffRule({ projectPath: projectDir, global: false });
    expect(res.syncedClaudeFiles).toContain(claudePath);

    const claudeContent = readFileSync(claudePath, "utf-8");
    expect(claudeContent).toContain("@AGENTS.md");

    // Second run should be idempotent and not append @AGENTS.md again
    const res2 = installLernstoffRule({ projectPath: projectDir, global: false });
    expect(res2.syncedClaudeFiles).toHaveLength(0);
    const claudeContent2 = readFileSync(claudePath, "utf-8");
    expect(claudeContent2.indexOf("@AGENTS.md")).toBe(claudeContent2.lastIndexOf("@AGENTS.md"));
  });

  it("does not sync CLAUDE.md if syncClaude is false", () => {
    const claudePath = join(projectDir, "CLAUDE.md");
    writeFileSync(claudePath, "# Anthropic Rules\n", "utf-8");

    const res = installLernstoffRule({ projectPath: projectDir, global: false, syncClaude: false });
    expect(res.syncedClaudeFiles).toHaveLength(0);

    const claudeContent = readFileSync(claudePath, "utf-8");
    expect(claudeContent).not.toContain("@AGENTS.md");
  });

  it("removes rule from project AGENTS.md", () => {
    installLernstoffRule({ projectPath: projectDir, global: false });
    const agentsPath = join(projectDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);

    const removeRes = removeLernstoffRule({ projectPath: projectDir, global: false });
    expect(removeRes.updatedFiles).toContain(agentsPath);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).not.toContain(LERNSTOFF_MARKER_START);
    expect(content).not.toContain(LERNSTOFF_RULE_SNIPPET);
  });
});

describe("Rule Installer - Global Scope (Isolated homeDir)", () => {
  let mockHome: string;

  beforeEach(() => {
    mockHome = mkdtempSync(join(tmpdir(), "lernstoff-rule-home-"));
  });

  afterEach(() => {
    if (existsSync(mockHome)) {
      rmSync(mockHome, { recursive: true, force: true });
    }
  });

  it("installs to all global targets when target is 'all'", () => {
    const res = installLernstoffRule({ global: true, homeDir: mockHome, target: "all" });

    const codexFile = join(mockHome, ".codex", "AGENTS.md");
    const claudeFile = join(mockHome, ".claude", "CLAUDE.md");
    const geminiFile = join(mockHome, ".gemini", "GEMINI.md");
    const workbuddyFile = join(mockHome, ".workbuddy", "rules", "lernstoff.md");

    expect(existsSync(codexFile)).toBe(true);
    expect(existsSync(claudeFile)).toBe(true);
    expect(existsSync(geminiFile)).toBe(true);
    expect(existsSync(workbuddyFile)).toBe(true);

    expect(res.updatedFiles).toContain(codexFile);
    expect(res.updatedFiles).toContain(claudeFile);
    expect(res.updatedFiles).toContain(geminiFile);
    expect(res.updatedFiles).toContain(workbuddyFile);

    const geminiText = readFileSync(geminiFile, "utf-8");
    expect(geminiText).toContain(LERNSTOFF_MARKER_START);
    expect(geminiText).toContain("lernstoff_search_memory");
  });

  it("installs only to specific target (e.g. antigravity)", () => {
    const res = installLernstoffRule({ global: true, homeDir: mockHome, target: "antigravity" });

    const geminiFile = join(mockHome, ".gemini", "GEMINI.md");
    const codexFile = join(mockHome, ".codex", "AGENTS.md");

    expect(existsSync(geminiFile)).toBe(true);
    expect(existsSync(codexFile)).toBe(false);
    expect(res.updatedFiles).toEqual([geminiFile]);
  });

  it("removes rule from all global targets", () => {
    installLernstoffRule({ global: true, homeDir: mockHome, target: "all" });

    const codexFile = join(mockHome, ".codex", "AGENTS.md");
    const claudeFile = join(mockHome, ".claude", "CLAUDE.md");
    expect(existsSync(codexFile)).toBe(true);

    const removeRes = removeLernstoffRule({ global: true, homeDir: mockHome, target: "all" });
    expect(removeRes.updatedFiles).toContain(codexFile);
    expect(removeRes.updatedFiles).toContain(claudeFile);

    const codexText = readFileSync(codexFile, "utf-8");
    expect(codexText).not.toContain(LERNSTOFF_MARKER_START);
  });
});
