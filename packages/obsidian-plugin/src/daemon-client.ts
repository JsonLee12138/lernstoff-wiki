import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync, spawn } from "node:child_process";
import { request as httpRequest, type ClientRequest } from "node:http";
import { homedir } from "node:os";
import {
  type LernstoffConfig,
  loadConfig,
  saveConfig,
  DEFAULT_LERNSTOFF_CONFIG,
  LERNSTOFF_DIR,
} from "@lernstoff/core/config";
import { initVault } from "@lernstoff/core/vault-init";

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function isSafeDaemonPid(pid: number, vaultPath: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (process.platform === "win32") return true;
  try {
    const cmd = execSync(`ps -p ${pid} -o command=`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 800,
    })
      .toString("utf-8")
      .trim();
    if (!cmd) return false;
    const lower = cmd.toLowerCase();
    return (
      cmd.includes(vaultPath) ||
      lower.includes("daemon-server") ||
      (lower.includes("lernstoff") && lower.includes("server"))
    );
  } catch {
    return false;
  }
}

function parseNodeSemver(versionDir: string): [number, number, number] | null {
  const m = versionDir.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m || !m[1]) return null;
  const major = parseInt(m[1], 10);
  const minor = m[2] ? parseInt(m[2], 10) : 0;
  const patch = m[3] ? parseInt(m[3], 10) : 0;
  if (Number.isNaN(major)) return null;
  return [major, minor, patch];
}

function getSortedNvmBinDirs(home: string): string[] {
  const nvmDir = join(home, ".nvm/versions/node");
  if (!existsSync(nvmDir)) return [];
  try {
    return readdirSync(nvmDir)
      .map((name) => ({ name, ver: parseNodeSemver(name) }))
      .filter((entry): entry is { name: string; ver: [number, number, number] } => {
        return entry.ver !== null && entry.ver[0] >= 20;
      })
      .sort((a, b) => {
        if (b.ver[0] !== a.ver[0]) return b.ver[0] - a.ver[0];
        if (b.ver[1] !== a.ver[1]) return b.ver[1] - a.ver[1];
        return b.ver[2] - a.ver[2];
      })
      .map((entry) => join(nvmDir, entry.name, "bin"));
  } catch {
    return [];
  }
}

