import { App, PluginSettingTab, Plugin, Setting, Notice } from "obsidian";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LERNSTOFF_CONFIG, LERNSTOFF_DIR } from "@lernstoff/core/config";
import type { DaemonClient } from "./daemon-client.js";

function parseValidPort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const p = Number(trimmed);
  if (!Number.isSafeInteger(p) || p < 1024 || p > 65535) return null;
  return p;
}

export class LernstoffSettingsTab extends PluginSettingTab {
  private client: DaemonClient;
  private statusUnsubscribe?: () => void;
  private isActionInFlight = false;
  private isPortInputFocused = false;
  private portDraftInvalid = false;
  private daemonStatusSetting?: Setting;
  private startBtn?: any;
  private restartBtn?: any;
  private stopBtn?: any;
  private serverPortText?: any;

  constructor(app: App, plugin: Plugin, client: DaemonClient) {
    super(app, plugin);
    this.client = client;
  }

  public hide(): void {
    this.statusUnsubscribe?.();
    this.statusUnsubscribe = undefined;
    this.isPortInputFocused = false;
  }

  private computeStatusDesc(): string {
    if (!this.client.isRunning) {
      return "⚪ Daemon Stopped";
    }
    const base = `🟢 Running on http://127.0.0.1:${this.client.port} (PID ${this.client.pid || "unknown"})`;
    if (this.client.config.server.port !== this.client.port) {
      return `${base} · ⚠️ Port ${this.client.config.server.port} saved — click Restart to switch`;
    }
    if (
      this.client.lastPortFallback &&
      this.client.lastPortFallback.actualPort === this.client.port
    ) {
      const { requestedPort, actualPort } = this.client.lastPortFallback;
      return `${base} · ⚠️ Port ${requestedPort} was occupied; switched to ${actualPort} and updated config.`;
    }
    return base;
  }

  private syncDaemonStatusUi(): void {
    this.daemonStatusSetting?.setDesc(this.computeStatusDesc());
    if (this.isActionInFlight) {
      this.startBtn?.setDisabled(true);
      this.restartBtn?.setDisabled(true);
      this.stopBtn?.setDisabled(true);
    } else {
      this.startBtn?.setDisabled(this.client.isRunning);
      this.restartBtn?.setDisabled(false);
      this.stopBtn?.setDisabled(!this.client.isRunning);
    }

    const inputEl = this.serverPortText?.inputEl;
    const domFocused =
      typeof document !== "undefined" && inputEl && document.activeElement === inputEl;
    if (this.serverPortText && !this.isPortInputFocused && !domFocused && !this.portDraftInvalid) {
      const targetPortStr = String(this.client.config.server.port);
      this.serverPortText.setValue(targetPortStr);
    }
  }

