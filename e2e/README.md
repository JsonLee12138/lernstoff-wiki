# End-to-End (E2E) Test Suite & Full-Flow Specification (`lernstoff-wiki`)

This directory houses the **zero-mock, full-lifecycle End-to-End acceptance test suite** for `lernstoff-wiki` (`@lernstoff/core` + `@lernstoff/cli` + `@lernstoff/obsidian-plugin`).

Unlike package-level unit tests (`packages/*/tests/*.test.ts`), which mock `QmdBridge`, `fetch`, or local HTTP servers in isolation, every scenario in `e2e/` exercises **real built binaries, real SQLite FTS5/`@tobilu/qmd` stores, real background HTTP/SSE Daemons, real newline-delimited MCP Stdio JSON-RPC streams, and real disk side effects**.

---

## 1. Sandbox & Host-Safety Architecture (`e2e/helpers/e2e-harness.ts`)

Every E2E test runs inside an ephemeral `createE2eSandbox()` context with four strict isolation guarantees:

1. **Zero Port Collision (`allocateFreePort`)**: Dynamically binds port `0` on `127.0.0.1` to obtain an unused OS ephemeral port and seeds `<vaultDir>/.lernstoff/config.json` before spawning a daemon, so E2E runs **never** collide with a user's live Vault daemon on `127.0.0.1:8188`.
2. **Strict `$HOME` Containment**: Overrides `HOME`, `USERPROFILE`, and `XDG_CONFIG_HOME` to `<sandbox>/home`, preventing `lernstoff skill install` or `lernstoff service install` from ever touching the developer's real `~/.claude`, `~/.cursor`, `~/.gemini`, or `~/Library/LaunchAgents`.
3. **OS Service Shim Guard (`launchctl` / `systemctl`)**: Injects lightweight command shims at the head of `PATH` (`<sandbox>/home/.local/bin`) so OS boot auto-start tests verify generated `.plist` / `.service` artifacts without loading background jobs into the host OS `launchd` / `systemd` session.
4. **Scoped Process Teardown**: `sandbox.cleanup()` inspects `<vaultDir>/.lernstoff/daemon.pid` and verifies `ps -p <pid> -o command=` explicitly contains the unique `<vaultDir>` path before sending `SIGTERM`/`SIGKILL`, guaranteeing zero orphan test daemons and zero interference with external processes.

---

## 2. Full-Flow E2E Coverage Matrix

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Suite 01: CLI Bootstrap, Config Hot-Reload, Daemon Lifecycle & Ecosystem   │
│  1.1 lernstoff init        -> .lernstoff/config.json + starter MD + gitign │
│  1.2 server start/status   -> 0ms readiness, external CWD status, restart  │
│  1.3 config set hot-reload -> live /api/probe-delta threshold propagation  │
│  1.4 search --lex --json   -> boolean flag parsing + FTS5 recall           │
│  1.5 service install/uninst-> plist/unit creation + config.json two-way    │
│  1.6 skill install --all   -> full 8-tool SKILL.md + Claude/Cursor/AGY MCP │
│  1.7 Formula --version     -> Homebrew `test do` assertion contract        │
├────────────────────────────────────────────────────────────────────────────┤
│ Suite 02: 4-Step Cognitive Selective Note-Taking Loop over MCP Stdio       │
│  2.1 Mode A Proxy (/mcp)   -> pure JSON-RPC on stdout (no raw SSE leak)    │
│  2.2 Mode B 8-Tool + Tree  -> tools/list, lernstoff://, inquiry CRUD       │
│  2.3 Gate 1 Edge Cases     -> repeated entity lastIndex + CJK language:auto│
│  2.4 Socratic + Crystallize-> noun-phrase block, >=2 links, AMEND history, │
│                               wiki/index.md sync, search_memory, traversal │
│  2.5 Scratchpad + Lint     -> promote persistence, GC reference check,     │
│                               cluster-scoped contradiction lint, status %  │
├────────────────────────────────────────────────────────────────────────────┤
│ Suite 03: Obsidian Plugin Cockpit & Bidirectional CLI Sync                 │
│  3.1 Fresh Vault onload()  -> starter file bootstrap + open-inquiry-tree   │
│  3.2 External CLI stop     -> SSE disconnect -> Status Bar & Settings sync │
│  3.3 Module 1 OS Boot UI   -> toggle writes real LaunchAgent/systemd file  │
│  3.4 Module 2 Agent UI     -> Claude/Cursor/Antigravity buttons write disk │
│  3.5 Module 3 & 4 Controls -> Update Index/Cleanup + singleton-safe Reset  │
│  3.6 Editor Defer Command  -> defer-selection writes inbox/scratchpad.md   │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Running the E2E Suite

Always build workspace bundles first so `packages/cli/dist/bin.mjs` reflects the latest workspace code:

```bash
pnpm build
pnpm test:e2e
```

To run a single E2E flow file during TDD bug-fixing:

```bash
pnpm exec vp test e2e/03-obsidian-plugin-cockpit.e2e.test.ts --no-file-parallelism --testTimeout 30000 --run
```
