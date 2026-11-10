import { App, PluginSettingTab, Plugin, Setting, Notice } from "obsidian";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LERNSTOFF_CONFIG, LERNSTOFF_DIR } from "@lernstoff/core/config";
import type { DaemonClient } from "./daemon-client.js";

export class LernstoffSettingsTab extends PluginSettingTab {
  private client: DaemonClient;

  constructor(app: App, plugin: Plugin, client: DaemonClient) {
    super(app, plugin);
    this.client = client;
  }

  public display(): void {
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

    const statusDesc = this.client.isRunning
      ? `🟢 Running on http://127.0.0.1:${this.client.port} (PID ${this.client.pid || "unknown"})`
      : "⚪ Daemon Stopped";

    new Setting(containerEl)
      .setName("Daemon Service Status")
      .setDesc(statusDesc)
      .addButton((btn) =>
        btn
          .setButtonText("Start")
          .setCta()
          .setDisabled(this.client.isRunning)
          .onClick(async () => {
            await this.client.startDaemon();
            new Notice("Starting Lernstoff Daemon...");
            setTimeout(() => this.display(), 1000);
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Restart").onClick(async () => {
          await this.client.restartDaemon();
          new Notice("Restarted Lernstoff Daemon.");
          setTimeout(() => this.display(), 1200);
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Stop")
          .setWarning()
          .setDisabled(!this.client.isRunning)
          .onClick(async () => {
            await this.client.stopDaemon();
            new Notice("Stopped Lernstoff Daemon.");
            this.display();
          }),
      );

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
          this.client.config.server.autoStartOnBoot = val;
          this.client.updateConfig(this.client.config);
          new Notice(val ? "Registered OS Boot Auto-Start." : "Unregistered OS Boot Auto-Start.");
        }),
      );

    new Setting(containerEl)
      .setName("Server Port")
      .setDesc("Default HTTP port for daemon and MCP (auto-increments if busy).")
      .addText((text) =>
        text.setValue(String(this.client.config.server.port)).onChange((val) => {
          const p = parseInt(val, 10);
          if (p > 0 && p < 65536) {
            this.client.config.server.port = p;
            this.client.updateConfig(this.client.config);
          }
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
        btn.setButtonText("Claude Code").onClick(() => {
          new Notice("Injected SKILL.md and MCP to ~/.claude.json");
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Cursor").onClick(() => {
          new Notice("Injected SKILL.md and MCP to .cursor/mcp.json");
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Antigravity").onClick(() => {
          new Notice("Injected SKILL.md and MCP to ~/.gemini/antigravity/");
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
      .setName("Reset Gate to Factory Defaults")
      .setDesc("Restore all cognitive gate sliders and thresholds to factory values.")
      .addButton((btn) =>
        btn.setButtonText("Reset to Defaults").onClick(() => {
          this.client.config.gate = { ...DEFAULT_LERNSTOFF_CONFIG.gate };
          this.client.config.socratic = { ...DEFAULT_LERNSTOFF_CONFIG.socratic };
          this.client.config.scratchpad = { ...DEFAULT_LERNSTOFF_CONFIG.scratchpad };
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

    // Recent daemon logs viewer
    const logPath = join(this.client.vaultPath, LERNSTOFF_DIR, "daemon.log");
    if (existsSync(logPath)) {
      containerEl.createEl("h3", { text: "Recent Daemon Logs" });
      const logContent = readFileSync(logPath, "utf-8").split("\n").slice(-25).join("\n");
      const pre = containerEl.createEl("pre", { cls: "lernstoff-log-viewer" });
      pre.setText(logContent || "(Log file is empty)");
    }
  }
}
