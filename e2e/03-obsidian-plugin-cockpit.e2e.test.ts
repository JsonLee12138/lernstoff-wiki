import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import {
  allocateFreePort,
  createE2eSandbox,
  isNonEmptyFile,
  type E2eSandbox,
} from "./helpers/e2e-harness.js";

const notices: string[] = [];

// Lightweight faithful host shim for the `obsidian` Electron API surface
vi.mock("obsidian", () => {
  class MockSetting {
    containerEl: any;
    name = "";
    desc = "";
    elements: any[] = [];
    constructor(containerEl: any) {
      this.containerEl = containerEl;
      containerEl?.settings?.push(this);
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
        onClickHandler: null as null | (() => any),
        setButtonText(t: string) {
          this.text = t;
          return this;
        },
        setCta() {
          return this;
        },
        setWarning() {
          return this;
        },
        setDisabled(d: boolean) {
          this.disabled = d;
          return this;
        },
        onClick(fn: () => any) {
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
        changeHandler: null as null | ((v: boolean) => any),
        setValue(v: boolean) {
          this.val = v;
          return this;
        },
        onChange(fn: (v: boolean) => any) {
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
        changeHandler: null as null | ((v: string) => any),
        setValue(v: string) {
          this.val = v;
          this.inputEl.value = v;
          return this;
        },
        onChange(fn: (v: string) => any) {
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
        step: 0.05,
        changeHandler: null as null | ((v: number) => any),
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
        onChange(fn: (v: number) => any) {
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
        listeners: new Map<string, (...args: any[]) => void>(),
        addClass(cls: string) {
          this.classes.push(cls);
        },
        setText(t: string) {
          this.text = t;
        },
        addEventListener(evt: string, cb: (...args: any[]) => void) {
          this.listeners.set(evt, cb);
        },
      };
      this.statusBarItems.push(item);
      return item;
    }

    addSettingTab(tab: any) {
      this.settingTabs.push(tab);
    }

    addCommand(cmd: any) {
      this.commands.set(cmd.id, cmd);
      return cmd;
    }
  }

  class MockNotice {
    constructor(public message: string) {
      notices.push(message);
    }
  }

  return {
    App: class {},
    Plugin: MockPlugin,
    PluginSettingTab: MockPluginSettingTab,
    Setting: MockSetting,
    Notice: MockNotice,
  };
});

import LernstoffPlugin from "../packages/obsidian-plugin/src/main.js";
import { LernstoffSettingsTab } from "../packages/obsidian-plugin/src/settings-tab.js";

function createObsidianApp(vaultDir: string) {
  const openedFiles: string[] = [];
  return {
    openedFiles,
    app: {
      vault: {
        adapter: {
          getBasePath: () => vaultDir,
        },
        getAbstractFileByPath: (relPath: string) => {
          const full = join(vaultDir, relPath);
          return existsSync(full) ? { path: relPath } : null;
        },
      },
      workspace: {
        getLeaf: () => ({
          openFile: async (file: { path: string }) => {
            openedFiles.push(file.path);
          },
        }),
      },
      setting: {
        open: () => {},
        openTabById: () => {},
      },
    } as any,
  };
}

describe("E2E Flow 03: Obsidian Plugin Cockpit, Real Daemon State Sync & Action Buttons", () => {
  let sandbox: E2eSandbox;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origPath: string | undefined;
  let plugin: LernstoffPlugin | null = null;

  beforeEach(async () => {
    notices.length = 0;
    sandbox = await createE2eSandbox({ seedPort: true });
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    origPath = process.env.PATH;

    // Isolate HOME and PATH so any in-process or spawned CLI actions stay inside sandbox
    process.env.HOME = sandbox.homeDir;
    process.env.USERPROFILE = sandbox.homeDir;
    process.env.PATH = sandbox.env.PATH;
  });

  afterEach(async () => {
    plugin?.onunload();
    plugin = null;
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    process.env.PATH = origPath;
    await sandbox.cleanup();
  });

  it("3.1 bootstraps starter templates on a fresh Obsidian Vault so `open-inquiry-tree` works immediately (Task 15)", async () => {
    // Disable autoStartOnObsidianOpen to isolate Vault file bootstrap check cleanly
    await sandbox.runCli([
      "config",
      "set",
      "server.autoStartOnObsidianOpen",
      "false",
      "--vault",
      sandbox.vaultDir,
    ]);

    const { app, openedFiles } = createObsidianApp(sandbox.vaultDir);
    plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
    await plugin.onload();
    await plugin.client.init();

    const openInquiryCmd = (plugin as any).commands.get("open-inquiry-tree");
    expect(openInquiryCmd).toBeDefined();
    await openInquiryCmd.callback();

    expect(openedFiles).toContain("wiki/inquiries.md");
  });

  it("3.2 updates Obsidian `isRunning`, Status Bar, and Settings Tab to Offline when Daemon stops externally via CLI (Tasks 15 & 16)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    sandbox.seedPortConfig();
    await sandbox.runCli(["server", "start", "--daemon", "--vault", sandbox.vaultDir]);
    await sandbox.waitForDaemonHealth(sandbox.port);

    const { app } = createObsidianApp(sandbox.vaultDir);
    plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
    await plugin.onload();
    await plugin.client.init();

    expect(plugin.client.isRunning).toBe(true);
    const statusBar = (plugin as any).statusBarItems[0];
    expect(statusBar.text).toContain("🟢");

    // External CLI stops the daemon (simulating terminal `lernstoff server stop` or daemon crash)
    const stopRes = await sandbox.runCli(["server", "stop", "--vault", sandbox.vaultDir]);
    expect(stopRes.code).toBe(0);

    // Give SSE disconnect handler / health monitor up to 1.5s to react
    await new Promise((r) => setTimeout(r, 1500));

    const settingsTab: LernstoffSettingsTab = (plugin as any).settingTabs[0];
    settingsTab.display();
    await new Promise((r) => setTimeout(r, 300));

    const daemonStatusSetting = (settingsTab.containerEl as any).settings.find(
      (s: any) => s.name === "Daemon Service Status",
    );

    // Must NOT remain stuck displaying fake Running state after daemon process terminated!
    expect(plugin.client.isRunning).toBe(false);
    expect(statusBar.text).toContain("Offline");
    expect(daemonStatusSetting.desc).toContain("Stopped");
  });

  it("3.3 registers/unregisters real OS Boot Auto-Start service file when toggling setting in Module 1 (Task 16)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    sandbox.seedPortConfig();
    await sandbox.runCli([
      "config",
      "set",
      "server.autoStartOnObsidianOpen",
      "false",
      "--vault",
      sandbox.vaultDir,
    ]);

    const { app } = createObsidianApp(sandbox.vaultDir);
    plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
    await plugin.onload();
    await plugin.client.init();

    const settingsTab: LernstoffSettingsTab = (plugin as any).settingTabs[0];
    settingsTab.display();

    const bootSetting = (settingsTab.containerEl as any).settings.find(
      (s: any) => s.name === "OS Boot Auto-Start",
    );
    expect(bootSetting).toBeDefined();

    // Toggle ON -> must invoke real ServiceManager / CLI service install inside isolated HOME
    await bootSetting.elements[0].changeHandler(true);

    const expectedServiceFile =
      process.platform === "darwin"
        ? join(sandbox.homeDir, "Library/LaunchAgents/ai.lernstoff.wiki.vault.plist")
        : process.platform === "linux"
          ? join(sandbox.homeDir, ".config/systemd/user/lernstoff-wiki@vault.service")
          : join(sandbox.vaultDir, ".lernstoff/autostart.cmd");

    expect(isNonEmptyFile(expectedServiceFile)).toBe(true);
  });

  it("3.4 writes real SKILL.md and MCP config files when clicking Claude Code, Cursor, and Antigravity buttons in Module 2 (Task 16)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    sandbox.seedPortConfig();
    await sandbox.runCli([
      "config",
      "set",
      "server.autoStartOnObsidianOpen",
      "false",
      "--vault",
      sandbox.vaultDir,
    ]);

    const { app } = createObsidianApp(sandbox.vaultDir);
    plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
    await plugin.onload();
    await plugin.client.init();

    const settingsTab: LernstoffSettingsTab = (plugin as any).settingTabs[0];
    settingsTab.display();

    const agentSetting = (settingsTab.containerEl as any).settings.find(
      (s: any) => s.name === "One-Click MCP & SKILL.md Installation",
    );
    expect(agentSetting).toBeDefined();

    const claudeBtn = agentSetting.elements.find((b: any) => b.text === "Claude Code");
    const cursorBtn = agentSetting.elements.find((b: any) => b.text === "Cursor");
    const agyBtn = agentSetting.elements.find((b: any) => b.text === "Antigravity");

    await claudeBtn.onClickHandler();
    await cursorBtn.onClickHandler();
    await agyBtn.onClickHandler();

    // Buttons must actually write MCP + SKILL files on disk instead of only showing fake `Notice` toasts!
    expect(isNonEmptyFile(join(sandbox.vaultDir, ".mcp.json"))).toBe(true);
    expect(isNonEmptyFile(join(sandbox.vaultDir, ".cursor/mcp.json"))).toBe(true);
    expect(isNonEmptyFile(join(sandbox.homeDir, ".gemini/antigravity/mcp_config.json"))).toBe(true);
  });

  it("3.5 exposes Module 3 index maintenance controls and preserves uncorrupted factory defaults on singleton-free Reset (Tasks 2 & 16)", async () => {
    // Start with NO config.json on disk to test `loadConfig` singleton safety
    const emptySandbox = await createE2eSandbox({ seedPort: false });
    try {
      const { app } = createObsidianApp(emptySandbox.vaultDir);
      const uninitPlugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
      await uninitPlugin.onload();
      uninitPlugin.client.loadLocalConfig();

      const settingsTab: LernstoffSettingsTab = (uninitPlugin as any).settingTabs[0];
      settingsTab.display();

      // Mutate Gate 2 tauOff slider on a Vault that had no config.json when loaded
      const tauOffSetting = (settingsTab.containerEl as any).settings.find((s: any) =>
        s.name.includes("Gate 2 Inquiry Off-Topic Cutoff"),
      );
      tauOffSetting.elements[0].changeHandler(0.75);

      // Click Reset to Defaults -> must restore 0.35 (not 0.75 from mutated singleton!)
      const resetSetting = (settingsTab.containerEl as any).settings.find(
        (s: any) => s.name === "Reset Gate to Factory Defaults",
      );
      resetSetting.elements[0].onClickHandler();
      expect(uninitPlugin.client.config.gate.tauOff).toBe(0.35);

      // Module 3 must provide Update Index / Cleanup Orphans maintenance actions (Task 16 AC#2)
      const allButtonLabels = (settingsTab.containerEl as any).settings.flatMap((s: any) =>
        s.elements.map((e: any) => e.text).filter(Boolean),
      );
      expect(allButtonLabels.some((t: string) => /update index/i.test(t))).toBe(true);
      expect(allButtonLabels.some((t: string) => /cleanup/i.test(t))).toBe(true);

      uninitPlugin.onunload();
    } finally {
      await emptySandbox.cleanup();
    }
  });

  it("3.6 persists `defer-selection-to-scratchpad` to `inbox/scratchpad.md` and displays noise filter ratio in Status Bar (Task 15)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    sandbox.seedPortConfig();
    await sandbox.runCli(["server", "start", "--daemon", "--vault", sandbox.vaultDir]);
    await sandbox.waitForDaemonHealth(sandbox.port);

    const { app } = createObsidianApp(sandbox.vaultDir);
    plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
    await plugin.onload();
    await plugin.client.checkDaemon();

    const deferCmd = (plugin as any).commands.get("defer-selection-to-scratchpad");
    expect(deferCmd).toBeDefined();

    const selectedClaim = "Hybrid logical clocks bound causality tracking within NTP error windows";
    await deferCmd.editorCallback({
      getSelection: () => `  ${selectedClaim}  `,
    });

    const scratchpadOnDisk = readFileSync(join(sandbox.vaultDir, "inbox/scratchpad.md"), "utf-8");
    expect(scratchpadOnDisk).toContain(selectedClaim);

    // Status bar must include noise filtered ratio per Task 15 AC#2
    const statusBar = (plugin as any).statusBarItems[0];
    expect(statusBar.text).toMatch(/%/);
  });

  it("3.7 launches real daemon on configured custom Server Port and toggles Start -> Stop -> Start -> Restart in < 2s per action (AC-1 & AC-4)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    await sandbox.runCli([
      "config",
      "set",
      "server.autoStartOnObsidianOpen",
      "false",
      "--vault",
      sandbox.vaultDir,
    ]);

    const customPort = await allocateFreePort();
    const { app } = createObsidianApp(sandbox.vaultDir);
    plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
    await plugin.onload();
    await plugin.client.init();

    const settingsTab: LernstoffSettingsTab = (plugin as any).settingTabs[0];
    settingsTab.display();

    const statusSetting = (settingsTab.containerEl as any).settings.find(
      (s: any) => s.name === "Daemon Service Status",
    );
    const startBtn = statusSetting.elements.find((b: any) => b.text === "Start");
    const restartBtn = statusSetting.elements.find((b: any) => b.text === "Restart");
    const stopBtn = statusSetting.elements.find((b: any) => b.text === "Stop");
    const portSetting = (settingsTab.containerEl as any).settings.find(
      (s: any) => s.name === "Server Port",
    );
    const portText = portSetting.elements[0];

    // Partial/invalid inputs must not throw or corrupt config
    for (const bad of ["9", "80", "70000", "abc"]) {
      expect(() => portText.changeHandler(bad)).not.toThrow();
    }
    portText.inputEl.dispatchEvent("blur");
    expect(notices.some((n) => n.includes("1024") && n.includes("65535"))).toBe(true);

    // Configure valid custom port
    portText.changeHandler(String(customPort));
    const diskCfg = JSON.parse(
      readFileSync(join(sandbox.vaultDir, ".lernstoff/config.json"), "utf-8"),
    );
    expect(diskCfg.server.port).toBe(customPort);

    // 1. Click Start
    let t0 = Date.now();
    await startBtn.onClickHandler();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(plugin.client.isRunning).toBe(true);
    expect(plugin.client.port).toBe(customPort);
    expect(readFileSync(join(sandbox.vaultDir, ".lernstoff/daemon.port"), "utf-8").trim()).toBe(
      String(customPort),
    );
    expect(startBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(false);
    const pid1 = plugin.client.pid!;
    expect(pid1).toBeGreaterThan(0);

    // 2. Click Stop
    t0 = Date.now();
    await stopBtn.onClickHandler();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(plugin.client.isRunning).toBe(false);
    expect(startBtn.disabled).toBe(false);
    expect(stopBtn.disabled).toBe(true);
    expect(() => process.kill(pid1, 0)).toThrow();

    // 3. Click Start again
    t0 = Date.now();
    await startBtn.onClickHandler();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(plugin.client.isRunning).toBe(true);
    expect(plugin.client.port).toBe(customPort);
    const pid2 = plugin.client.pid!;
    expect(pid2).toBeGreaterThan(0);

    // 4. Click Restart
    t0 = Date.now();
    await restartBtn.onClickHandler();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(plugin.client.isRunning).toBe(true);
    expect(plugin.client.port).toBe(customPort);
    expect(plugin.client.pid).not.toBe(pid2);

    (settingsTab as any).hide?.();
  });

  it("3.8 auto-increments occupied Server Port, persists actual port to config.json, and surfaces UI fallback hints (AC-2)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    await sandbox.runCli([
      "config",
      "set",
      "server.autoStartOnObsidianOpen",
      "false",
      "--vault",
      sandbox.vaultDir,
    ]);

    const sockets = new Set<any>();
    const blocker = createTcpServer((s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    const occupiedPort = await new Promise<number>((resolvePort, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => {
        const addr = blocker.address();
        if (addr && typeof addr === "object") resolvePort(addr.port);
        else reject(new Error("Failed to bind blocker"));
      });
    });

    try {
      const { app } = createObsidianApp(sandbox.vaultDir);
      plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
      await plugin.onload();
      await plugin.client.init();

      const settingsTab: LernstoffSettingsTab = (plugin as any).settingTabs[0];
      settingsTab.display();

      const statusSetting = (settingsTab.containerEl as any).settings.find(
        (s: any) => s.name === "Daemon Service Status",
      );
      const startBtn = statusSetting.elements.find((b: any) => b.text === "Start");
      const portSetting = (settingsTab.containerEl as any).settings.find(
        (s: any) => s.name === "Server Port",
      );
      const portText = portSetting.elements[0];

      portText.changeHandler(String(occupiedPort));
      notices.length = 0;

      await startBtn.onClickHandler();

      expect(plugin.client.isRunning).toBe(true);
      const actualPort = plugin.client.port;
      expect(actualPort).toBeGreaterThan(occupiedPort);
      expect(plugin.client.lastPortFallback).toEqual({
        requestedPort: occupiedPort,
        actualPort,
      });

      const persistedCfg = JSON.parse(
        readFileSync(join(sandbox.vaultDir, ".lernstoff/config.json"), "utf-8"),
      );
      expect(persistedCfg.server.port).toBe(actualPort);
      expect(portText.val).toBe(String(actualPort));
      expect(statusSetting.desc).toContain(String(occupiedPort));
      expect(statusSetting.desc).toContain(String(actualPort));
      expect(
        notices.some((n) => n.includes(String(occupiedPort)) && n.includes(String(actualPort))),
      ).toBe(true);

      (settingsTab as any).hide?.();
    } finally {
      for (const s of sockets) {
        s.destroy();
      }
      try {
        (blocker as any).closeAllConnections?.();
      } catch {}
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it("3.9 stages live Server Port edit (P1 -> P2) without interrupting P1, displays pending Restart hints across polling, and switches to P2 on Restart (AC-3)", async () => {
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    await sandbox.runCli([
      "config",
      "set",
      "server.autoStartOnObsidianOpen",
      "false",
      "--vault",
      sandbox.vaultDir,
    ]);

    const port1 = await allocateFreePort();
    let port2 = await allocateFreePort();
    while (port2 === port1) {
      port2 = await allocateFreePort();
    }

    const { app } = createObsidianApp(sandbox.vaultDir);
    plugin = new LernstoffPlugin(app, { id: "lernstoff-wiki" } as any);
    await plugin.onload();
    await plugin.client.init();

    const settingsTab: LernstoffSettingsTab = (plugin as any).settingTabs[0];
    settingsTab.display();

    const statusSetting = (settingsTab.containerEl as any).settings.find(
      (s: any) => s.name === "Daemon Service Status",
    );
    const startBtn = statusSetting.elements.find((b: any) => b.text === "Start");
    const restartBtn = statusSetting.elements.find((b: any) => b.text === "Restart");
    const portSetting = (settingsTab.containerEl as any).settings.find(
      (s: any) => s.name === "Server Port",
    );
    const portText = portSetting.elements[0];
    const statusBar = (plugin as any).statusBarItems[0];

    // Start on P1
    portText.changeHandler(String(port1));
    await startBtn.onClickHandler();
    expect(plugin.client.isRunning).toBe(true);
    expect(plugin.client.port).toBe(port1);

    // Edit to P2 while running on P1
    portText.changeHandler(String(port2));
    expect(plugin.client.config.server.port).toBe(port2);
    expect(plugin.client.port).toBe(port1);

    // Wait across a checkDaemon() health poll to prove P1 does NOT overwrite staged P2
    await new Promise((r) => setTimeout(r, 1200));
    expect(plugin.client.config.server.port).toBe(port2);
    expect(plugin.client.port).toBe(port1);

    // Both Settings Tab and Status Bar must show pending Restart hint
    expect(statusSetting.desc).toContain(`Port ${port2} saved`);
    expect(statusSetting.desc).toContain("Restart");
    expect(statusBar.text).toContain(`⚠️ Restart -> :${port2}`);
    expect(statusBar.title).toContain(`⚠️ Restart -> :${port2}`);

    // Click Restart -> switches to P2 and clears pending hint
    await restartBtn.onClickHandler();
    expect(plugin.client.isRunning).toBe(true);
    expect(plugin.client.port).toBe(port2);
    expect(readFileSync(join(sandbox.vaultDir, ".lernstoff/daemon.port"), "utf-8").trim()).toBe(
      String(port2),
    );
    expect(statusSetting.desc).not.toContain("click Restart to switch");
    expect(statusBar.text).not.toContain("⚠️ Restart ->");

    (settingsTab as any).hide?.();
  });
});