  public display(): void {
    this.statusUnsubscribe?.();
    this.statusUnsubscribe = undefined;
    this.isPortInputFocused = false;
    this.portDraftInvalid = false;

    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "🧠 Lernstoff Wiki - Configuration Cockpit" });
    containerEl.createEl("p", {
      text: "Headless cognitive selective note-taking engine with zero-config out-of-the-box defaults. Single source of truth backed by .lernstoff/config.json.",
      cls: "setting-item-description",
    });

    // =========================================================================
    // Module 1: Daemon & OS Boot Auto-Start Control
    // =========================================================================
    containerEl.createEl("h3", { text: "1. Daemon & OS Boot Auto-Start" });

    const runDaemonAction = async (fn: () => Promise<void>) => {
      if (this.isActionInFlight) return;
      this.isActionInFlight = true;
      this.syncDaemonStatusUi();
      try {
        await fn();
      } finally {
        this.isActionInFlight = false;
        this.portDraftInvalid = false;
        this.syncDaemonStatusUi();
      }
    };

    this.daemonStatusSetting = new Setting(containerEl)
      .setName("Daemon Service Status")
      .setDesc(this.computeStatusDesc())
      .addButton((btn) => {
        this.startBtn = btn;
        return btn
          .setButtonText("Start")
          .setCta()
          .setDisabled(this.isActionInFlight || this.client.isRunning)
          .onClick(async () => {
            await runDaemonAction(async () => {
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
                new Notice(
                  "❌ Failed to start Lernstoff Daemon. Check logs in .lernstoff/daemon.log",
                );
              }
            });
          });
      })
      .addButton((btn) => {
        this.restartBtn = btn;
        return btn
          .setButtonText("Restart")
          .setDisabled(this.isActionInFlight)
          .onClick(async () => {
            await runDaemonAction(async () => {
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
                new Notice("❌ Failed to restart Lernstoff Daemon.");
              }
            });
          });
      })
      .addButton((btn) => {
        this.stopBtn = btn;
        return btn
          .setButtonText("Stop")
          .setWarning()
          .setDisabled(this.isActionInFlight || !this.client.isRunning)
          .onClick(async () => {
            await runDaemonAction(async () => {
              const ok = await this.client.stopDaemon();
              if (ok) {
                new Notice("🛑 Stopped Lernstoff Daemon.");
              } else {
                new Notice("❌ Failed to stop Lernstoff Daemon.");
              }
            });
          });
      });

    new Setting(containerEl)
      .setName("Auto-Start on Obsidian Open")
      .setDesc("Automatically start the background daemon when this Vault is opened in Obsidian.")
      .addToggle((toggle) =>
        toggle.setValue(this.client.config.server.autoStartOnObsidianOpen).onChange((val) => {
          this.client.config.server.autoStartOnObsidianOpen = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName("OS Boot Auto-Start")
      .setDesc(
        "Register daemon as macOS LaunchAgent / Linux systemd user service to start on system boot.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.client.config.server.autoStartOnBoot).onChange(async (val) => {
          if (val) {
            await this.client.installService();
            new Notice("Registered OS Boot Auto-Start.");
          } else {
            await this.client.uninstallService();
            new Notice("Unregistered OS Boot Auto-Start.");
          }
        }),
      );

    new Setting(containerEl)
      .setName("Server Port")
      .setDesc("Default HTTP port for daemon and MCP (auto-increments if busy).")
      .addText((text) => {
        this.serverPortText = text;
        text.setValue(String(this.client.config.server.port)).onChange((val) => {
          const validPort = parseValidPort(val);
          if (validPort !== null) {
            this.portDraftInvalid = false;
            if (this.client.config.server.port !== validPort) {
              this.client.config.server.port = validPort;
              this.client.updateConfig(this.client.config);
            }
          } else {
            this.portDraftInvalid = true;
          }
        });

        const inputEl = (text as any).inputEl;
        if (inputEl && typeof inputEl.addEventListener === "function") {
          inputEl.addEventListener("focus", () => {
            this.isPortInputFocused = true;
          });
          inputEl.addEventListener("blur", () => {
            this.isPortInputFocused = false;
            const invalidDom =
              typeof inputEl.value === "string" && parseValidPort(inputEl.value) === null;
            if (this.portDraftInvalid || invalidDom) {
              this.portDraftInvalid = false;
              const safeVal = String(this.client.config.server.port);
              text.setValue(safeVal);
              if (typeof inputEl.value === "string") {
                inputEl.value = safeVal;
              }
              new Notice("⚠️ Invalid Server Port: enter an integer between 1024 and 65535.");
            }
          });
        }
        return text;
      });

    this.statusUnsubscribe = this.client.onStatus(() => {
      this.syncDaemonStatusUi();
    });

    new Setting(containerEl)
      .setName("CLI Executable Path")
      .setDesc("Optional override path to the lernstoff binary executable.")
      .addText((text) =>
        text.setValue(this.client.cliPathOverride || "").onChange((val) => {
          this.client.cliPathOverride = val.trim() || undefined;
        }),
      );

    // =========================================================================
    // Module 2: AI Agent One-Click Integration
    // =========================================================================
    containerEl.createEl("h3", { text: "2. AI Programming Agent Integration" });

    new Setting(containerEl)
      .setName("One-Click MCP & SKILL.md Installation")
      .setDesc(
        "Inject cognitive selective note-taking protocol (SKILL.md) and MCP config into coding agents.",
      )
      .addButton((btn) =>
        btn.setButtonText("Claude Code").onClick(async () => {
          await this.client.installAgent("claude");
          new Notice("Injected SKILL.md and MCP to Claude Code config");
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Cursor").onClick(async () => {
          await this.client.installAgent("cursor");
          new Notice("Injected SKILL.md and MCP to Cursor config");
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Antigravity").onClick(async () => {
          await this.client.installAgent("antigravity");
          new Notice("Injected SKILL.md and MCP to Antigravity config");
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Copy MCP JSON")
          .setCta()
          .onClick(() => {
            const mcpJson = JSON.stringify(
              {
                mcpServers: {
                  lernstoff: {
                    command: "lernstoff",
                    args: ["mcp", "--vault", this.client.vaultPath],
                  },
                },
              },
              null,
              2,
            );
            navigator.clipboard.writeText(mcpJson);
            new Notice("Copied MCP JSON to clipboard!");
          }),
      );

    // =========================================================================
    // Module 3: QMD Local Models & Maintenance
    // =========================================================================
    containerEl.createEl("h3", { text: "3. QMD Models & Storage" });

    new Setting(containerEl)
      .setName("Embed Model URI")
      .setDesc("GGUF model URI for vector embeddings (default: embeddinggemma-300M-Q8_0).")
      .addText((text) =>
        text.setValue(this.client.config.models.embed).onChange((val) => {
          this.client.config.models.embed = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName("Rerank Model URI")
      .setDesc(
        "Cross-Encoder GGUF URI for Gate 2 & Gate 3 reranking (default: Qwen3-Reranker-0.6B).",
      )
      .addText((text) =>
        text.setValue(this.client.config.models.rerank).onChange((val) => {
          this.client.config.models.rerank = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName("Generate Model URI")
      .setDesc("Local generation model URI for synthesis (optional).")
      .addText((text) =>
        text.setValue(this.client.config.models.generate).onChange((val) => {
          this.client.config.models.generate =
            val.trim() || DEFAULT_LERNSTOFF_CONFIG.models.generate;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName("QMD Inactivity Timeout (ms)")
      .setDesc("Idle time in milliseconds before unloading native llama.cpp model context.")
      .addText((text) =>
        text.setValue(String(this.client.config.models.inactivityTimeoutMs)).onChange((val) => {
          const timeout = parseInt(val, 10);
          if (timeout >= 1000) {
            this.client.config.models.inactivityTimeoutMs = timeout;
            this.client.updateConfig(this.client.config);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Storage Maintenance & Index Synchronization")
      .setDesc(
        "Maintain QMD vector/keyword index, pull models, and clean up decayed scratchpad entries.",
      )
      .addButton((btn) =>
        btn.setButtonText("Update Index").onClick(async () => {
          new Notice("Updating QMD index...");
          await this.client.updateIndex();
          new Notice("✅ QMD index update triggered.");
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Pull Models").onClick(async () => {
          new Notice("Pulling QMD models...");
          await this.client.runCli(["doctor", "--pull-models", "--vault", this.client.vaultPath]);
          new Notice("✅ QMD model verification completed.");
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Cleanup Orphans & Decayed").onClick(async () => {
          new Notice("Cleaning up orphans and expired scratchpad entries...");
          await this.client.cleanupOrphans();
          new Notice("✅ Cleanup completed.");
        }),
      );

    // =========================================================================
    // Module 4: Hippocampal Gate & Scratchpad Sliders
    // =========================================================================
    containerEl.createEl("h3", { text: "4. Cognitive Gate & Memory Thresholds" });

    new Setting(containerEl)
      .setName(`Gate 2 Inquiry Off-Topic Cutoff (τ_off: ${this.client.config.gate.tauOff})`)
      .setDesc("Candidates below this cross-encoder score are silently discarded (< 0.35).")
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 0.8, 0.05)
          .setValue(this.client.config.gate.tauOff)
          .onChange((val) => {
            this.client.config.gate.tauOff = val;
            this.client.updateConfig(this.client.config);
          }),
      );

    new Setting(containerEl)
      .setName(`Gate 2 Inquiry Core Pass Cutoff (τ_core: ${this.client.config.gate.tauCore})`)
      .setDesc("Candidates between τ_off and τ_core defer to scratchpad; >= τ_core enter Gate 3.")
      .addSlider((slider) =>
        slider
          .setLimits(0.4, 0.9, 0.05)
          .setValue(this.client.config.gate.tauCore)
          .onChange((val) => {
            this.client.config.gate.tauCore = val;
            this.client.updateConfig(this.client.config);
          }),
      );

    new Setting(containerEl)
      .setName(`Gate 3 Redundant Similarity (S_sem: ${this.client.config.gate.maxSemRedundant})`)
      .setDesc("Propositions with semantic similarity >= this and low novelty are discarded.")
      .addSlider((slider) =>
        slider
          .setLimits(0.6, 0.95, 0.02)
          .setValue(this.client.config.gate.maxSemRedundant)
          .onChange((val) => {
            this.client.config.gate.maxSemRedundant = val;
            this.client.updateConfig(this.client.config);
          }),
      );

    new Setting(containerEl)
      .setName(`Gate 3 Minimum Lexical Novelty (Δ_lex: ${this.client.config.gate.minLexNovelty})`)
      .setDesc("Threshold for n-gram lexical novelty before proposition is accepted.")
      .addSlider((slider) =>
        slider
          .setLimits(0.05, 0.6, 0.05)
          .setValue(this.client.config.gate.minLexNovelty)
          .onChange((val) => {
            this.client.config.gate.minLexNovelty = val;
            this.client.updateConfig(this.client.config);
          }),
      );

    new Setting(containerEl)
      .setName(`Socratic Min Outbound Links (${this.client.config.socratic.minOutboundLinks})`)
      .setDesc("Minimum outbound proposition links required for crystallized notes.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 5, 1)
          .setValue(this.client.config.socratic.minOutboundLinks)
          .onChange((val) => {
            this.client.config.socratic.minOutboundLinks = val;
            this.client.updateConfig(this.client.config);
          }),
      );

    new Setting(containerEl)
      .setName(`Scratchpad Retention (TTL Days: ${this.client.config.scratchpad.ttlDays})`)
      .setDesc("Number of days unreferenced scratchpad entries survive before GC archival.")
      .addSlider((slider) =>
        slider
          .setLimits(3, 60, 1)
          .setValue(this.client.config.scratchpad.ttlDays)
          .onChange((val) => {
            this.client.config.scratchpad.ttlDays = val;
            this.client.updateConfig(this.client.config);
          }),
      );

    new Setting(containerEl)
      .setName(`Scratchpad Promotion Hit Count (${this.client.config.scratchpad.promoteHitCount})`)
      .setDesc("Collision count required across distinct sources to trigger proposition promotion.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(this.client.config.scratchpad.promoteHitCount)
          .onChange((val) => {
            this.client.config.scratchpad.promoteHitCount = val;
            this.client.updateConfig(this.client.config);
          }),
      );

    new Setting(containerEl)
      .setName("Reset Gate to Factory Defaults")
      .setDesc("Restore all cognitive gate sliders and thresholds to factory values.")
      .addButton((btn) =>
        btn.setButtonText("Reset to Defaults").onClick(() => {
          this.client.config.gate = structuredClone(DEFAULT_LERNSTOFF_CONFIG.gate);
          this.client.config.socratic = structuredClone(DEFAULT_LERNSTOFF_CONFIG.socratic);
          this.client.config.scratchpad = structuredClone(DEFAULT_LERNSTOFF_CONFIG.scratchpad);
          this.client.updateConfig(this.client.config);
          new Notice("Gate thresholds reset to defaults.");
          this.display();
        }),
      );

    // =========================================================================
    // Module 5: Vault Folder & File Mapping
    // =========================================================================
    containerEl.createEl("h3", { text: "5. Vault Folder & File Mapping" });

    new Setting(containerEl)
      .setName("Inquiries File")
      .setDesc("Relative path to the curiosity question tree.")
      .addText((text) =>
        text.setValue(this.client.config.paths.inquiriesFile).onChange((val) => {
          this.client.config.paths.inquiriesFile = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName("Scratchpad File")
      .setDesc("Relative path to the fast scratchpad buffer.")
      .addText((text) =>
        text.setValue(this.client.config.paths.scratchpadFile).onChange((val) => {
          this.client.config.paths.scratchpadFile = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName("Concepts Directory")
      .setDesc("Relative folder for evergreen proposition notes.")
      .addText((text) =>
        text.setValue(this.client.config.paths.conceptsDir).onChange((val) => {
          this.client.config.paths.conceptsDir = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName("Wiki Directory")
      .setDesc("Relative root folder for all synthesized wiki content.")
      .addText((text) =>
        text.setValue(this.client.config.paths.wikiDir).onChange((val) => {
          this.client.config.paths.wikiDir = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName("Index File")
      .setDesc("Relative path to global constellation index.")
      .addText((text) =>
        text.setValue(this.client.config.paths.indexFile).onChange((val) => {
          this.client.config.paths.indexFile = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName("Log File")
      .setDesc("Relative path to cognitive event and gate audit log.")
      .addText((text) =>
        text.setValue(this.client.config.paths.logFile).onChange((val) => {
          this.client.config.paths.logFile = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    // =========================================================================
    // Recent daemon logs viewer & Log Management
    // =========================================================================
    const logPath = join(this.client.vaultPath, LERNSTOFF_DIR, "daemon.log");
    if (existsSync(logPath)) {
      containerEl.createEl("h3", { text: "Recent Daemon Logs" });

      new Setting(containerEl)
        .setName("Clear Daemon Logs")
        .setDesc("Truncate .lernstoff/daemon.log file.")
        .addButton((btn) =>
          btn
            .setButtonText("Clear Logs")
            .setWarning()
            .onClick(() => {
              try {
                writeFileSync(logPath, "", "utf-8");
                new Notice("Cleared daemon.log");
                this.display();
              } catch (e: any) {
                new Notice(`Failed to clear log: ${e.message}`);
              }
            }),
        );

      const logContent = readFileSync(logPath, "utf-8").split("\n").slice(-25).join("\n");
      const pre = containerEl.createEl("pre", { cls: "lernstoff-log-viewer" });
      pre.setText(logContent || "(Log file is empty)");
    }
  }
}
