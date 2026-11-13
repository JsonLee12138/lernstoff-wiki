import { App, PluginSettingTab, Plugin, Setting, Notice } from "obsidian";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LERNSTOFF_CONFIG, LERNSTOFF_DIR } from "@lernstoff/core/config";
import type { DaemonClient } from "./daemon-client.js";
import { t } from "./i18n.js";

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
      return t("settings.daemon.statusStopped");
    }
    const pid = this.client.pid || t("settings.daemon.pidUnknown");
    const base = t("settings.daemon.statusRunning", { port: this.client.port, pid });
    if (
      this.client.lastPortFallback &&
      this.client.lastPortFallback.actualPort === this.client.port
    ) {
      const { requestedPort, actualPort } = this.client.lastPortFallback;
      return `${base}${t("settings.daemon.statusFallbackSuffix", { requestedPort, actualPort })}`;
    }
    if (this.client.config.server.port !== this.client.port) {
      return `${base}${t("settings.daemon.statusPendingRestartSuffix", { port: this.client.config.server.port })}`;
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

    containerEl.createEl("h2", { text: t("settings.header.title") });
    containerEl.createEl("p", {
      text: t("settings.header.description"),
      cls: "setting-item-description",
    });

    // =========================================================================
    // Module 1: Daemon & OS Boot Auto-Start Control
    // =========================================================================
    containerEl.createEl("h3", { text: t("settings.daemon.moduleTitle") });

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
      .setName(t("settings.daemon.serviceStatus"))
      .setDesc(this.computeStatusDesc())
      .addButton((btn) => {
        this.startBtn = btn;
        return btn
          .setButtonText(t("settings.daemon.start"))
          .setCta()
          .setDisabled(this.isActionInFlight || this.client.isRunning)
          .onClick(async () => {
            await runDaemonAction(async () => {
              new Notice(t("notices.daemonStarting"));
              const ok = await this.client.startDaemon();
              if (ok) {
                if (this.client.lastPortFallback) {
                  const { requestedPort, actualPort } = this.client.lastPortFallback;
                  new Notice(t("notices.daemonPortFallback", { requestedPort, actualPort }));
                } else {
                  new Notice(t("notices.daemonOnline"));
                }
              } else {
                new Notice(t("notices.daemonStartFailed"));
              }
            });
          });
      })
      .addButton((btn) => {
        this.restartBtn = btn;
        return btn
          .setButtonText(t("settings.daemon.restart"))
          .setDisabled(this.isActionInFlight)
          .onClick(async () => {
            await runDaemonAction(async () => {
              new Notice(t("notices.daemonRestarting"));
              const ok = await this.client.restartDaemon();
              if (ok) {
                if (this.client.lastPortFallback) {
                  const { requestedPort, actualPort } = this.client.lastPortFallback;
                  new Notice(t("notices.daemonPortFallback", { requestedPort, actualPort }));
                } else {
                  new Notice(t("notices.daemonOnline"));
                }
              } else {
                new Notice(t("notices.daemonRestartFailedTab"));
              }
            });
          });
      })
      .addButton((btn) => {
        this.stopBtn = btn;
        return btn
          .setButtonText(t("settings.daemon.stop"))
          .setWarning()
          .setDisabled(this.isActionInFlight || !this.client.isRunning)
          .onClick(async () => {
            await runDaemonAction(async () => {
              const ok = await this.client.stopDaemon();
              if (ok) {
                new Notice(t("notices.daemonStopped"));
              } else {
                new Notice(t("notices.daemonStopFailed"));
              }
            });
          });
      });

    new Setting(containerEl)
      .setName(t("settings.daemon.autoStartObsidianName"))
      .setDesc(t("settings.daemon.autoStartObsidianDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.client.config.server.autoStartOnObsidianOpen).onChange((val) => {
          this.client.config.server.autoStartOnObsidianOpen = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.daemon.autoStartBootName"))
      .setDesc(t("settings.daemon.autoStartBootDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.client.config.server.autoStartOnBoot).onChange(async (val) => {
          await runDaemonAction(async () => {
            if (val) {
              const res = await this.client.installService();
              if (res.success) {
                new Notice(t("notices.registeredBootAutoStart"));
              } else {
                toggle.setValue(false);
                new Notice(t("notices.registerBootAutoStartFailed", { error: res.error }));
              }
            } else {
              const res = await this.client.uninstallService();
              if (res.success) {
                new Notice(t("notices.unregisteredBootAutoStart"));
              } else {
                toggle.setValue(true);
                new Notice(t("notices.unregisterBootAutoStartFailed", { error: res.error }));
              }
            }
          });
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.daemon.serverPortName"))
      .setDesc(t("settings.daemon.serverPortDesc"))
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
          inputEl.addEventListener("blur", async () => {
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
              new Notice(t("notices.invalidServerPort"));
              return;
            }
            if (this.client.isRunning && this.client.config.server.port !== this.client.port) {
              await runDaemonAction(async () => {
                new Notice(t("notices.daemonRestarting"));
                await this.client.stopDaemon();
                this.client.updateConfig(this.client.config);
                const ok = await this.client.startDaemon();
                if (ok) {
                  new Notice(t("notices.daemonOnline"));
                } else {
                  new Notice(t("notices.daemonRestartFailedTab"));
                }
              });
            }
          });
        }
        return text;
      });

    this.statusUnsubscribe = this.client.onStatus(() => {
      this.syncDaemonStatusUi();
    });

    const effectiveCliPath = this.client.cliPathOverride || this.client.getDetectedCliPath();
    if (effectiveCliPath) {
      new Setting(containerEl)
        .setName(t("settings.daemon.cliPathName"))
        .setDesc(t("settings.daemon.cliPathDesc"))
        .addText((text) =>
          text.setValue(effectiveCliPath).onChange((val) => {
            this.client.cliPathOverride = val.trim() || undefined;
          }),
        );
    }

    // =========================================================================
    // Module 2: AI Agent One-Click Integration
    // =========================================================================
    containerEl.createEl("h3", { text: t("settings.agents.moduleTitle") });

    new Setting(containerEl)
      .setName(t("settings.agents.oneClickName"))
      .setDesc(t("settings.agents.oneClickDesc"))
      .addButton((btn) =>
        btn.setButtonText(t("settings.agents.claudeCode")).onClick(async () => {
          const res = await this.client.installAgent("claude");
          new Notice(
            res.success
              ? t("notices.injectedClaudeCode")
              : t("notices.injectClaudeCodeFailed", { error: res.error }),
          );
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t("settings.agents.cursor")).onClick(async () => {
          const res = await this.client.installAgent("cursor");
          new Notice(
            res.success
              ? t("notices.injectedCursor")
              : t("notices.injectCursorFailed", { error: res.error }),
          );
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t("settings.agents.antigravity")).onClick(async () => {
          const res = await this.client.installAgent("antigravity");
          new Notice(
            res.success
              ? t("notices.injectedAntigravity")
              : t("notices.injectAntigravityFailed", { error: res.error }),
          );
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.agents.copyMcpJson"))
          .setCta()
          .onClick(() => {
            const mcpJson = JSON.stringify(
              {
                mcpServers: {
                  lernstoff: this.client.getMcpEntry(),
                },
              },
              null,
              2,
            );
            navigator.clipboard.writeText(mcpJson);
            new Notice(t("notices.copiedMcpJson"));
          }),
      );

    // =========================================================================
    // Module 3: QMD Local Models & Maintenance
    // =========================================================================
    containerEl.createEl("h3", { text: t("settings.qmd.moduleTitle") });

    new Setting(containerEl)
      .setName(t("settings.qmd.embedModelName"))
      .setDesc(t("settings.qmd.embedModelDesc"))
      .addText((text) =>
        text.setValue(this.client.config.models.embed).onChange((val) => {
          this.client.config.models.embed = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.qmd.rerankModelName"))
      .setDesc(t("settings.qmd.rerankModelDesc"))
      .addText((text) =>
        text.setValue(this.client.config.models.rerank).onChange((val) => {
          this.client.config.models.rerank = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.qmd.generateModelName"))
      .setDesc(t("settings.qmd.generateModelDesc"))
      .addText((text) =>
        text.setValue(this.client.config.models.generate).onChange((val) => {
          this.client.config.models.generate =
            val.trim() || DEFAULT_LERNSTOFF_CONFIG.models.generate;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.qmd.inactivityTimeoutName"))
      .setDesc(t("settings.qmd.inactivityTimeoutDesc"))
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
      .setName(t("settings.qmd.maintenanceName"))
      .setDesc(t("settings.qmd.maintenanceDesc"))
      .addButton((btn) =>
        btn.setButtonText(t("settings.qmd.updateIndex")).onClick(async () => {
          new Notice(t("notices.updatingIndex"));
          const res = await this.client.updateIndex();
          if (res.success) {
            new Notice(t("notices.updateIndexCompleted"));
          } else {
            new Notice(t("notices.updateIndexFailed", { error: res.error }));
          }
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t("settings.qmd.pullModels")).onClick(async () => {
          new Notice(t("notices.pullingModels"));
          const res = await this.client.runCli([
            "doctor",
            "--pull-models",
            "--vault",
            this.client.vaultPath,
          ]);
          if (res.code === 0) {
            new Notice(t("notices.pullModelsCompleted"));
          } else {
            new Notice(
              t("notices.pullModelsFailed", {
                error:
                  res.stderr.trim() ||
                  res.stdout.trim() ||
                  t("settings.qmd.exitCode", { code: res.code }),
              }),
            );
          }
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t("settings.qmd.cleanupOrphans")).onClick(async () => {
          new Notice(t("notices.cleaningOrphans"));
          const res = await this.client.cleanupOrphans();
          if (res.success) {
            new Notice(t("notices.cleanupCompleted"));
          } else {
            new Notice(t("notices.cleanupFailed", { error: res.error }));
          }
        }),
      );

    // =========================================================================
    // Module 4: Hippocampal Gate & Scratchpad Sliders
    // =========================================================================
    containerEl.createEl("h3", { text: t("settings.gates.moduleTitle") });

    new Setting(containerEl)
      .setName(t("settings.gates.gate2TauOffName", { value: this.client.config.gate.tauOff }))
      .setDesc(t("settings.gates.gate2TauOffDesc"))
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
      .setName(t("settings.gates.gate2TauCoreName", { value: this.client.config.gate.tauCore }))
      .setDesc(t("settings.gates.gate2TauCoreDesc"))
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
      .setName(
        t("settings.gates.gate3MaxSemName", { value: this.client.config.gate.maxSemRedundant }),
      )
      .setDesc(t("settings.gates.gate3MaxSemDesc"))
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
      .setName(
        t("settings.gates.gate3MinLexName", { value: this.client.config.gate.minLexNovelty }),
      )
      .setDesc(t("settings.gates.gate3MinLexDesc"))
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
      .setName(
        t("settings.gates.socraticMinLinksName", {
          value: this.client.config.socratic.minOutboundLinks,
        }),
      )
      .setDesc(t("settings.gates.socraticMinLinksDesc"))
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
      .setName(
        t("settings.gates.scratchpadTtlDaysName", { value: this.client.config.scratchpad.ttlDays }),
      )
      .setDesc(t("settings.gates.scratchpadTtlDaysDesc"))
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
      .setName(
        t("settings.gates.scratchpadPromoteHitCountName", {
          value: this.client.config.scratchpad.promoteHitCount,
        }),
      )
      .setDesc(t("settings.gates.scratchpadPromoteHitCountDesc"))
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
      .setName(t("settings.gates.resetName"))
      .setDesc(t("settings.gates.resetDesc"))
      .addButton((btn) =>
        btn.setButtonText(t("settings.gates.resetBtn")).onClick(() => {
          this.client.config.gate = structuredClone(DEFAULT_LERNSTOFF_CONFIG.gate);
          this.client.config.socratic = structuredClone(DEFAULT_LERNSTOFF_CONFIG.socratic);
          this.client.config.scratchpad = structuredClone(DEFAULT_LERNSTOFF_CONFIG.scratchpad);
          this.client.updateConfig(this.client.config);
          new Notice(t("notices.gateResetToDefaults"));
          this.display();
        }),
      );

    // =========================================================================
    // Module 5: Vault Folder & File Mapping
    // =========================================================================
    containerEl.createEl("h3", { text: t("settings.paths.moduleTitle") });

    new Setting(containerEl)
      .setName(t("settings.paths.inquiriesFileName"))
      .setDesc(t("settings.paths.inquiriesFileDesc"))
      .addText((text) =>
        text.setValue(this.client.config.paths.inquiriesFile).onChange((val) => {
          this.client.config.paths.inquiriesFile = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.paths.scratchpadFileName"))
      .setDesc(t("settings.paths.scratchpadFileDesc"))
      .addText((text) =>
        text.setValue(this.client.config.paths.scratchpadFile).onChange((val) => {
          this.client.config.paths.scratchpadFile = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.paths.conceptsDirName"))
      .setDesc(t("settings.paths.conceptsDirDesc"))
      .addText((text) =>
        text.setValue(this.client.config.paths.conceptsDir).onChange((val) => {
          this.client.config.paths.conceptsDir = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.paths.wikiDirName"))
      .setDesc(t("settings.paths.wikiDirDesc"))
      .addText((text) =>
        text.setValue(this.client.config.paths.wikiDir).onChange((val) => {
          this.client.config.paths.wikiDir = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.paths.indexFileName"))
      .setDesc(t("settings.paths.indexFileDesc"))
      .addText((text) =>
        text.setValue(this.client.config.paths.indexFile).onChange((val) => {
          this.client.config.paths.indexFile = val;
          this.client.updateConfig(this.client.config);
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.paths.logFileName"))
      .setDesc(t("settings.paths.logFileDesc"))
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
      containerEl.createEl("h3", { text: t("settings.logs.moduleTitle") });

      new Setting(containerEl)
        .setName(t("settings.logs.clearName"))
        .setDesc(t("settings.logs.clearDesc"))
        .addButton((btn) =>
          btn
            .setButtonText(t("settings.logs.clearBtn"))
            .setWarning()
            .onClick(() => {
              try {
                writeFileSync(logPath, "", "utf-8");
                new Notice(t("notices.clearedLog"));
                this.display();
              } catch (e: any) {
                new Notice(t("notices.failedToClearLog", { error: e.message }));
              }
            }),
        );

      const logContent = readFileSync(logPath, "utf-8").split("\n").slice(-25).join("\n");
      const pre = containerEl.createEl("pre", { cls: "lernstoff-log-viewer" });
      pre.setText(logContent || t("settings.logs.empty"));
    }
  }
}
