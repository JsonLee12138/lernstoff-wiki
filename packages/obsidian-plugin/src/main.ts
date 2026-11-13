import { Plugin, Notice, type Editor } from "obsidian";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseScratchpad, formatScratchpad } from "@lernstoff/core/scratchpad";
import { DaemonClient } from "./daemon-client.js";
import { LernstoffSettingsTab } from "./settings-tab.js";
import { t } from "./i18n.js";

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
      name: t("commands.openInquiryTree"),
      callback: async () => {
        let file = this.app.vault.getAbstractFileByPath(this.client.config.paths.inquiriesFile);
        if (!file) {
          await this.client.ensureStarterTemplates();
          file = this.app.vault.getAbstractFileByPath(this.client.config.paths.inquiriesFile);
        }
        if (file) {
          await this.app.workspace.getLeaf().openFile(file as any);
        } else {
          new Notice(
            t("notices.inquiriesFileNotFound", { path: this.client.config.paths.inquiriesFile }),
          );
        }
      },
    });

    this.addCommand({
      id: "open-scratchpad",
      name: t("commands.openScratchpad"),
      callback: async () => {
        let file = this.app.vault.getAbstractFileByPath(this.client.config.paths.scratchpadFile);
        if (!file) {
          await this.client.ensureStarterTemplates();
          file = this.app.vault.getAbstractFileByPath(this.client.config.paths.scratchpadFile);
        }
        if (file) {
          await this.app.workspace.getLeaf().openFile(file as any);
        } else {
          new Notice(
            t("notices.scratchpadFileNotFound", { path: this.client.config.paths.scratchpadFile }),
          );
        }
      },
    });

    this.addCommand({
      id: "add-selection-to-inquiries",
      name: t("commands.addSelectionToInquiries"),
      editorCallback: async (editor: Editor) => {
        const selected = editor.getSelection().trim();
        if (!selected) {
          new Notice(t("notices.selectTextFirst"));
          return;
        }
        try {
          const res = await fetch(`http://127.0.0.1:${this.client.port}/api/inquiries`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "add", question: selected }),
          });
          if (res.ok) {
            new Notice(t("notices.addedToInquiries", { text: selected.slice(0, 30) }));
          }
        } catch {
          new Notice(t("notices.daemonContactFailed"));
        }
      },
    });

    this.addCommand({
      id: "defer-selection-to-scratchpad",
      name: t("commands.deferSelectionToScratchpad"),
      editorCallback: async (editor: Editor) => {
        const selected = editor.getSelection().trim();
        if (!selected) {
          new Notice(t("notices.selectTextFirst"));
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
            new Notice(t("notices.deferredToScratchpad", { text: selected.slice(0, 30) }));
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
              new Notice(t("notices.deferredToScratchpadLocal", { text: selected.slice(0, 30) }));
            }
          } catch (e: any) {
            new Notice(t("notices.failedToDefer", { error: e.message }));
          }
        }
      },
    });

    this.addCommand({
      id: "run-socratic-lint",
      name: t("commands.runSocraticLint"),
      callback: async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${this.client.port}/api/lint`, {
            method: "POST",
          });
          if (res.ok) {
            const data = await res.json();
            new Notice(
              t("notices.lintResult", {
                notes: data.summary.totalNotes,
                orphans: data.summary.orphanCount,
                ready: data.summary.synthesisReadyCount,
              }),
            );
          }
        } catch {
          new Notice(t("notices.lintFailedOffline"));
        }
      },
    });

    this.addCommand({
      id: "consolidate-scratchpad",
      name: t("commands.consolidateScratchpad"),
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
              t("notices.scratchpadGcResult", {
                pruned: data.decayedArchivedCount || 0,
                ready: data.promotions?.length || 0,
              }),
            );
          }
        } catch {
          new Notice(t("notices.scratchpadGcFailedOffline"));
        }
      },
    });

    this.addCommand({
      id: "restart-daemon",
      name: t("commands.restartDaemon"),
      callback: async () => {
        new Notice(t("notices.daemonRestarting"));
        const ok = await this.client.restartDaemon();
        if (ok) {
          if (this.client.lastPortFallback) {
            const { requestedPort, actualPort } = this.client.lastPortFallback;
            new Notice(t("notices.daemonPortOccupiedSwitched", { requestedPort, actualPort }));
          } else {
            new Notice(t("notices.daemonOnline"));
          }
        } else {
          new Notice(t("notices.daemonRestartFailed"));
        }
      },
    });

    this.addCommand({
      id: "start-daemon",
      name: t("commands.startDaemon"),
      callback: async () => {
        new Notice(t("notices.daemonStarting"));
        const ok = await this.client.startDaemon();
        if (ok) {
          if (this.client.lastPortFallback) {
            const { requestedPort, actualPort } = this.client.lastPortFallback;
            new Notice(t("notices.daemonPortOccupiedSwitched", { requestedPort, actualPort }));
          } else {
            new Notice(t("notices.daemonOnline"));
          }
        } else {
          new Notice(t("notices.daemonStartFailedWithLog"));
        }
      },
    });

    this.addCommand({
      id: "stop-daemon",
      name: t("commands.stopDaemon"),
      callback: async () => {
        const ok = await this.client.stopDaemon();
        new Notice(ok ? t("notices.daemonStopped") : t("notices.daemonStopFailed"));
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
      this.statusBarEl.setText(t("statusBar.offline"));
      this.statusBarEl.title = t("statusBar.offlineTooltip");
      return;
    }

    const inq = m
      ? t("statusBar.inquiriesCount", { count: m.openInquiries })
      : t("statusBar.inquiriesActive");
    const scratch = m
      ? t("statusBar.scratchpadStatus", {
          total: m.scratchpadTotal,
          ready: m.scratchpadPromotionsReady,
        })
      : t("statusBar.scratchpadStatus", { total: 0, ready: 0 });
    const ratio = m && typeof m.noiseFilteredRatio === "number" ? m.noiseFilteredRatio : 0;
    const noiseFilteredText = t("statusBar.noiseFiltered", { percent: Math.round(ratio * 100) });
    const pendingHint =
      this.client.config.server.port !== this.client.port
        ? t("statusBar.pendingRestartHint", { port: this.client.config.server.port })
        : "";

    this.statusBarEl.setText(
      t("statusBar.runningText", {
        inquiries: inq,
        scratchpad: scratch,
        noiseFiltered: noiseFilteredText,
        pendingHint,
      }),
    );
    this.statusBarEl.title = t("statusBar.runningTooltip", {
      port: this.client.port,
      pendingHint,
    });
  }
}
