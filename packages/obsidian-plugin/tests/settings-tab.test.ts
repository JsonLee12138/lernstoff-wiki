import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault, DEFAULT_LERNSTOFF_CONFIG, LERNSTOFF_DIR } from "@lernstoff/core";

const { getLanguageMock } = vi.hoisted(() => {
  return {
    getLanguageMock: vi.fn<[], string | undefined>(() => undefined),
  };
});

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
      const listeners = new Map<string, Array<(...args: any[]) => void>>();
      const inputEl = {
        value: "",
        addEventListener(evt: string, fn: (...args: any[]) => void) {
          const list = listeners.get(evt) || [];
          list.push(fn);
          listeners.set(evt, list);
        },
        dispatchEvent(evt: string) {
          for (const fn of listeners.get(evt) || []) {
            fn();
          }
        },
      };
      const text = {
        val: "",
        inputEl,
        changeHandler: null as any,
        setValue(v: string) {
          this.val = v;
          this.inputEl.value = v;
          return this;
        },
        onChange(fn: any) {
          this.changeHandler = (v: string) => {
            this.val = v;
            this.inputEl.value = v;
            return fn(v);
          };
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

  class MockPlugin {
    app: any;
    manifest: any;
    commands = new Map<string, any>();
    settingTabs: any[] = [];
    statusBarItems: any[] = [];
    constructor(app: any, manifest: any) {
      this.app = app;
      this.manifest = manifest;
    }
    addStatusBarItem() {
      const item = {
        text: "",
        title: "",
        classes: [] as string[],
        addClass(cls: string) {
          this.classes.push(cls);
        },
        setText(t: string) {
          this.text = t;
        },
        addEventListener() {},
      };
      this.statusBarItems.push(item);
      return item;
    }
    addSettingTab(t: any) {
      this.settingTabs.push(t);
    }
    addCommand(c: any) {
      this.commands.set(c.id, c);
      return c;
    }
  }

  class MockNotice {
    static lastNotice: string | null = null;
    static notices: string[] = [];
    constructor(public message: string) {
      MockNotice.lastNotice = message;
      MockNotice.notices.push(message);
    }
  }

  return {
    Plugin: MockPlugin,
    PluginSettingTab: MockPluginSettingTab,
    Setting: MockSetting,
    Notice: MockNotice,
    App: class {},
    getLanguage: () => getLanguageMock(),
  };
});

import { Notice } from "obsidian";
import { DaemonClient } from "../src/daemon-client.js";
import { LernstoffSettingsTab } from "../src/settings-tab.js";
import LernstoffPlugin from "../src/main.js";

