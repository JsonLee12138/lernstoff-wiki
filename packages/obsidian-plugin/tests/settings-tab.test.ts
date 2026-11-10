import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault, DEFAULT_LERNSTOFF_CONFIG, LERNSTOFF_DIR } from "@lernstoff/core";

// Mock obsidian classes
vi.mock("obsidian", () => {
  class MockSetting {
    containerEl: any;
    name = "";
    desc = "";
    elements: any[] = [];
    constructor(containerEl: any) {
      this.containerEl = containerEl;
      if (containerEl && containerEl.settings) {
        containerEl.settings.push(this);
      }
    }
    setName(name: string) {
      this.name = name;
      return this;
    }
    setDesc(desc: string) {
      this.desc = desc;
      return this;
    }
    addButton(cb: (btn: any) => any) {
      const btn = {
        text: "",
        disabled: false,
        isCta: false,
        isWarning: false,
        onClickHandler: null as any,
        setButtonText(t: string) {
          this.text = t;
          return this;
        },
        setCta() {
          this.isCta = true;
          return this;
        },
        setWarning() {
          this.isWarning = true;
          return this;
        },
        setDisabled(d: boolean) {
          this.disabled = d;
          return this;
        },
        onClick(fn: any) {
          this.onClickHandler = fn;
          return this;
        },
      };
      cb(btn);
      this.elements.push(btn);
      return this;
    }
    addToggle(cb: (t: any) => any) {
      const toggle = {
        val: false,
        changeHandler: null as any,
        setValue(v: boolean) {
          this.val = v;
          return this;
        },
        onChange(fn: any) {
          this.changeHandler = fn;
          return this;
        },
      };
      cb(toggle);
      this.elements.push(toggle);
      return this;
    }
    addText(cb: (t: any) => any) {
      const text = {
        val: "",
        changeHandler: null as any,
        setValue(v: string) {
          this.val = v;
          return this;
        },
        onChange(fn: any) {
          this.changeHandler = fn;
          return this;
        },
      };
      cb(text);
      this.elements.push(text);
      return this;
    }
    addSlider(cb: (s: any) => any) {
      const slider = {
        val: 0,
        min: 0,
        max: 1,
        step: 0.1,
        changeHandler: null as any,
        setLimits(min: number, max: number, step: number) {
          this.min = min;
          this.max = max;
          this.step = step;
          return this;
        },
        setValue(v: number) {
          this.val = v;
          return this;
        },
        onChange(fn: any) {
          this.changeHandler = fn;
          return this;
        },
      };
      cb(slider);
      this.elements.push(slider);
      return this;
    }
  }

  class MockPluginSettingTab {
    app: any;
    plugin: any;
    containerEl: any;
    constructor(app: any, plugin: any) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = {
        elements: [] as any[],
        settings: [] as any[],
        empty() {
          this.elements = [];
          this.settings = [];
        },
        createEl(tag: string, attrs?: any) {
          const el = {
            tagName: tag,
            attrs,
            text: attrs?.text ?? "",
            cls: attrs?.cls ?? "",
            setText(t: string) {
              this.text = t;
            },
          };
          this.elements.push(el);
          return el;
        },
      };
    }
  }

  class MockNotice {
    static lastNotice: string | null = null;
    constructor(public message: string) {
      MockNotice.lastNotice = message;
    }
  }

  return {
    PluginSettingTab: MockPluginSettingTab,
    Setting: MockSetting,
    Notice: MockNotice,
    App: class {},
  };
});

import { DaemonClient } from "../src/daemon-client.js";
import { LernstoffSettingsTab } from "../src/settings-tab.js";

