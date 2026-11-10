import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { VaultOps } from "@lernstoff/core";
import { getRunningDaemonInfo } from "./daemon-pid.js";

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  servicePath?: string;
  platform: string;
  pid?: number;
  port?: number;
}

export class ServiceManager {
  public static getServiceSlug(vaultPath: string): string {
    const name = basename(resolve(vaultPath));
    return VaultOps.slugify(name || "default");
  }

  public static getLaunchdPlistPath(vaultPath: string): string {
    const slug = ServiceManager.getServiceSlug(vaultPath);
    return join(homedir(), "Library/LaunchAgents", `ai.lernstoff.wiki.${slug}.plist`);
  }

  public static getSystemdServicePath(vaultPath: string): string {
    const slug = ServiceManager.getServiceSlug(vaultPath);
    return join(homedir(), ".config/systemd/user", `lernstoff-wiki@${slug}.service`);
  }

  public static generateLaunchdPlist(vaultPath: string, cliPath: string): string {
    const slug = ServiceManager.getServiceSlug(vaultPath);
    const absVault = resolve(vaultPath);
    const logPath = join(absVault, ".lernstoff", "daemon.log");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.lernstoff.wiki.${slug}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>server</string>
    <string>start</string>
    <string>--foreground</string>
    <string>--vault</string>
    <string>${absVault}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>WorkingDirectory</key>
  <string>${absVault}</string>
</dict>
</plist>
`;
  }

  public static generateSystemdService(vaultPath: string, cliPath: string): string {
    const slug = ServiceManager.getServiceSlug(vaultPath);
    const absVault = resolve(vaultPath);
    const logPath = join(absVault, ".lernstoff", "daemon.log");

    return `[Unit]
Description=Lernstoff Wiki Headless Cognitive Engine (${slug})
After=network.target

[Service]
Type=simple
WorkingDirectory=${absVault}
ExecStart=${process.execPath} ${cliPath} server start --foreground --vault ${absVault}
Restart=always
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
  }

  /**
   * Install OS boot auto-start service for the target Vault.
   */
  public static async installService(
    vaultPath: string,
    cliPath = process.argv[1] || "lernstoff",
  ): Promise<{ success: boolean; servicePath: string; platform: string }> {
    const absVault = resolve(vaultPath);
    const platform = process.platform;

    if (platform === "darwin") {
      const plistPath = ServiceManager.getLaunchdPlistPath(absVault);
      mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
      const plistXml = ServiceManager.generateLaunchdPlist(absVault, cliPath);
      writeFileSync(plistPath, plistXml, "utf-8");

      try {
        execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" });
      } catch {
        // May already be loaded or in dry-run
      }

      return { success: true, servicePath: plistPath, platform: "darwin" };
    }

    if (platform === "linux") {
      const servicePath = ServiceManager.getSystemdServicePath(absVault);
      mkdirSync(join(homedir(), ".config/systemd/user"), { recursive: true });
      const serviceUnit = ServiceManager.generateSystemdService(absVault, cliPath);
      writeFileSync(servicePath, serviceUnit, "utf-8");

      try {
        execSync("systemctl --user daemon-reload", { stdio: "ignore" });
        execSync(`systemctl --user enable --now "${basename(servicePath)}"`, { stdio: "ignore" });
      } catch {}

      return { success: true, servicePath, platform: "linux" };
    }

    // Windows or other fallback
    const fallbackPath = join(absVault, ".lernstoff", "autostart.cmd");
    writeFileSync(
      fallbackPath,
      `@echo off\n"${process.execPath}" "${cliPath}" server start --foreground --vault "${absVault}"\n`,
      "utf-8",
    );
    return { success: true, servicePath: fallbackPath, platform: "win32" };
  }

  /**
   * Uninstall and deregister the OS boot auto-start service.
   */
  public static async uninstallService(
    vaultPath: string,
  ): Promise<{ success: boolean; servicePath?: string }> {
    const absVault = resolve(vaultPath);
    const platform = process.platform;

    if (platform === "darwin") {
      const plistPath = ServiceManager.getLaunchdPlistPath(absVault);
      if (existsSync(plistPath)) {
        try {
          execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
        } catch {}
        try {
          unlinkSync(plistPath);
        } catch {}
        return { success: true, servicePath: plistPath };
      }
    } else if (platform === "linux") {
      const servicePath = ServiceManager.getSystemdServicePath(absVault);
      if (existsSync(servicePath)) {
        try {
          execSync(`systemctl --user stop "${basename(servicePath)}"`, { stdio: "ignore" });
          execSync(`systemctl --user disable "${basename(servicePath)}"`, { stdio: "ignore" });
        } catch {}
        try {
          unlinkSync(servicePath);
        } catch {}
        return { success: true, servicePath };
      }
    }

    return { success: true };
  }

  /**
   * Get service registration status and current running daemon info.
   */
  public static async getServiceStatus(vaultPath: string): Promise<ServiceStatus> {
    const absVault = resolve(vaultPath);
    const platform = process.platform;
    let installed = false;
    let servicePath: string | undefined;

    if (platform === "darwin") {
      servicePath = ServiceManager.getLaunchdPlistPath(absVault);
      installed = existsSync(servicePath);
    } else if (platform === "linux") {
      servicePath = ServiceManager.getSystemdServicePath(absVault);
      installed = existsSync(servicePath);
    }

    const daemonInfo = getRunningDaemonInfo(absVault);

    return {
      installed,
      running: !!daemonInfo,
      servicePath: installed ? servicePath : undefined,
      platform,
      pid: daemonInfo?.pid,
      port: daemonInfo?.port,
    };
  }
}