function localHttpJson<T = any>(options: {
  port: number;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; data?: T }> {
  return new Promise((resolveRes, rejectRes) => {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        agent: false,
        headers: {
          Connection: "close",
          ...(payload !== undefined
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          if (!ok) {
            resolveRes({ ok: false, status });
            return;
          }
          try {
            resolveRes({ ok: true, status, data: raw ? JSON.parse(raw) : undefined });
          } catch {
            resolveRes({ ok: true, status });
          }
        });
      },
    );

    req.setTimeout(options.timeoutMs ?? 1000, () => {
      req.destroy(new Error("Request timeout"));
    });
    req.on("error", (err) => {
      rejectRes(err);
    });

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

export interface DaemonMetrics {
  conceptNotes: number;
  totalInquiries: number;
  openInquiries: number;
  scratchpadTotal: number;
  scratchpadPromotionsReady: number;
  noiseFilteredRatio?: number;
}

export interface ActionResult {
  success: boolean;
  error?: string;
}

export type StatusListener = (status: {
  running: boolean;
  port: number;
  pid?: number;
  metrics?: DaemonMetrics;
}) => void;

export class DaemonClient {
  public vaultPath: string;
  public config: LernstoffConfig;
  public port = 8188;
  public pid?: number;
  public isRunning = false;
  public metrics?: DaemonMetrics;
  public cliPathOverride?: string;
  public lastPortFallback?: { requestedPort: number; actualPort: number };

  private statusListeners: Set<StatusListener> = new Set();
  private sseAbortController?: AbortController;
  private ssePort?: number;
  private isDestroyed = false;
  private pollTimer?: NodeJS.Timeout;

  constructor(vaultPath: string) {
    this.vaultPath = resolve(vaultPath);
    this.config = structuredClone(DEFAULT_LERNSTOFF_CONFIG);
    this.port = this.config.server.port;
  }

  public onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private notify(): void {
    const payload = {
      running: this.isRunning,
      port: this.port,
      pid: this.pid,
      metrics: this.metrics,
    };
    for (const listener of this.statusListeners) {
      try {
        listener(payload);
      } catch {}
    }
  }

  public async init(): Promise<void> {
    this.loadLocalConfig();
    await this.ensureStarterTemplates();
    await this.checkDaemon();

    if (!this.isRunning && this.config.server.autoStartOnObsidianOpen) {
      await this.startDaemon();
    }

    if (this.isRunning) {
      this.connectSse();
    }

    this.startHealthPolling();
  }

  public async ensureStarterTemplates(): Promise<void> {
    try {
      const inqFile = join(this.vaultPath, this.config.paths.inquiriesFile);
      const scratchFile = join(this.vaultPath, this.config.paths.scratchpadFile);
      const idxFile = join(this.vaultPath, this.config.paths.indexFile);
      const logFile = join(this.vaultPath, this.config.paths.logFile);

      if (
        !existsSync(inqFile) ||
        !existsSync(scratchFile) ||
        !existsSync(idxFile) ||
        !existsSync(logFile)
      ) {
        await initVault(this.vaultPath);
      }
    } catch (err) {
      console.warn("[Lernstoff] Failed to bootstrap starter templates:", err);
    }
  }

  public loadLocalConfig(): LernstoffConfig {
    this.config = loadConfig(this.vaultPath);
    if (!this.isRunning) {
      this.port = this.config.server.port;
    }
    return this.config;
  }

  public updateConfig(newConfig: LernstoffConfig): void {
    saveConfig(this.vaultPath, newConfig);
    this.config = newConfig;
    if (!this.isRunning) {
      this.port = this.config.server.port;
    } else {
      localHttpJson({
        port: this.port,
        path: "/api/reload-config",
        method: "POST",
        timeoutMs: 800,
      }).catch(() => {});
    }
    this.notify();
  }

  public async checkDaemon(options?: { skipMetrics?: boolean }): Promise<boolean> {
    const portFile = join(this.vaultPath, LERNSTOFF_DIR, "daemon.port");
    const pidFile = join(this.vaultPath, LERNSTOFF_DIR, "daemon.pid");
    const configuredPort = this.config.server.port;

    let currentPid: number | undefined;
    if (existsSync(pidFile)) {
      try {
        const parsedPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (Number.isInteger(parsedPid) && parsedPid > 0) {
          if (!isPidAlive(parsedPid)) {
            try {
              unlinkSync(pidFile);
            } catch {}
            try {
              if (existsSync(portFile)) unlinkSync(portFile);
            } catch {}
          } else {
            currentPid = parsedPid;
          }
        }
      } catch {}
    }

    let candidatePort: number | undefined;
    if (existsSync(portFile)) {
      try {
        const parsed = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
        if (parsed && !isNaN(parsed)) {
          candidatePort = parsed;
        }
      } catch {}
    }

    const portsToProbe: number[] = [];
    if (candidatePort) portsToProbe.push(candidatePort);
    if (!portsToProbe.includes(configuredPort)) portsToProbe.push(configuredPort);

    for (const p of portsToProbe) {
      try {
        const res = await localHttpJson<any>({ port: p, path: "/health", timeoutMs: 1200 });
        if (res.ok && res.data && res.data.status === "ok") {
          const data = res.data;
          // Security: canonical vault path check (must provide valid vault matching this.vaultPath)
          if (!data.vault || resolve(String(data.vault)) !== resolve(this.vaultPath)) {
            continue; // belongs to another vault or lacks canonical vault identity, skip
          }

          const wasRunning = this.isRunning;
          this.isRunning = true;
          this.port = data.port || p;
          this.pid = data.pid || currentPid;

          // Self-heal state files if daemon was started outside plugin or files were missing
          try {
            const dir = dirname(portFile);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            if (!existsSync(portFile) || candidatePort !== this.port) {
              writeFileSync(portFile, String(this.port), "utf-8");
            }
            if (this.pid && (!existsSync(pidFile) || currentPid !== this.pid)) {
              writeFileSync(pidFile, String(this.pid), "utf-8");
            }
          } catch {}

          if (this.port === configuredPort) {
            this.lastPortFallback = undefined;
          } else if (
            !wasRunning &&
            typeof data.requestedPort === "number" &&
            data.requestedPort !== this.port
          ) {
            this.lastPortFallback = {
              requestedPort: data.requestedPort,
              actualPort: this.port,
            };
          }

          if (options?.skipMetrics) {
            void this.fetchMetrics().then(() => {
              if (!this.isDestroyed && this.isRunning) {
                this.notify();
              }
            });
          } else {
            await this.fetchMetrics();
          }
          if (!wasRunning) {
            this.connectSse();
          }
          this.notify();
          return true;
        }
      } catch {
        // probe failed for port p, continue
      }
    }

    if (currentPid !== undefined && !isPidAlive(currentPid)) {
      try {
        if (existsSync(pidFile)) unlinkSync(pidFile);
      } catch {}
      try {
        if (existsSync(portFile)) unlinkSync(portFile);
      } catch {}
    }

    const changed = this.isRunning !== false;
    this.isRunning = false;
    this.pid = undefined;
    this.port = configuredPort;
    if (changed) {
      this.notify();
    }
    return false;
  }

  public async fetchMetrics(): Promise<DaemonMetrics | null> {
    if (!this.isRunning) return null;
    try {
      const res = await localHttpJson<any>({
        port: this.port,
        path: "/api/status",
        timeoutMs: 1000,
      });
      if (res.ok && res.data) {
        this.metrics = res.data.metrics;
        return this.metrics || null;
      }
    } catch {}
    return null;
  }

  public startHealthPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (this.isDestroyed) return;
      await this.checkDaemon();
    }, 1000);
  }

  public stopHealthPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  public getSpawnEnv(cmdHint?: string): NodeJS.ProcessEnv {
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    const nvmBins = getSortedNvmBinDirs(home);
    const priorityPaths: string[] = [];
    if (cmdHint) {
      const cmdDir = dirname(cmdHint);
      if (cmdDir && cmdDir !== ".") {
        priorityPaths.push(cmdDir);
      }
    }

    const currentPath = process.env.PATH || "";
    const currentParts = currentPath ? currentPath.split(":") : [];
    const extraPaths: string[] = [
      join(home, ".local/bin"),
      ...nvmBins,
      join(home, ".npm-global/bin"),
      join(home, ".pnpm"),
      join(home, ".local/share/mise/shims"),
      join(home, ".local/share/fnm/current/bin"),
      join(home, ".fnm/current/bin"),
      join(home, ".volta/bin"),
      join(home, ".asdf/shims"),
      "/opt/homebrew/opt/node@22/bin",
      "/opt/homebrew/opt/node/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];

    const uniquePaths = Array.from(
      new Set([...priorityPaths, ...currentParts, ...extraPaths].filter(Boolean)),
    );

    return {
      ...process.env,
      PATH: uniquePaths.join(":"),
    };
  }

  public resolveCommand(): { cmd: string; baseArgs: string[] } {
    if (this.cliPathOverride) {
      return { cmd: this.cliPathOverride, baseArgs: [] };
    }

    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    const nvmCandidates = getSortedNvmBinDirs(home).map((binDir) => join(binDir, "lernstoff"));
    const candidates = [
      join(home, ".local/bin/lernstoff"),
      ...nvmCandidates,
      join(home, ".npm-global/bin/lernstoff"),
      join(home, ".local/share/mise/shims/lernstoff"),
      join(home, ".volta/bin/lernstoff"),
      join(home, ".asdf/shims/lernstoff"),
      join(home, ".pnpm/lernstoff"),
      "/opt/homebrew/bin/lernstoff",
      "/usr/local/bin/lernstoff",
    ];

    for (const c of candidates) {
      if (existsSync(c)) {
        return { cmd: c, baseArgs: [] };
      }
    }

    const currentPath = process.env.PATH || "";
    for (const dir of currentPath.split(":")) {
      if (dir) {
        const p = join(dir, "lernstoff");
        if (existsSync(p)) {
          return { cmd: p, baseArgs: [] };
        }
      }
    }

    return { cmd: "lernstoff", baseArgs: [] };
  }

  public async runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveResult) => {
      const { cmd, baseArgs } = this.resolveCommand();
      const allArgs = [...baseArgs, ...args];
      const env = this.getSpawnEnv(cmd);
      const child = spawn(cmd, allArgs, { env });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("close", (code) => {
        resolveResult({ code: code ?? 0, stdout, stderr });
      });
      child.on("error", (err) => {
        resolveResult({ code: 1, stdout, stderr: err.message });
      });
    });
  }

  public async startDaemon(): Promise<boolean> {
    try {
      // Idempotent guard: if daemon is already running on the configured port, avoid duplicate spawn
      const alreadyRunning = await this.checkDaemon({ skipMetrics: true });
      if (alreadyRunning && this.port === this.config.server.port) {
        this.notify();
        return true;
      }

      const lernstoffDir = join(this.vaultPath, LERNSTOFF_DIR);
      if (!existsSync(lernstoffDir)) {
        try {
          mkdirSync(lernstoffDir, { recursive: true });
        } catch {}
      }

      const requestedPort = this.config.server.port;
      this.lastPortFallback = undefined;

      const { cmd, baseArgs } = this.resolveCommand();
      const args = [
        ...baseArgs,
        "server",
        "start",
        "--daemon",
        "--port",
        String(requestedPort),
        "--vault",
        this.vaultPath,
      ];
      const env = this.getSpawnEnv(cmd);

      let spawnFailed = false;
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        env,
      });

      child.on("error", (err) => {
        spawnFailed = true;
        console.warn("[Lernstoff] CLI daemon start notification:", err.message);
      });
      child.on("exit", (code) => {
        if (code !== null && code !== 0) {
          spawnFailed = true;
        }
      });

      child.unref();

      // Poll checkDaemon up to 4 seconds (35ms interval) for daemon to come online
      for (let i = 0; i < 110; i++) {
        await new Promise((r) => setTimeout(r, 35));
        const ok = await this.checkDaemon({ skipMetrics: true });
        if (ok) {
          this.loadLocalConfig();
          if (this.port !== requestedPort) {
            this.lastPortFallback = {
              requestedPort,
              actualPort: this.port,
            };
          } else {
            this.lastPortFallback = undefined;
          }
          this.connectSse();
          this.notify();
          return true;
        }
        if (spawnFailed) {
          break;
        }
      }
      return false;
    } catch (err: any) {
      console.warn("[Lernstoff] Failed to spawn lernstoff CLI:", err?.message || err);
      return false;
    }
  }

  public async stopDaemon(): Promise<boolean> {
    const pidFile = join(this.vaultPath, LERNSTOFF_DIR, "daemon.pid");
    const portFile = join(this.vaultPath, LERNSTOFF_DIR, "daemon.port");
    let targetPid = this.pid;
    if (existsSync(pidFile)) {
      try {
        const parsed = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          targetPid = parsed;
        }
      } catch {}
    }

    // 1. Abort SSE stream first so keep-alive socket does not hold server open
    this.sseAbortController?.abort();
    this.sseAbortController = undefined;
    this.ssePort = undefined;

    // 2. Run CLI `server stop` (also pauses launchd/systemd supervision)
    try {
      const { cmd, baseArgs } = this.resolveCommand();
      const args = [...baseArgs, "server", "stop", "--vault", this.vaultPath];
      const env = this.getSpawnEnv(cmd);

      const child = spawn(cmd, args, {
        stdio: "ignore",
        env,
      });

      await new Promise<void>((resolvePromise) => {
        const timeout = setTimeout(() => resolvePromise(), 1500);
        child.on("exit", () => {
          clearTimeout(timeout);
          resolvePromise();
        });
        child.on("error", (err) => {
          clearTimeout(timeout);
          console.warn("[Lernstoff] CLI daemon stop notification:", err.message);
          resolvePromise();
        });
      });
    } catch {}

    // 3. Verify PID exit, falling back to direct SIGTERM / SIGKILL if still alive
    if (targetPid && isPidAlive(targetPid) && isSafeDaemonPid(targetPid, this.vaultPath)) {
      try {
        process.kill(targetPid, "SIGTERM");
      } catch {}
      const termDeadline = Date.now() + 600;
      while (Date.now() < termDeadline && isPidAlive(targetPid)) {
        await new Promise((r) => setTimeout(r, 40));
      }
      if (isPidAlive(targetPid)) {
        try {
          process.kill(targetPid, "SIGKILL");
        } catch {}
        const killDeadline = Date.now() + 250;
        while (Date.now() < killDeadline && isPidAlive(targetPid)) {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    }

    if (targetPid && !isPidAlive(targetPid)) {
      try {
        if (existsSync(pidFile)) unlinkSync(pidFile);
      } catch {}
      try {
        if (existsSync(portFile)) unlinkSync(portFile);
      } catch {}
    }

    // 4. Verify daemon is genuinely offline
    let stillRunning = await this.checkDaemon();
    for (let i = 0; i < 5 && stillRunning; i++) {
      await new Promise((r) => setTimeout(r, 60));
      stillRunning = await this.checkDaemon();
    }

    if (!stillRunning) {
      this.isRunning = false;
      this.pid = undefined;
      this.port = this.config.server.port;
      this.lastPortFallback = undefined;
      this.notify();
      return true;
    }

    this.isRunning = true;
    this.notify();
    return false;
  }

  public async restartDaemon(): Promise<boolean> {
    const pidFile = join(this.vaultPath, LERNSTOFF_DIR, "daemon.pid");
    const portFile = join(this.vaultPath, LERNSTOFF_DIR, "daemon.port");
    let targetPid = this.pid;
    if (existsSync(pidFile)) {
      try {
        const parsed = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          targetPid = parsed;
        }
      } catch {}
    }

    this.sseAbortController?.abort();
    this.sseAbortController = undefined;
    this.ssePort = undefined;

    if (targetPid && isPidAlive(targetPid) && isSafeDaemonPid(targetPid, this.vaultPath)) {
      try {
        process.kill(targetPid, "SIGTERM");
      } catch {}
      const termDeadline = Date.now() + 350;
      while (Date.now() < termDeadline && isPidAlive(targetPid)) {
        await new Promise((r) => setTimeout(r, 15));
      }
      if (isPidAlive(targetPid)) {
        try {
          process.kill(targetPid, "SIGKILL");
        } catch {}
        const killDeadline = Date.now() + 150;
        while (Date.now() < killDeadline && isPidAlive(targetPid)) {
          await new Promise((r) => setTimeout(r, 15));
        }
      }
    } else if (this.isRunning) {
      const stopped = await this.stopDaemon();
      if (!stopped) return false;
    }

    if (!targetPid || !isPidAlive(targetPid)) {
      try {
        if (existsSync(pidFile)) unlinkSync(pidFile);
      } catch {}
      try {
        if (existsSync(portFile)) unlinkSync(portFile);
      } catch {}
    }

    this.isRunning = false;
    this.pid = undefined;
    this.port = this.config.server.port;
    this.lastPortFallback = undefined;

    return await this.startDaemon();
  }

  public async installService(): Promise<ActionResult> {
    const res = await this.runCli(["service", "install", "--vault", this.vaultPath]);
    if (res.code === 0) {
      this.loadLocalConfig();
      this.notify();
      return { success: true };
    }
    return {
      success: false,
      error:
        res.stderr.trim() ||
        res.stdout.trim() ||
        `CLI service install exited with code ${res.code}`,
    };
  }

  public async uninstallService(): Promise<ActionResult> {
    const res = await this.runCli(["service", "uninstall", "--vault", this.vaultPath]);
    if (res.code === 0) {
      this.loadLocalConfig();
      this.notify();
      return { success: true };
    }
    return {
      success: false,
      error:
        res.stderr.trim() ||
        res.stdout.trim() ||
        `CLI service uninstall exited with code ${res.code}`,
    };
  }

  /**
   * Build the MCP server entry for this vault, resolving the absolute
   * `lernstoff` binary and `PATH` so GUI agent hosts can spawn it reliably.
   */
  public getMcpEntry(): { command: string; args: string[]; env?: Record<string, string> } {
    const absVault = resolve(this.vaultPath);
    const { cmd } = this.resolveCommand();
    const spawnEnv = this.getSpawnEnv(cmd);
    return {
      command: cmd,
      args: ["mcp", "--vault", absVault],
      ...(cmd !== "lernstoff" && spawnEnv.PATH ? { env: { PATH: spawnEnv.PATH } } : {}),
    };
  }

  public async installAgent(
    target: "all" | "claude" | "cursor" | "antigravity",
  ): Promise<ActionResult> {
    const res = await this.runCli([
      "skill",
      "install",
      "--target",
      target,
      "--vault",
      this.vaultPath,
    ]);
    if (res.code === 0) {
      return { success: true };
    }
    return {
      success: false,
      error:
        res.stderr.trim() || res.stdout.trim() || `CLI skill install exited with code ${res.code}`,
    };
  }

  public async updateIndex(): Promise<ActionResult> {
    if (this.isRunning) {
      try {
        const res = await localHttpJson({
          port: this.port,
          path: "/api/index-maint",
          method: "POST",
          body: { action: "update" },
          timeoutMs: 10_000,
        });
        if (res.ok) return { success: true };
        return {
          success: false,
          error: (res.json as any)?.error || `Daemon returned HTTP ${res.status}`,
        };
      } catch {}
    }
    const cliRes = await this.runCli(["doctor", "--pull-models", "--vault", this.vaultPath]);
    if (cliRes.code === 0) return { success: true };
    return {
      success: false,
      error:
        cliRes.stderr.trim() ||
        cliRes.stdout.trim() ||
        `CLI doctor exited with code ${cliRes.code}`,
    };
  }

  public async cleanupOrphans(): Promise<ActionResult> {
    if (this.isRunning) {
      try {
        const res = await localHttpJson({
          port: this.port,
          path: "/api/index-maint",
          method: "POST",
          body: { action: "cleanup" },
          timeoutMs: 10_000,
        });
        if (res.ok) return { success: true };
        return {
          success: false,
          error: (res.json as any)?.error || `Daemon returned HTTP ${res.status}`,
        };
      } catch {}
    }
    const cliRes = await this.runCli(["doctor", "--cleanup", "--vault", this.vaultPath]);
    if (cliRes.code === 0) return { success: true };
    return {
      success: false,
      error:
        cliRes.stderr.trim() ||
        cliRes.stdout.trim() ||
        `CLI doctor cleanup exited with code ${cliRes.code}`,
    };
  }

  private connectSse(): void {
    if (this.isDestroyed || !this.isRunning) return;
    if (
      this.sseAbortController &&
      !this.sseAbortController.signal.aborted &&
      this.ssePort === this.port
    ) {
      return;
    }

    this.sseAbortController?.abort();
    const controller = new AbortController();
    this.sseAbortController = controller;
    this.ssePort = this.port;

    let sseResponse: any;
    const req: ClientRequest = httpRequest(
      {
        hostname: "127.0.0.1",
        port: this.port,
        path: "/api/events",
        method: "GET",
        agent: false,
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        sseResponse = res;
        if (controller.signal.aborted) {
          res.destroy();
          return;
        }
        res.setEncoding("utf-8");
        res.on("data", (text: string) => {
          if (this.isDestroyed || controller.signal.aborted) return;
          if (
            text.includes("inquiries_changed") ||
            text.includes("note_crystallized") ||
            text.includes("scratchpad_updated") ||
            text.includes("status_updated")
          ) {
            this.fetchMetrics()
              .then(() => this.notify())
              .catch(() => {});
          }
        });
        res.on("end", () => {
          if (!controller.signal.aborted) {
            this.handleDisconnect();
          }
        });
        res.on("error", () => {
          if (!controller.signal.aborted) {
            this.handleDisconnect();
          }
        });
      },
    );

    controller.signal.addEventListener(
      "abort",
      () => {
        sseResponse?.destroy?.();
        req.destroy();
      },
      { once: true },
    );

    req.on("error", () => {
      if (!controller.signal.aborted) {
        this.handleDisconnect();
      }
    });

    req.end();
  }

  private handleDisconnect(): void {
    if (this.isDestroyed) return;
    this.sseAbortController = undefined;
    this.ssePort = undefined;
    this.checkDaemon();
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.stopHealthPolling();
    this.sseAbortController?.abort();
    this.sseAbortController = undefined;
    this.ssePort = undefined;
    this.statusListeners.clear();
  }
}
