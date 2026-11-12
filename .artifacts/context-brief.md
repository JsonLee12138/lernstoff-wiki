# Context Brief: Daemon Auto-Start Handover & Single-Instance Port Guard

> Target: Resolve port conflict during autostart toggle, prevent multi-port proliferation per vault, and enforce secure plugin-side detection.

## 1. Affected Subsystems & Source Files

1. **`packages/core/src/daemon-server.ts`**
   - Lines 95-128: `DaemonServer.start()` port binding loop. Currently increments port blindly on `EADDRINUSE` (`desiredPort..desiredPort+100`) and writes mutated port back to `config.json`.
   - Lines 224-241: `/health` endpoint. Already returns `{ status: "ok", port, requestedPort, pid, vault, version }`.

2. **`packages/cli/src/service-manager.ts`**
   - Lines 118-165: `ServiceManager.installService()`. Generates launchd plist (`RunAtLoad=true`, `KeepAlive=true`) or systemd unit (`enable --now`). Blindly loads OS service while an unmanaged daemon process may already be running, causing port collision and port drift.
   - Lines 167-202: `ServiceManager.stopSupervision()`. Pauses launchd/systemd supervision.
   - Lines 207-242: `ServiceManager.uninstallService()`.

3. **`packages/cli/src/bin.ts`**
   - Lines 155-220: `server start --daemon`. Checks `getRunningDaemonInfo(vaultPath)`.
   - Lines 220-240: `server start` (foreground). **Omits** `getRunningDaemonInfo(vaultPath)` check, blindly instantiating `DaemonServer` and starting a duplicate daemon on a newly incremented port.
   - Lines 375-385: `service install` subcommand.

4. **`packages/obsidian-plugin/src/daemon-client.ts`**
   - Lines 270-350: `checkDaemon()`. Relies solely on existence of `.lernstoff/daemon.port`. If file is missing or unreadable, immediately returns `false` without probing `this.config.server.port`.
   - Lines 533-575: `startDaemon()`. Directly spawns CLI process without pre-checking whether a daemon is already active on the configured port.
   - Lines 759-832: `installService()`. Calls CLI `service install` without orchestrating handover.

5. **`packages/obsidian-plugin/src/settings-tab.ts`**
   - Lines 47-56: Displays `⚠️ Port conflict: Port ... was busy` banner when `lastPortFallback` is set.
   - Lines 192-207: "OS Boot Auto-Start" toggle.

## 2. Test Suites

- `packages/core/tests/daemon-server.test.ts`
- `packages/cli/tests/cli.test.ts`
- `packages/obsidian-plugin/tests/plugin.test.ts`
- `packages/obsidian-plugin/tests/settings-tab.test.ts`