describe("Obsidian Plugin SettingsTab (5 Visual Modules)", () => {
  let tempDir: string;
  let client: DaemonClient;
  let tab: LernstoffSettingsTab;

  beforeEach(async () => {
    (Notice as any).lastNotice = null;
    (Notice as any).notices = [];
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-settings-test-"));
    await initVault(tempDir);
    client = new DaemonClient(tempDir);
    const mockApp = {} as any;
    const mockPlugin = { manifest: { id: "lernstoff-wiki" } } as any;
    tab = new LernstoffSettingsTab(mockApp, mockPlugin, client);
  });

  afterEach(() => {
    getLanguageMock.mockReturnValue(undefined);
    (tab as any).hide?.();
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

  it("ignores partial/invalid port keystrokes without ZodError or config mutation, and reverts with Notice on blur (AC-1)", () => {
    tab.display();
    const portSetting = tab.containerEl.settings.find((s: any) => s.name === "Server Port");
    const portText = portSetting.elements[0];

    for (const bad of ["9", "80", "70000", "abc"]) {
      expect(() => portText.changeHandler(bad)).not.toThrow();
      expect(client.config.server.port).toBe(8188);
      expect(client.loadLocalConfig().server.port).toBe(8188);
    }

    portText.inputEl.dispatchEvent("blur");
    expect(portText.val).toBe("8188");
    expect(portText.inputEl.value).toBe("8188");
    expect((Notice as any).lastNotice).toMatch(/1024.*65535/);
  });

  it("updates button disabled states & status in-place via onStatus without clearing focused input, and unsubscribes on hide() (AC-4)", () => {
    tab.display();
    const statusSetting = tab.containerEl.settings.find(
      (s: any) => s.name === "Daemon Service Status",
    );
    const startBtn = statusSetting.elements.find((b: any) => b.text === "Start");
    const stopBtn = statusSetting.elements.find((b: any) => b.text === "Stop");
    const portSetting = tab.containerEl.settings.find((s: any) => s.name === "Server Port");
    const portText = portSetting.elements[0];

    expect(startBtn.disabled).toBe(false);
    expect(stopBtn.disabled).toBe(true);

    // Focus input and type partial digit "9"
    portText.inputEl.dispatchEvent("focus");
    portText.changeHandler("9");

    // Simulate daemon coming online and notifying listeners
    client.isRunning = true;
    client.port = 8188;
    client.pid = 4242;
    client.updateConfig(client.config);

    // Must update existing controls in-place without destroying focused input value "9"
    expect(startBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(false);
    expect(statusSetting.desc).toContain("Running on http://127.0.0.1:8188");
    expect(portText.val).toBe("9");

    // Unsubscribe on hide()
    (tab as any).hide();
    client.isRunning = false;
    client.updateConfig(client.config);
    expect(startBtn.disabled).toBe(true);
  });

  it("shows pending port restart hint in both Settings Tab and Plugin Status Bar when editing port while running (AC-3)", async () => {
    const app = {
      vault: { adapter: { getBasePath: () => tempDir }, getAbstractFileByPath: () => null },
    } as any;
    const plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
    vi.spyOn(DaemonClient.prototype, "init").mockResolvedValueOnce(undefined);
    await plugin.onload();

    plugin.client.isRunning = true;
    plugin.client.port = 8188;
    plugin.client.pid = 5150;
    plugin.updateStatusBar();

    const pluginTab: LernstoffSettingsTab = (plugin as any).settingTabs[0];
    pluginTab.display();

    const statusSetting = pluginTab.containerEl.settings.find(
      (s: any) => s.name === "Daemon Service Status",
    );
    const portSetting = pluginTab.containerEl.settings.find((s: any) => s.name === "Server Port");
    portSetting.elements[0].changeHandler("9345");

    expect(plugin.client.config.server.port).toBe(9345);
    expect(plugin.client.port).toBe(8188);
    expect(statusSetting.desc).toContain("Port 9345 saved");
    expect(statusSetting.desc).toContain("Restart");

    const statusBar = (plugin as any).statusBarItems[0];
    expect(statusBar.text).toContain("⚠️ Restart -> :9345");
    expect(statusBar.title).toContain("⚠️ Restart -> :9345");

    (pluginTab as any).hide?.();
    plugin.onunload();
  });

  it("surfaces fallback Notice, status description, and synced Server Port input when startDaemon falls back (AC-2)", async () => {
    client.config.server.port = 9090;
    client.updateConfig(client.config);

    vi.spyOn(client, "startDaemon").mockImplementation(async () => {
      client.isRunning = true;
      client.port = 9091;
      client.pid = 7777;
      client.config.server.port = 9091;
      client.lastPortFallback = { requestedPort: 9090, actualPort: 9091 };
      return true;
    });

    tab.display();
    const statusSetting = tab.containerEl.settings.find(
      (s: any) => s.name === "Daemon Service Status",
    );
    const startBtn = statusSetting.elements.find((b: any) => b.text === "Start");
    const portSetting = tab.containerEl.settings.find((s: any) => s.name === "Server Port");
    const portText = portSetting.elements[0];

    await startBtn.onClickHandler();

    const notices: string[] = (Notice as any).notices;
    expect(notices.some((n) => n.includes("9090") && n.includes("9091"))).toBe(true);
    expect(statusSetting.desc).toContain("9090");
    expect(statusSetting.desc).toContain("9091");
    expect(portText.val).toBe("9091");
  });

  it("guards buttons against concurrent in-flight clicks and checks stopDaemon() boolean return (AC-4)", async () => {
    let resolveStart!: (v: boolean) => void;
    const startSpy = vi.spyOn(client, "startDaemon").mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolveStart = r;
        }),
    );
    vi.spyOn(client, "stopDaemon").mockResolvedValue(false);

    tab.display();
    const statusSetting = tab.containerEl.settings.find(
      (s: any) => s.name === "Daemon Service Status",
    );
    const startBtn = statusSetting.elements.find((b: any) => b.text === "Start");
    const restartBtn = statusSetting.elements.find((b: any) => b.text === "Restart");
    const stopBtn = statusSetting.elements.find((b: any) => b.text === "Stop");

    const p1 = startBtn.onClickHandler();
    expect(startBtn.disabled).toBe(true);
    expect(restartBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(true);

    // Concurrent click while in-flight must be ignored
    await startBtn.onClickHandler();
    expect(startSpy).toHaveBeenCalledTimes(1);

    client.isRunning = true;
    resolveStart(true);
    await p1;

    // Now test stopDaemon returning false -> must report failure, not fake stop toast
    (Notice as any).notices = [];
    await stopBtn.onClickHandler();
    expect((Notice as any).notices.some((n: string) => n.includes("Failed to stop"))).toBe(true);
  });

  it("rolls back OS Boot Auto-Start toggle and alerts when installService or uninstallService fails", async () => {
    tab.display();
    const serviceSetting = tab.containerEl.settings.find(
      (s: any) => s.name === "OS Boot Auto-Start",
    );
    expect(serviceSetting).toBeDefined();
    const toggle = serviceSetting.elements[0];

    // Mock installService failure
    vi.spyOn(client, "installService").mockResolvedValueOnce({
      success: false,
      error: "launchctl permission denied",
    });

    (Notice as any).notices = [];
    await toggle.changeHandler(true);
    expect(toggle.val).toBe(false);
    expect(
      (Notice as any).notices.some((n: string) => n.includes("launchctl permission denied")),
    ).toBe(true);

    // Mock uninstallService failure
    vi.spyOn(client, "uninstallService").mockResolvedValueOnce({
      success: false,
      error: "systemctl service locked",
    });

    (Notice as any).notices = [];
    await toggle.changeHandler(false);
    expect(toggle.val).toBe(true);
    expect(
      (Notice as any).notices.some((n: string) => n.includes("systemctl service locked")),
    ).toBe(true);
  });

  it("surfaces real ActionResult failures for Agent and Maintenance actions", async () => {
    tab.display();

    // 1. Agent button failure
    vi.spyOn(client, "installAgent").mockResolvedValueOnce({
      success: false,
      error: "Failed to write SKILL.md",
    });
    const agentSetting = tab.containerEl.settings.find(
      (s: any) => s.name === "One-Click MCP & SKILL.md Installation",
    );
    const claudeBtn = agentSetting.elements.find((b: any) => b.text === "Claude Code");
    (Notice as any).notices = [];
    await claudeBtn.onClickHandler();
    expect(
      (Notice as any).notices.some((n: string) => n.includes("Failed to write SKILL.md")),
    ).toBe(true);

    // 2. Maintenance updateIndex failure
    vi.spyOn(client, "updateIndex").mockResolvedValueOnce({
      success: false,
      error: "Vector index locked",
    });
    const maintSetting = tab.containerEl.settings.find(
      (s: any) => s.name === "Storage Maintenance & Index Synchronization",
    );
    const updateIndexBtn = maintSetting.elements.find((b: any) => b.text === "Update Index");
    (Notice as any).notices = [];
    await updateIndexBtn.onClickHandler();
    expect((Notice as any).notices.some((n: string) => n.includes("Vector index locked"))).toBe(
      true,
    );
  });

  it("registers commands with clean English names via i18n and populates en.json", async () => {
    const enLocale = (await import("../src/locales/en.json", { with: { type: "json" } })).default;
    expect(Object.keys(enLocale).length).toBeGreaterThan(0);

    const app = {
      vault: { adapter: { getBasePath: () => tempDir }, getAbstractFileByPath: () => null },
    } as any;
    const plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
    vi.spyOn(DaemonClient.prototype, "init").mockResolvedValueOnce(undefined);
    await plugin.onload();

    const openInquiryCmd = (plugin as any).commands.get("open-inquiry-tree");
    expect(openInquiryCmd.name).toBe("Open Inquiry Tree");
    const openScratchpadCmd = (plugin as any).commands.get("open-scratchpad");
    expect(openScratchpadCmd.name).toBe("Open Scratchpad");
    const addInquiryCmd = (plugin as any).commands.get("add-selection-to-inquiries");
    expect(addInquiryCmd.name).toBe("Add Selection to Inquiry Tree");
    const deferScratchpadCmd = (plugin as any).commands.get("defer-selection-to-scratchpad");
    expect(deferScratchpadCmd.name).toBe("Defer Selection to Scratchpad");
    const socraticLintCmd = (plugin as any).commands.get("run-socratic-lint");
    expect(socraticLintCmd.name).toBe("Run Socratic Wiki Lint");
    const consolidateCmd = (plugin as any).commands.get("consolidate-scratchpad");
    expect(consolidateCmd.name).toBe("Consolidate & GC Scratchpad");
    const restartCmd = (plugin as any).commands.get("restart-daemon");
    expect(restartCmd.name).toBe("Restart Background Daemon");
    const startCmd = (plugin as any).commands.get("start-daemon");
    expect(startCmd.name).toBe("Start Background Daemon");
    const stopCmd = (plugin as any).commands.get("stop-daemon");
    expect(stopCmd.name).toBe("Stop Background Daemon");

    plugin.onunload();
  });

  it("switches commands, status bar, and settings tab to active locale (zh, zh-TW, ja, ko) and falls back to en for unsupported locales", async () => {
    const testCases: Array<{
      locale: string;
      expectedOpenCmd: string;
      expectedOfflineStatus: string;
      expectedHeading1: string;
      expectedServerPortName: string;
    }> = [
      {
        locale: "zh",
        expectedOpenCmd: "打开好奇心问题树",
        expectedOfflineStatus: "🧠 Lernstoff: ⚪ 离线",
        expectedHeading1: "1. 守护进程与开机自启",
        expectedServerPortName: "服务器端口",
      },
      {
        locale: "zh-TW",
        expectedOpenCmd: "開啟好奇心問題樹",
        expectedOfflineStatus: "🧠 Lernstoff: ⚪ 離線",
        expectedHeading1: "1. 守護行程與開機自啟",
        expectedServerPortName: "伺服器連接埠",
      },
      {
        locale: "ja",
        expectedOpenCmd: "問いの木を開く",
        expectedOfflineStatus: "🧠 Lernstoff: ⚪ オフライン",
        expectedHeading1: "1. デーモンとOS自動起動",
        expectedServerPortName: "サーバーポート",
      },
      {
        locale: "ko",
        expectedOpenCmd: "질문 트리 열기",
        expectedOfflineStatus: "🧠 Lernstoff: ⚪ 오프라인",
        expectedHeading1: "1. 데몬 및 OS 부팅 시 자동 시작",
        expectedServerPortName: "서버 포트",
      },
      {
        locale: "fr", // Unsupported locale -> should fall back to English
        expectedOpenCmd: "Open Inquiry Tree",
        expectedOfflineStatus: "🧠 Lernstoff: ⚪ Offline",
        expectedHeading1: "1. Daemon & OS Boot Auto-Start",
        expectedServerPortName: "Server Port",
      },
    ];

    for (const tc of testCases) {
      getLanguageMock.mockReturnValue(tc.locale);

      const app = {
        vault: { adapter: { getBasePath: () => tempDir }, getAbstractFileByPath: () => null },
      } as any;
      const plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
      vi.spyOn(DaemonClient.prototype, "init").mockResolvedValueOnce(undefined);
      await plugin.onload();

      // Check command name
      const openInquiryCmd = (plugin as any).commands.get("open-inquiry-tree");
      expect(openInquiryCmd.name).toBe(tc.expectedOpenCmd);

      // Check status bar text
      const statusBar = (plugin as any).statusBarItems[0];
      expect(statusBar.text).toBe(tc.expectedOfflineStatus);

      // Check settings tab rendering
      const pluginTab: LernstoffSettingsTab = (plugin as any).settingTabs[0];
      pluginTab.display();

      const headings = pluginTab.containerEl.elements
        .filter((el: any) => el.tagName === "h3")
        .map((el: any) => el.text);
      expect(headings[0]).toBe(tc.expectedHeading1);

      const portSetting = pluginTab.containerEl.settings.find(
        (s: any) => s.name === tc.expectedServerPortName,
      );
      expect(portSetting).toBeDefined();

      (pluginTab as any).hide?.();
      plugin.onunload();
    }
  });
});
