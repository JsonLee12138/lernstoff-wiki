# Specification: Daemon Auto-Start Handover & Single-Instance Port Guard

## 1. Problem Statement & Background

When a user enables OS Boot Auto-Start in Obsidian settings (`packages/obsidian-plugin/src/settings-tab.ts:L199`), `ServiceManager.installService()` registers a launchd plist (macOS) or systemd unit (Linux) with immediate activation (`RunAtLoad=true` / `systemctl enable --now`).
Because an existing daemon process is already running on the configured port (e.g. 8188):

1. The new OS-supervised process executes `server start --foreground --vault <path>`, which lacks single-instance detection.
2. `DaemonServer.start()` encounters `EADDRINUSE` on port 8188 and blindly auto-increments to port 8189, overwriting `.lernstoff/config.json` and `.lernstoff/daemon.port`.
3. Multiple daemon instances run simultaneously on different ports for the same vault, competing for file system watchers and database handles.
4. The Obsidian plugin observes port 8189 != 8188 and displays a port conflict banner.
5. In addition, the plugin's `checkDaemon()` relies strictly on `.lernstoff/daemon.port`, missing daemons running on the configured port when the file is absent, and `startDaemon()` lacks an idempotent pre-flight check.

## 2. Requirements & Desired Behavior

### R1. Smooth Supervision Handover (`ServiceManager.installService`)

- When `ServiceManager.installService(vaultPath)` is invoked:
  - Check `getRunningDaemonInfo(vaultPath)`.
  - If a running daemon exists, gracefully stop it (`killDaemonProcess(pid, 3000)`) before loading the OS service file.
  - Wait briefly for the port to be completely freed.
  - Then load the OS service (`launchctl load` / `systemctl enable --now`).
  - Result: The OS-supervised process starts cleanly on the original configured port without port collision or config mutation.

### R2. Foreground Mode Single-Instance Guard (`bin.ts`)

- In `server start` (foreground mode without `--daemon`):
  - Check `getRunningDaemonInfo(vaultPath)`.
  - If a daemon is already alive for this vault (and its PID is not the current process):
    - Abort startup with an explicit message: `Daemon is already running on http://127.0.0.1:${existing.port} (PID ${existing.pid})`.
    - Exit cleanly with code 0 (or allow `--replace` / supervisor takeover if explicitly requested).

### R3. Same-Vault Port Collision Blocker (`DaemonServer.start`)

- When `DaemonServer.start()` encounters `EADDRINUSE` while trying to bind port `p`:
  - Before incrementing `p`, probe `http://127.0.0.1:${p}/health` with a 1000ms timeout.
  - If the endpoint responds with `{ status: "ok", vault: ... }` and `resolve(data.vault) === resolve(this.vaultPath)`:
    - This is a duplicate daemon instance for the **exact same vault**.
    - Immediately reject and throw an Error: `Lernstoff daemon for vault "${this.vaultPath}" is already running on port ${p}`.
    - Do NOT increment port and do NOT mutate `config.json`.
  - If the endpoint is not a Lernstoff daemon, or belongs to a different vault:
    - Proceed with port auto-increment as fallback for genuine third-party port collisions.

### R4. Plugin Secure Two-Stage Health Detection (`DaemonClient.checkDaemon`)

- When `checkDaemon()` executes:
  - Stage 1 (Fast Path): If `.lernstoff/daemon.port` and `daemon.pid` exist, check if PID is alive and verify `/health` on that port.
  - Stage 2 (Configured Port Fallback Probe): If Stage 1 fails or files are missing, probe `http://127.0.0.1:${this.config.server.port}/health`.
    - If healthy and `resolve(data.vault) === resolve(this.vaultPath)`:
      - Set `this.isRunning = true`, `this.port = this.config.server.port`, `this.pid = data.pid`.
      - Self-heal missing `.lernstoff/daemon.port` and `daemon.pid` files.
      - Connect SSE if not connected, and return `true`.
  - Security Boundary: If `/health` responds but `resolve(data.vault) !== resolve(this.vaultPath)`, reject connection and do not mark running.

### R5. Plugin Idempotent `startDaemon()` Guard

- In `DaemonClient.startDaemon()`:
  - Execute a pre-flight `await this.checkDaemon({ skipMetrics: true })`.
  - If daemon is already running on `this.config.server.port`, skip spawning a new process and immediately return `true`.

## 3. Non-Goals

- Changing the underlying CLI architecture or replacing launchd/systemd.
- Supporting multi-tenant single-daemon serving multiple vaults.
