# Implementation Plan: Daemon Auto-Start Handover & Single-Instance Port Guard

## Slices Overview

- [x] **Slice 1: Core Same-Vault Collision Blocker**
  - **Status:** Completed
  - **Target Files:**
    - `packages/core/src/daemon-server.ts`
    - `packages/core/tests/daemon-server.test.ts`
  - **Tasks:**
    - Implement same-vault `/health` detection helper on `EADDRINUSE`.
    - If occupied by the same canonical vault, throw immediately instead of incrementing port and mutating config.
    - Write unit test validating that starting a second `DaemonServer` on the same vault throws on port conflict rather than advancing port.

- [x] **Slice 2: CLI Supervision Handover & Foreground Single-Instance Guard**
  - **Status:** Completed
  - **Target Files:**
    - `packages/cli/src/service-manager.ts`
    - `packages/cli/src/bin.ts`
    - `packages/cli/tests/cli.test.ts`
  - **Tasks:**
    - In `ServiceManager.installService(vaultPath)`, detect existing running daemon and gracefully kill it before calling `launchctl load` or `systemctl enable --now`.
    - In `bin.ts` `server start` (foreground mode), add `getRunningDaemonInfo(vaultPath)` guard to prevent running duplicate instances.
    - Write unit test verifying that `ServiceManager.installService` stops existing daemon and preserves configured port.

- [x] **Slice 3: Plugin Secure Detection & Idempotent Start**
  - **Status:** Completed
  - **Target Files:**
    - `packages/obsidian-plugin/src/daemon-client.ts`
    - `packages/obsidian-plugin/tests/plugin.test.ts`
  - **Tasks:**
    - Update `checkDaemon()` to probe `this.config.server.port` as fallback when state files are missing, enforcing strict canonical vault matching.
    - Add self-healing of state files (`daemon.port`, `daemon.pid`) when daemon is detected on configured port.
    - Add idempotent guard in `startDaemon()` so active running daemons are not redundantly spawned.
    - Write unit tests for fallback detection, cross-vault rejection, and idempotent start.

- [x] **Slice 4: Full End-to-End Gate Verification**
  - **Status:** Completed
  - **Tasks:**
    - Run `pnpm build` and `scripts/sync-plugin-assets.mjs`.
    - Run `pnpm test`.
    - Run `bash scripts/gate-check.sh` and ensure all 4 gates pass.