describe("Obsidian Plugin SettingsTab (5 Visual Modules)", () => {
  let tempDir: string;
  let client: DaemonClient;
  let tab: LernstoffSettingsTab;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-settings-test-"));
    await initVault(tempDir);
    client = new DaemonClient(tempDir);
    const mockApp = {} as any;
    const mockPlugin = { manifest: { id: "lernstoff-wiki" } } as any;
    tab = new LernstoffSettingsTab(mockApp, mockPlugin, client);
  });

  afterEach(() => {
    client.destroy();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("renders all 5 visual modules cleanly without throwing", () => {
    tab.display();

    const headings = tab.containerEl.elements
      .filter((el: any) => el.tagName === "h3")
      .map((el: any) => el.text);

    expect(headings).toContain("1. Daemon & OS Boot Auto-Start");
    expect(headings).toContain("2. AI Programming Agent Integration");
    expect(headings).toContain("3. QMD Models & Storage");
    expect(headings).toContain("4. Cognitive Gate & Memory Thresholds");
    expect(headings).toContain("5. Vault Folder & File Mapping");
  });

  it("modifies gate slider settings and persists to config.json", () => {
    tab.display();

    // Find Gate 2 tauOff slider
    const tauOffSetting = tab.containerEl.settings.find((s: any) =>
      s.name.includes("Gate 2 Inquiry Off-Topic Cutoff"),
    );
    expect(tauOffSetting).toBeDefined();
    const slider = tauOffSetting.elements[0];
    expect(slider.val).toBe(0.35);

    // Change tauOff
    slider.changeHandler(0.45);

    // Verify client config and file on disk updated
    expect(client.config.gate.tauOff).toBe(0.45);
    const diskConfig = client.loadLocalConfig();
    expect(diskConfig.gate.tauOff).toBe(0.45);
  });

  it("modifies server port and paths with validation and persists", () => {
    tab.display();

    // Find Server Port text
    const portSetting = tab.containerEl.settings.find((s: any) => s.name === "Server Port");
    expect(portSetting).toBeDefined();
    const portText = portSetting.elements[0];
    expect(portText.val).toBe("8188");

    portText.changeHandler("9090");
    expect(client.config.server.port).toBe(9090);

    // Find Concepts Directory text
    const conceptsSetting = tab.containerEl.settings.find(
      (s: any) => s.name === "Concepts Directory",
    );
    expect(conceptsSetting).toBeDefined();
    const conceptsText = conceptsSetting.elements[0];
    expect(conceptsText.val).toBe("wiki/concepts");

    conceptsText.changeHandler("notes/evergreen");
    expect(client.config.paths.conceptsDir).toBe("notes/evergreen");
    expect(client.loadLocalConfig().paths.conceptsDir).toBe("notes/evergreen");
  });

  it("resets gate thresholds back to factory defaults on button click", () => {
    // First modify gate settings
    client.config.gate.tauCore = 0.99;
    client.config.gate.tauOff = 0.55;
    client.updateConfig(client.config);
    expect(client.loadLocalConfig().gate.tauCore).toBe(0.99);

    tab.display();

    // Find Reset Gate button
    const resetSetting = tab.containerEl.settings.find(
      (s: any) => s.name === "Reset Gate to Factory Defaults",
    );
    expect(resetSetting).toBeDefined();
    const resetBtn = resetSetting.elements[0];
    resetBtn.onClickHandler();

    // Verify restored to DEFAULT_LERNSTOFF_CONFIG
    expect(client.config.gate.tauCore).toBe(DEFAULT_LERNSTOFF_CONFIG.gate.tauCore);
    expect(client.config.gate.tauOff).toBe(DEFAULT_LERNSTOFF_CONFIG.gate.tauOff);
    expect(client.loadLocalConfig().gate.tauCore).toBe(DEFAULT_LERNSTOFF_CONFIG.gate.tauCore);
  });

  it("renders recent daemon logs when daemon.log exists", () => {
    const logPath = join(tempDir, LERNSTOFF_DIR, "daemon.log");
    writeFileSync(logPath, "[2026-11-10T12:00:00.000Z] Daemon started on port 8188\n", "utf-8");

    tab.display();

    const logHeading = tab.containerEl.elements.find(
      (el: any) => el.tagName === "h3" && el.text === "Recent Daemon Logs",
    );
    expect(logHeading).toBeDefined();

    const logPre = tab.containerEl.elements.find(
      (el: any) => el.tagName === "pre" && el.cls === "lernstoff-log-viewer",
    );
    expect(logPre).toBeDefined();
    expect(logPre.text).toContain("Daemon started on port 8188");
  });
});
