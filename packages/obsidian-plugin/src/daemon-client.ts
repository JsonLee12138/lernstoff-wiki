import { existsSync, readFileSync } from "node:fs";
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
      await new Promise((r) => setTimeout(r, 600));
      await this.checkDaemon();
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
    const extraPaths = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(home, ".local/bin"),
      join(home, ".npm-global/bin"),
      join(home, ".pnpm"),
    ];
    return {
      ...process.env,
      PATH: `${extraPaths.join(":")}:${process.env.PATH || ""}`,
    };
  }

  private resolveCommand(): { cmd: string; baseArgs: string[] } {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidates = [
      "/opt/homebrew/bin/lernstoff",
      "/usr/local/bin/lernstoff",
      join(home, ".local/bin/lernstoff"),
      join(home, ".npm-global/bin/lernstoff"),
    ];

    for (const c of candidates) {
      if (existsSync(c)) {
        return { cmd: c, baseArgs: [] };
      }
    }

    return { cmd: "lernstoff", baseArgs: [] };
  }

  public async startDaemon(): Promise<void> {
    try {
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
    } catch (err: any) {
      console.warn("[Lernstoff] Failed to spawn lernstoff CLI:", err?.message || err);
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

  public async restartDaemon(): Promise<void> {
    await this.stopDaemon();
    await new Promise((r) => setTimeout(r, 500));
    await this.startDaemon();
    await new Promise((r) => setTimeout(r, 800));
    await this.checkDaemon();
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
