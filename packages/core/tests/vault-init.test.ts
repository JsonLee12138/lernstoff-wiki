import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault, isVaultInitialized, initGitignore } from "../src/vault-init.js";

describe("Vault Auto-Initializer (vault-init)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-init-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("bootstraps an empty directory into a complete Vault structure", async () => {
    expect(isVaultInitialized(tempDir)).toBe(false);

    const result = await initVault(tempDir);
    expect(isVaultInitialized(tempDir)).toBe(true);

    expect(result.createdFiles.length).toBeGreaterThanOrEqual(5);
    expect(existsSync(join(tempDir, ".lernstoff/config.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki/inquiries.md"))).toBe(true);
    expect(existsSync(join(tempDir, "inbox/scratchpad.md"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki/index.md"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki/log.md"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki/concepts"))).toBe(true);

    const inquiries = readFileSync(join(tempDir, "wiki/inquiries.md"), "utf-8");
    expect(inquiries).toContain("[OPEN] #q-core");

    const gitignore = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".lernstoff/");
  });

  it("preserves pre-existing user files unless force is specified", async () => {
    // User already wrote their own inquiries
    const wikiDir = join(tempDir, "wiki");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(
      join(wikiDir, "inquiries.md"),
      "# Custom Inquiry\n- [OPEN] #q-user: Custom?",
      "utf-8",
    );

    const result = await initVault(tempDir);
    expect(result.skippedFiles).toContain(join(wikiDir, "inquiries.md"));

    const content = readFileSync(join(wikiDir, "inquiries.md"), "utf-8");
    expect(content).toContain("#q-user");
    expect(content).not.toContain("#q-core");
  });

  it("idempotently updates .gitignore without duplicate entries", () => {
    initGitignore(tempDir);
    initGitignore(tempDir);
    const content = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    const occurrences = (content.match(/\.lernstoff\//g) || []).length;
    expect(occurrences).toBe(1);
  });
});
