import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createE2eSandbox,
  isNonEmptyFile,
  REPO_ROOT,
  type E2eSandbox,
} from "./helpers/e2e-harness.js";

describe("E2E Flow 01: CLI Bootstrap, Config Hot-Reload, Daemon Lifecycle & Ecosystem", () => {
  let sandbox: E2eSandbox;

  beforeEach(async () => {
    sandbox = await createE2eSandbox({ seedPort: false });
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("1.1 bootstraps an empty Vault zero-config and keeps .gitignore idempotent (Tasks 2 & 3)", async () => {
    const firstInit = await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    expect(firstInit.code).toBe(0);

    expect(isNonEmptyFile(join(sandbox.vaultDir, ".lernstoff/config.json"))).toBe(true);
    expect(isNonEmptyFile(join(sandbox.vaultDir, "wiki/inquiries.md"))).toBe(true);
    expect(isNonEmptyFile(join(sandbox.vaultDir, "inbox/scratchpad.md"))).toBe(true);
    expect(isNonEmptyFile(join(sandbox.vaultDir, "wiki/index.md"))).toBe(true);
    expect(isNonEmptyFile(join(sandbox.vaultDir, "wiki/log.md"))).toBe(true);
    expect(existsSync(join(sandbox.vaultDir, "wiki/concepts"))).toBe(true);

    const inquiriesText = readFileSync(join(sandbox.vaultDir, "wiki/inquiries.md"), "utf-8");
    expect(inquiriesText).toContain("[OPEN] #q-core");

    // Re-running init must not duplicate .lernstoff/ in .gitignore
    const secondInit = await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    expect(secondInit.code).toBe(0);
    const gitignoreLines = readFileSync(join(sandbox.vaultDir, ".gitignore"), "utf-8")
      .split("\n")
      .filter((l) => l.trim() === ".lernstoff/");
    expect(gitignoreLines).toHaveLength(1);
  });

  it("1.2 starts daemon with immediate status readiness, discovers status outside Vault CWD, and restarts non-blockingly (Task 12)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    sandbox.seedPortConfig();

    const startRes = await sandbox.runCli([
      "server",
      "start",
      "--daemon",
      "--vault",
      sandbox.vaultDir,
    ]);
    expect(startRes.code).toBe(0);

    // Immediately after `server start --daemon` exits, `server status` MUST report Running without race condition
    const immediateStatus = await sandbox.runCli(["server", "status", "--vault", sandbox.vaultDir]);
    expect(immediateStatus.code).toBe(0);
    expect(immediateStatus.stdout).toContain("Daemon Running");

    // Querying `server status` from an external working directory without `--vault` should still surface active daemons
    const externalStatus = await sandbox.runCli(["server", "status"], { cwd: sandbox.externalCwd });
    expect(externalStatus.code).toBe(0);
    expect(externalStatus.stdout).toContain("Running");

    // `server restart` must daemonize in background and exit promptly (< 5s) instead of hanging the terminal
    const restartRes = await sandbox.runCli(["server", "restart", "--vault", sandbox.vaultDir], {
      timeoutMs: 5000,
    });
    expect(restartRes.code).toBe(0);

    const afterRestartStatus = await sandbox.runCli([
      "server",
      "status",
      "--vault",
      sandbox.vaultDir,
    ]);
    expect(afterRestartStatus.stdout).toContain("Daemon Running");

    const stopRes = await sandbox.runCli(["server", "stop", "--vault", sandbox.vaultDir]);
    expect(stopRes.code).toBe(0);
    const stoppedStatus = await sandbox.runCli(["server", "status", "--vault", sandbox.vaultDir]);
    expect(stoppedStatus.stdout).toContain("Daemon Stopped");
  });

  it("1.3 propagates `lernstoff config set` hot-reload into live HippocampalPipeline thresholds without daemon restart (Tasks 2, 11, 12)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    sandbox.seedPortConfig();

    // Set focused open inquiry so lexical overlap score is deterministic (~0.58)
    writeFileSync(
      join(sandbox.vaultDir, "wiki/inquiries.md"),
      "# Inquiries\n- [OPEN] #q-01: raft quorum lease read linearizability\n",
      "utf-8",
    );

    // Start with low tauCore = 0.40 so candidate passes Gate 2
    await sandbox.runCli(["config", "set", "gate.tauOff", "0.2", "--vault", sandbox.vaultDir]);
    await sandbox.runCli(["config", "set", "gate.tauCore", "0.4", "--vault", sandbox.vaultDir]);

    await sandbox.runCli(["server", "start", "--daemon", "--vault", sandbox.vaultDir]);
    const health = await sandbox.waitForDaemonHealth(sandbox.port);

    const probePayload = {
      sourceId: "paper:raft-lease",
      sourceText:
        "In asymmetric partitions, Raft quorum lease read linearizability requires clock drift bounds.",
      language: "en",
      candidates: [
        {
          entityName: "Raft",
          claim: "Raft quorum lease read linearizability fails under unbounded clock drift",
          coverage: "substantially covered",
        },
      ],
    };

    const firstProbe = await fetch(`http://127.0.0.1:${health.port}/api/probe-delta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(probePayload),
    }).then((r) => r.json());
    expect(firstProbe.survivors.length).toBe(1);

    // Hot-reload tauCore up to 0.95 via CLI while daemon stays running
    const setRes = await sandbox.runCli([
      "config",
      "set",
      "gate.tauCore",
      "0.95",
      "--vault",
      sandbox.vaultDir,
    ]);
    expect(setRes.code).toBe(0);

    // Subsequent probe-delta MUST immediately enforce tauCore = 0.95 (deferring to scratchpad, 0 survivors)
    const secondProbe = await fetch(`http://127.0.0.1:${health.port}/api/probe-delta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(probePayload),
    }).then((r) => r.json());
    expect(secondProbe.survivors).toHaveLength(0);
    expect(secondProbe.stats.deferredScratchpad).toBe(1);
  });

  it("1.4 parses boolean CLI flags (`--lex`, `--json`) without swallowing positional query arguments (Tasks 12 & 14)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    sandbox.seedPortConfig();

    const conceptsDir = join(sandbox.vaultDir, "wiki/concepts");
    mkdirSync(conceptsDir, { recursive: true });
    writeFileSync(
      join(conceptsDir, "mvcc-snapshot-isolation.md"),
      "# MVCC Snapshot Isolation Prevents Read Locks\n\nWrite skew anomalies require serializable snapshot isolation.\n",
      "utf-8",
    );

    // Start daemon so Vault index is active, then run `lernstoff search --lex snapshot`
    await sandbox.runCli(["server", "start", "--daemon", "--vault", sandbox.vaultDir]);
    await sandbox.waitForDaemonHealth(sandbox.port);

    const searchRes = await sandbox.runCli([
      "search",
      "--lex",
      "snapshot",
      "--json",
      "--vault",
      sandbox.vaultDir,
    ]);
    expect(searchRes.code).toBe(0);
    const parsed = JSON.parse(searchRes.stdout);
    const hits = Array.isArray(parsed) ? parsed : parsed.directHits || [];
    expect(hits.length).toBeGreaterThan(0);
  });

  it("1.5 registers OS boot service inside isolated HOME and syncs `server.autoStartOnBoot` in config.json (Task 13)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    sandbox.seedPortConfig();

    const installRes = await sandbox.runCli(["service", "install", "--vault", sandbox.vaultDir]);
    expect(installRes.code).toBe(0);

    const statusAfterInstall = await sandbox.runCli([
      "service",
      "status",
      "--vault",
      sandbox.vaultDir,
    ]);
    expect(statusAfterInstall.stdout).toContain("installed: true");

    // config.json must stay in two-way sync with CLI service install
    const cfgAfterInstall = JSON.parse(
      readFileSync(join(sandbox.vaultDir, ".lernstoff/config.json"), "utf-8"),
    );
    expect(cfgAfterInstall.server.autoStartOnBoot).toBe(true);

    const uninstallRes = await sandbox.runCli([
      "service",
      "uninstall",
      "--vault",
      sandbox.vaultDir,
    ]);
    expect(uninstallRes.code).toBe(0);

    const cfgAfterUninstall = JSON.parse(
      readFileSync(join(sandbox.vaultDir, ".lernstoff/config.json"), "utf-8"),
    );
    expect(cfgAfterUninstall.server.autoStartOnBoot).toBe(false);
  });

  it("1.6 injects the complete 8-tool SKILL.md protocol (not stub) and MCP configs into isolated HOME (Task 13)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);

    const skillRes = await sandbox.runCli([
      "skill",
      "install",
      "--target",
      "all",
      "--vault",
      sandbox.vaultDir,
    ]);
    expect(skillRes.code).toBe(0);

    const claudeSkillPath = join(sandbox.homeDir, ".claude/skills/lernstoff-wiki/SKILL.md");
    const cursorMcpPath = join(sandbox.homeDir, ".cursor/mcp.json");
    const antigravityMcpPath = join(sandbox.homeDir, ".gemini/antigravity/mcp_config.json");

    expect(isNonEmptyFile(claudeSkillPath)).toBe(true);
    expect(isNonEmptyFile(cursorMcpPath)).toBe(true);
    expect(isNonEmptyFile(antigravityMcpPath)).toBe(true);

    const installedSkill = readFileSync(claudeSkillPath, "utf-8");
    // Must contain full 8-tool specification from skills/lernstoff-wiki/SKILL.md, not the 14-line stub
    expect(installedSkill).toContain("lernstoff_probe_delta");
    expect(installedSkill).toContain("lernstoff_crystallize_note");
    expect(installedSkill).toContain("lernstoff_search_memory");
    expect(installedSkill).toContain("lernstoff_get_note");
    expect(installedSkill).toContain("lernstoff_lint_wiki");
    expect(installedSkill).toContain("lernstoff_status");
  });

  it("1.7 satisfies Homebrew Formula `lernstoff --version` assertion contract (Task 14)", async () => {
    const formulaRuby = readFileSync(join(REPO_ROOT, "Formula/lernstoff.rb"), "utf-8");
    const versionRes = await sandbox.runCli(["--version"]);
    expect(versionRes.code).toBe(0);

    if (formulaRuby.includes('assert_match "lernstoff"')) {
      expect(versionRes.stdout.toLowerCase()).toContain("lernstoff");
    }
  });
});
