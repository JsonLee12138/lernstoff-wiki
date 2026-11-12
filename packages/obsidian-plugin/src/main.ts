import { Plugin, Notice, type Editor } from "obsidian";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseScratchpad, formatScratchpad } from "@lernstoff/core/scratchpad";
import { DaemonClient } from "./daemon-client.js";
import { LernstoffSettingsTab } from "./settings-tab.js";

export default class LernstoffPlugin extends Plugin {
  public client!: DaemonClient;
  private statusBarEl!: HTMLElement;

  async onload(): Promise<void> {
    const adapter = this.app.vault.adapter as any;
    const vaultPath = adapter?.getBasePath?.() || adapter?.basePath || ".";
    this.client = new DaemonClient(vaultPath);

    // 1. Add native status bar
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("lernstoff-status-bar");
    this.updateStatusBar();

    this.client.onStatus(() => {
      this.updateStatusBar();
    });

    this.statusBarEl.addEventListener("click", () => {
      (this.app as any).setting?.open?.();
      (this.app as any).setting?.openTabById?.("lernstoff-wiki");
    });

    // 2. Register Settings Tab
    this.addSettingTab(new LernstoffSettingsTab(this.app, this, this.client));

    // 3. Register 7 Native Command Palette Commands
    this.addCommand({
      id: "open-inquiry-tree",
      name: "Open Inquiry Tree (打开好奇心问题树)",
      callback: async () => {
        let file = this.app.vault.getAbstractFileByPath(this.client.config.paths.inquiriesFile);
        if (!file) {
          await this.client.ensureStarterTemplates();
          file = this.app.vault.getAbstractFileByPath(this.client.config.paths.inquiriesFile);
        }
        if (file) {
          await this.app.workspace.getLeaf().openFile(file as any);
        } else {
          new Notice(`Inquiries file not found at ${this.client.config.paths.inquiriesFile}`);
        }
      },
    });

    this.addCommand({
      id: "open-scratchpad",
      name: "Open Scratchpad (打开闪念缓冲池)",
      callback: async () => {
        let file = this.app.vault.getAbstractFileByPath(this.client.config.paths.scratchpadFile);
        if (!file) {
          await this.client.ensureStarterTemplates();
          file = this.app.vault.getAbstractFileByPath(this.client.config.paths.scratchpadFile);
        }
        if (file) {
          await this.app.workspace.getLeaf().openFile(file as any);
        } else {
          new Notice(`Scratchpad file not found at ${this.client.config.paths.scratchpadFile}`);
        }
      },
    });

    this.addCommand({
      id: "add-selection-to-inquiries",
      name: "Add Selection to Inquiry Tree (将选中文本添加为焦点问题)",
      editorCallback: async (editor: Editor) => {
        const selected = editor.getSelection().trim();
        if (!selected) {
          new Notice("Please select text in the editor first.");
          return;
        }
        try {
          const res = await fetch(`http://127.0.0.1:${this.client.port}/api/inquiries`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "add", question: selected }),
          });
          if (res.ok) {
            new Notice(`Added to Inquiry Tree: "${selected.slice(0, 30)}..."`);
          }
        } catch {
          new Notice("Failed to contact Lernstoff Daemon.");
        }
      },
    });

    this.addCommand({
      id: "defer-selection-to-scratchpad",
      name: "Defer Selection to Scratchpad (将选中文本记入闪念缓冲池)",
      editorCallback: async (editor: Editor) => {
        const selected = editor.getSelection().trim();
        if (!selected) {
          new Notice("Please select text in the editor first.");
          return;
        }
        let handled = false;
        try {
          const res = await fetch(`http://127.0.0.1:${this.client.port}/api/scratchpad`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "add", text: selected }),
          });
          if (res.ok) {
            new Notice(`Deferred to Scratchpad: "${selected.slice(0, 30)}..."`);
            handled = true;
          }
        } catch {}

        if (!handled) {
          // Direct local fallback write to scratchpad file if daemon offline
          try {
            const scratchpadPath = join(
              this.client.vaultPath,
              this.client.config.paths.scratchpadFile,
            );
            if (existsSync(scratchpadPath)) {
              const content = readFileSync(scratchpadPath, "utf-8");
              const entries = parseScratchpad(content);
              entries.push({
                firstSeen: new Date().toISOString().slice(0, 10),
                claim: selected,
                hitCount: 1,
                relatedEntities: [],
                sources: ["manual"],
                status: "DEFERRED",
              });
              writeFileSync(scratchpadPath, formatScratchpad(entries), "utf-8");
              new Notice(`Deferred to Scratchpad (local): "${selected.slice(0, 30)}..."`);
            }
          } catch (e: any) {
            new Notice(`Failed to defer to scratchpad: ${e.message}`);
          }
        }
      },
    });

    this.addCommand({
      id: "run-socratic-lint",
      name: "Run Socratic Wiki Lint (运行苏格拉底健康度巡检)",
      callback: async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${this.client.port}/api/lint`, {
            method: "POST",
          });
          if (res.ok) {
            const data = await res.json();
            new Notice(
              `🏛️ Lint: ${data.summary.totalNotes} notes, ${data.summary.orphanCount} orphans, ${data.summary.synthesisReadyCount} ready for synthesis.`,
            );
          }
        } catch {
          new Notice("Failed to run lint: Daemon offline.");
        }
      },
    });

    this.addCommand({
      id: "consolidate-scratchpad",
      name: "Consolidate & GC Scratchpad (执行闪念池整合与过期清理)",
      callback: async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${this.client.port}/api/scratchpad`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "gc" }),
          });
          if (res.ok) {
            const data = await res.json();
            new Notice(
              `⚡ Scratchpad GC: pruned ${data.decayedArchivedCount || 0} expired items. ${data.promotions?.length || 0} ready for promotion.`,
            );
          }
        } catch {
          new Notice("Failed to consolidate scratchpad: Daemon offline.");
        }
      },
    });

    this.addCommand({
      id: "restart-daemon",
      name: "Restart Background Daemon (重启后台认知引擎)",
      callback: async () => {
        new Notice("Restarting Lernstoff Daemon...");
        const ok = await this.client.restartDaemon();
        if (ok) {
          if (this.client.lastPortFallback) {
            const { requestedPort, actualPort } = this.client.lastPortFallback;
            new Notice(
              `⚠️ Port ${requestedPort} was occupied; switched to ${actualPort} and updated config.`,
            );
          } else {
            new Notice("🟢 Lernstoff Daemon online.");
          }
        } else {
          new Notice("❌ Failed to restart Daemon.");
        }
      },
    });

    this.addCommand({
      id: "start-daemon",
      name: "Start Background Daemon (启动后台认知引擎)",
      callback: async () => {
        new Notice("Starting Lernstoff Daemon...");
        const ok = await this.client.startDaemon();
        if (ok) {
          if (this.client.lastPortFallback) {
            const { requestedPort, actualPort } = this.client.lastPortFallback;
            new Notice(
              `⚠️ Port ${requestedPort} was occupied; switched to ${actualPort} and updated config.`,
            );
          } else {
            new Notice("🟢 Lernstoff Daemon online.");
          }
        } else {
          new Notice("❌ Failed to start Daemon. Check .lernstoff/daemon.log");
        }
      },
    });

    this.addCommand({
      id: "stop-daemon",
      name: "Stop Background Daemon (停止后台认知引擎)",
      callback: async () => {
        const ok = await this.client.stopDaemon();
        new Notice(ok ? "🛑 Stopped Lernstoff Daemon." : "❌ Failed to stop Lernstoff Daemon.");
      },
    });

    // 4. Initialize daemon client asynchronously (safe, non-blocking)
    this.client.init().catch((err) => {
      console.warn("[Lernstoff] Daemon init warning:", err);
    });
  }

  onunload(): void {
    this.client?.destroy();
  }

  public updateStatusBar(): void {
    if (!this.statusBarEl) return;
    const isRunning = this.client.isRunning;
    const m = this.client.metrics;

    if (!isRunning) {
      this.statusBarEl.setText("🧠 Lernstoff: ⚪ Offline");
      this.statusBarEl.title = "Lernstoff daemon is offline. Click to open settings.";
      return;
    }

    const inq = m ? `${m.openInquiries} Inquiries` : "Active";
    const scratch = m
      ? `${m.scratchpadTotal} Scratchpad (${m.scratchpadPromotionsReady} Ready)`
      : "0 Scratchpad (0 Ready)";
    const ratio = m && typeof m.noiseFilteredRatio === "number" ? m.noiseFilteredRatio : 0;
    const noiseFilteredText = `${Math.round(ratio * 100)}% filtered`;
    const pendingHint =
      this.client.config.server.port !== this.client.port
        ? ` | ⚠️ Restart -> :${this.client.config.server.port}`
        : "";

    this.statusBarEl.setText(
      `🧠 Lernstoff: ${inq} | ${scratch} | ${noiseFilteredText} | 🟢${pendingHint}`,
    );
    this.statusBarEl.title = `Running on port ${this.client.port}${pendingHint}. Click to open settings.`;
  }
}
