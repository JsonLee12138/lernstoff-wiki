import { watch, type FSWatcher, existsSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { type LernstoffConfig } from "./config.js";

export interface VaultWatcherCallbacks {
  onFileChanged?: (relPath: string) => Promise<void> | void;
  onInquiriesChanged?: () => Promise<void> | void;
  onWikiChanged?: (relPath: string) => Promise<void> | void;
}

/**
 * Loop-Safe Vault File Watcher with recentWrites and mtime deduplication.
 * Modeled on obsidian-llm-wiki/src/schema/auto-maintain.ts#L194-L208.
 */
export class VaultWatcher {
  private vaultPath: string;
  private config: LernstoffConfig;
  private callbacks: VaultWatcherCallbacks;
  private watchers: FSWatcher[] = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  // Deduplication structures to prevent infinite programmatic write loops
  private recentWrites: Set<string> = new Set();
  private lastSeenMtimes: Map<string, number> = new Map();
  private isWatching = false;

  constructor(vaultPath: string, config: LernstoffConfig, callbacks: VaultWatcherCallbacks = {}) {
    this.vaultPath = resolve(vaultPath);
    this.config = config;
    this.callbacks = callbacks;
  }

  /**
   * Mark a file as recently written by the daemon/system to prevent re-entrant loop triggers.
   */
  public markRecentWrite(filePath: string, ttlMs = 2000): void {
    const relPath = this.normalizeRelPath(filePath);
    this.recentWrites.add(relPath);
    setTimeout(() => {
      this.recentWrites.delete(relPath);
    }, ttlMs);
  }

  /**
   * Check whether a file path is currently in the recent writes suppression window.
   */
  public isRecentWrite(filePath: string): boolean {
    const relPath = this.normalizeRelPath(filePath);
    return this.recentWrites.has(relPath);
  }

  public updateConfig(newConfig: LernstoffConfig): void {
    this.config = newConfig;
    if (this.isWatching) {
      this.stop();
      this.start();
    }
  }

  public start(): void {
    if (this.isWatching) return;
    this.isWatching = true;

    const dirsToWatch = [
      join(this.vaultPath, this.config.paths.wikiDir),
      join(this.vaultPath, dirname(this.config.paths.scratchpadFile)),
    ];

    for (const dir of dirsToWatch) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          const fullPath = join(dir, filename.toString());
          this.handleFileEvent(fullPath);
        });
        this.watchers.push(watcher);
      } catch (err) {
        console.warn(`[VaultWatcher] Failed to watch ${dir}:`, err);
      }
    }
  }

  public stop(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.isWatching = false;
  }

  private handleFileEvent(absPath: string): void {
    if (!absPath.endsWith(".md")) return;
    const relPath = this.normalizeRelPath(absPath);

    // Filter out .lernstoff internal paths or hidden files
    if (relPath.startsWith(".lernstoff") || relPath.startsWith(".git") || relPath.startsWith(".")) {
      return;
    }

    // 1. Loop prevention: check if recently written programmatically
    if (this.recentWrites.has(relPath)) {
      return;
    }

    // Debounce to collapse rapid editor autosave bursts
    const existingTimer = this.debounceTimers.get(relPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(relPath);
      this.processFileChange(relPath, absPath);
    }, this.config.server.watchDebounceMs);

    this.debounceTimers.set(relPath, timer);
  }

  private processFileChange(relPath: string, absPath: string): void {
    if (!existsSync(absPath)) return;

    // 2. mtime deduplication (auto-maintain.ts#L199-L204)
    try {
      const stats = statSync(absPath);
      const mtime = stats.mtimeMs;
      const lastMtime = this.lastSeenMtimes.get(relPath);

      if (lastMtime && Math.abs(lastMtime - mtime) < 10) {
        return; // Identical mtime already processed
      }
      this.lastSeenMtimes.set(relPath, mtime);
    } catch {
      return;
    }

    // Dispatch callbacks
    this.callbacks.onFileChanged?.(relPath);

    const inquiriesRel = this.normalizeRelPath(this.config.paths.inquiriesFile);
    if (relPath === inquiriesRel) {
      this.callbacks.onInquiriesChanged?.();
    }

    const wikiDirRel = this.normalizeRelPath(this.config.paths.wikiDir);
    if (relPath.startsWith(wikiDirRel)) {
      this.callbacks.onWikiChanged?.(relPath);
    }
  }

  private normalizeRelPath(path: string): string {
    const abs = resolve(this.vaultPath, path);
    return relative(this.vaultPath, abs).replace(/\\/g, "/");
  }
}
