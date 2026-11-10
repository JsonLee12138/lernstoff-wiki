import { existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  type LernstoffConfig,
  loadConfig,
  saveConfig,
  DEFAULT_LERNSTOFF_CONFIG,
  LERNSTOFF_DIR,
} from "@lernstoff/core/config";

export interface DaemonMetrics {
  conceptNotes: number;
  totalInquiries: number;
  openInquiries: number;
  scratchpadTotal: number;
  scratchpadPromotionsReady: number;
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

  private statusListeners: Set<StatusListener> = new Set();
  private sseAbortController?: AbortController;
  private isDestroyed = false;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.config = DEFAULT_LERNSTOFF_CONFIG;
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
    await this.checkDaemon();

    if (!this.isRunning && this.config.server.autoStartOnObsidianOpen) {
      await this.startDaemon();
    }

    if (this.isRunning) {
      this.connectSse();
    }
  }

  public loadLocalConfig(): LernstoffConfig {
    this.config = loadConfig(this.vaultPath);
    return this.config;
  }

  public updateConfig(newConfig: LernstoffConfig): void {
    saveConfig(this.vaultPath, newConfig);
    this.config = newConfig;
    if (this.isRunning) {
      fetch(`http://127.0.0.1:${this.port}/api/reload-config`, { method: "POST" }).catch(() => {});
    }
  }

  public async checkDaemon(): Promise<boolean> {
    const portFile = join(this.vaultPath, LERNSTOFF_DIR, "daemon.port");
    const pidFile = join(this.vaultPath, LERNSTOFF_DIR, "daemon.pid");

    if (!existsSync(portFile)) {
      this.isRunning = false;
      this.notify();
      return false;
    }

    let p: number;
    try {
      p = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
      if (!p || isNaN(p)) {
        this.isRunning = false;
        this.notify();
        return false;
      }
    } catch {
      this.isRunning = false;
      this.notify();
      return false;
    }

    let currentPid: number | undefined;
    if (existsSync(pidFile)) {
      try {
        currentPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      } catch {}
    }

    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const data = await res.json();
        // If the health endpoint specifies a vault, ensure it matches this vault
        if (data.vault && data.vault !== this.vaultPath) {
          this.isRunning = false;
          this.notify();
          return false;
        }
        this.isRunning = true;
        this.port = data.port || p;
        this.pid = data.pid || currentPid;
        await this.fetchMetrics();
        this.notify();
        return true;
      }
    } catch {
      // not running
    }

    this.isRunning = false;
    this.notify();
    return false;
  }

  public async fetchMetrics(): Promise<DaemonMetrics | null> {
    if (!this.isRunning) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/status`);
      if (res.ok) {
        const data = await res.json();
        this.metrics = data.metrics;
        return this.metrics || null;
      }
    } catch {}
    return null;
  }

  private getSpawnEnv(): NodeJS.ProcessEnv {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const extraPaths: string[] = [
      "/opt/homebrew/bin",
      "/opt/homebrew/opt/node@22/bin",
      "/opt/homebrew/opt/node/bin",
      "/usr/local/bin",
      join(home, ".local/bin"),
      join(home, ".npm-global/bin"),
      join(home, ".pnpm"),
      join(home, ".local/share/mise/shims"),
      join(home, ".local/share/fnm/current/bin"),
      join(home, ".fnm/current/bin"),
      join(home, ".volta/bin"),
      join(home, ".asdf/shims"),
    ];

    // Check NVM node paths, preferring higher Node versions (>= 20)
    const nvmDir = join(home, ".nvm/versions/node");
    if (existsSync(nvmDir)) {
      try {
        const versions = readdirSync(nvmDir)
          .filter((v) => {
            const major = parseInt(v.replace(/^v/, ""), 10);
            return !isNaN(major) && major >= 20;
          })
          .sort((a, b) => {
            const ma = parseInt(a.replace(/^v/, ""), 10);
            const mb = parseInt(b.replace(/^v/, ""), 10);
            return mb - ma;
          });
        for (const v of versions) {
          extraPaths.push(join(nvmDir, v, "bin"));
        }
      } catch {}
    }

    const currentPath = process.env.PATH || "";
    const pathParts = (currentPath ? currentPath.split(":") : []).concat(extraPaths);
    const uniquePaths = Array.from(new Set(pathParts.filter(Boolean)));

    return {
      ...process.env,
      PATH: uniquePaths.join(":"),
    };
  }

  private resolveCommand(): { cmd: string; baseArgs: string[] } {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidates = [
      "/opt/homebrew/bin/lernstoff",
      "/usr/local/bin/lernstoff",
      join(home, ".local/bin/lernstoff"),
      join(home, ".npm-global/bin/lernstoff"),
      join(home, ".local/share/mise/shims/lernstoff"),
      join(home, ".volta/bin/lernstoff"),
      join(home, ".asdf/shims/lernstoff"),
      join(home, ".pnpm/lernstoff"),
    ];

    const nvmDir = join(home, ".nvm/versions/node");
    if (existsSync(nvmDir)) {
      try {
        const versions = readdirSync(nvmDir);
        for (const v of versions) {
          candidates.push(join(nvmDir, v, "bin/lernstoff"));
        }
      } catch {}
    }

    for (const c of candidates) {
      if (existsSync(c)) {
        return { cmd: c, baseArgs: [] };
      }
    }

    return { cmd: "lernstoff", baseArgs: [] };
  }

  public async startDaemon(): Promise<boolean> {
    try {
      const lernstoffDir = join(this.vaultPath, LERNSTOFF_DIR);
      if (!existsSync(lernstoffDir)) {
        try {
          mkdirSync(lernstoffDir, { recursive: true });
        } catch {}
      }

      const { cmd, baseArgs } = this.resolveCommand();
      const args = [...baseArgs, "server", "start", "--daemon", "--vault", this.vaultPath];
      const env = this.getSpawnEnv();

      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        env,
      });

      child.on("error", (err) => {
        console.warn("[Lernstoff] CLI daemon start notification:", err.message);
      });

      child.unref();

      // Poll checkDaemon up to 3 seconds for daemon to initialize and come online
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const ok = await this.checkDaemon();
        if (ok) {
          this.connectSse();
          return true;
        }
      }
      return false;
    } catch (err: any) {
      console.warn("[Lernstoff] Failed to spawn lernstoff CLI:", err?.message || err);
      return false;
    }
  }

  public async stopDaemon(): Promise<void> {
    try {
      const { cmd, baseArgs } = this.resolveCommand();
      const args = [...baseArgs, "server", "stop", "--vault", this.vaultPath];
      const env = this.getSpawnEnv();

      const child = spawn(cmd, args, {
        stdio: "ignore",
        env,
      });

      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        child.on("error", (err) => {
          console.warn("[Lernstoff] CLI daemon stop notification:", err.message);
          resolve();
        });
      });
    } catch {}
    this.isRunning = false;
    this.notify();
  }

  public async restartDaemon(): Promise<boolean> {
    await this.stopDaemon();
    await new Promise((r) => setTimeout(r, 500));
    return await this.startDaemon();
  }

  private connectSse(): void {
    if (this.isDestroyed || !this.isRunning) return;

    this.sseAbortController?.abort();
    this.sseAbortController = new AbortController();

    fetch(`http://127.0.0.1:${this.port}/api/events`, { signal: this.sseAbortController.signal })
      .then(async (res) => {
        const reader = res.body?.getReader();
        if (!reader) return;

        while (!this.isDestroyed) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          if (
            text.includes("inquiries_changed") ||
            text.includes("note_crystallized") ||
            text.includes("status_updated")
          ) {
            await this.fetchMetrics();
            this.notify();
          }
        }
      })
      .catch(() => {
        // SSE disconnected, will retry on next check
      });
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.sseAbortController?.abort();
    this.statusListeners.clear();
  }
}
