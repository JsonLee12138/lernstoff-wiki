import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

const rootDir = resolve(__dirname, "../../..");
const skillDir = join(rootDir, "skills/lernstoff-wiki");
const assetsSkillDir = join(rootDir, "packages/cli/assets/skills/lernstoff-wiki");

describe("Slice 1: Progressive Skill Refactor & Asset Sync", () => {
  it("has concise SKILL.md under 90 lines with rich engineering triggers and guardrails", () => {
    const skillPath = join(skillDir, "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const content = readFileSync(skillPath, "utf-8");
    const lines = content.split("\n");

    // Less than 90 lines requirement
    expect(lines.length).toBeLessThan(90);

    // Frontmatter triggers
    expect(content).toMatch(/name:\s*lernstoff-wiki/);
    expect(content).toMatch(/description:/);
    expect(content).toMatch(/codebase/i);
    expect(content).toMatch(/architecture/i);
    expect(content).toMatch(/postmortem/i);
    expect(content).toMatch(/Obsidian/i);

    // Decision tree workflows
    expect(content).toMatch(/Research & Crystallize/i);
    expect(content).toMatch(/Vault Health & Synthesize/i);
    expect(content).toMatch(/Scratchpad & Consolidate/i);

    // Anti-patterns and guardrails
    expect(content).toMatch(/lernstoff_probe_delta/);
    expect(content).toMatch(/typed links/i);
    expect(content).toMatch(/proposition/i);

    // Progressive disclosure reference links
    expect(content).toContain("references/mcp-tools.md");
    expect(content).toContain("references/best-practices.md");
  });

  it("provides detailed references/mcp-tools.md with 8 tools and 1 resource", () => {
    const toolsRefPath = join(skillDir, "references/mcp-tools.md");
    expect(existsSync(toolsRefPath)).toBe(true);
    const content = readFileSync(toolsRefPath, "utf-8");

    const tools = [
      "lernstoff_probe_delta",
      "lernstoff_crystallize_note",
      "lernstoff_manage_inquiries",
      "lernstoff_consolidate_scratchpad",
      "lernstoff_lint_wiki",
      "lernstoff_search_memory",
      "lernstoff_get_note",
      "lernstoff_status",
    ];

    for (const tool of tools) {
      expect(content).toContain(tool);
    }
    expect(content).toContain("lernstoff://{+path}");
  });

  it("provides references/best-practices.md with proposition titles, Socratic defense, and promotion flow", () => {
    const bpPath = join(skillDir, "references/best-practices.md");
    expect(existsSync(bpPath)).toBe(true);
    const content = readFileSync(bpPath, "utf-8");

    expect(content).toMatch(/proposition title/i);
    expect(content).toMatch(/Socratic/i);
    expect(content).toMatch(/scratchpad/i);
    expect(content).toMatch(/SYNTHESIZE_CLUSTER/);
  });

  it("syncs skills/lernstoff-wiki into packages/cli/assets/skills/lernstoff-wiki via sync-plugin-assets.mjs", () => {
    execSync(`node ${join(rootDir, "scripts/sync-plugin-assets.mjs")}`, {
      cwd: rootDir,
      stdio: "pipe",
    });

    expect(existsSync(join(assetsSkillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(assetsSkillDir, "references/mcp-tools.md"))).toBe(true);
    expect(existsSync(join(assetsSkillDir, "references/best-practices.md"))).toBe(true);

    const assetSkillContent = readFileSync(join(assetsSkillDir, "SKILL.md"), "utf-8");
    const srcSkillContent = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(assetSkillContent).toBe(srcSkillContent);

    const setupAssetDir = join(rootDir, "packages/cli/assets/skills/lernstoff-setup");
    expect(existsSync(join(setupAssetDir, "SKILL.md"))).toBe(true);
    const setupSrcDir = join(rootDir, "skills/lernstoff-setup");
    expect(readFileSync(join(setupAssetDir, "SKILL.md"), "utf-8")).toBe(
      readFileSync(join(setupSrcDir, "SKILL.md"), "utf-8"),
    );
  });
});
