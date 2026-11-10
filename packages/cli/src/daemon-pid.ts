import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { LERNSTOFF_DIR } from "@lernstoff/core";

/**
 * Check if a process ID is currently running in the OS.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the full command line of a process by PID across macOS, Linux, and Windows.
 */
export function readProcessCmdline(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      const output = execSync(`wmic process where ProcessId=${pid} get CommandLine /value`, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).toString("utf-8");
      const match = output.match(/CommandLine=(.*)/i);
      return match ? match[1]!.trim() : null;
    } else {
      const output = execSync(`ps -p ${pid} -o command=`, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).toString("utf-8");
      return output.trim();
    }
  } catch {
    return null;
  }
}

/**
 * Verifies process identity to prevent false positives from recycled PIDs.
 * Modeled on qmd/src/cli/mcp-pid.ts#L74-L86.
 */
export function looksLikeLernstoffDaemon(cmdline: string): boolean {
  const lower = cmdline.toLowerCase();
  return (
    lower.includes("lernstoff") ||
    lower.includes("daemon-server") ||
    lower.includes("@lernstoff/cli") ||
    lower.includes("lernstoff-wiki")
  );
}

export interface RunningDaemonInfo {
  pid: number;
  port: number;
}

/**
 * Inspects <vault>/.lernstoff/daemon.pid and daemon.port to check if the daemon is alive.
 * If the process is dead or stale, cleans up the files and returns null.
 */
export function getRunningDaemonInfo(vaultPath: string): RunningDaemonInfo | null {
  const resolved = resolve(vaultPath);
  const lernstoffDir = join(resolved, LERNSTOFF_DIR);
  const pidFile = join(lernstoffDir, "daemon.pid");
  const portFile = join(lernstoffDir, "daemon.port");

  if (!existsSync(pidFile)) {
    return null;
  }

  let pid: number;
  try {
    pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  } catch {
    return null;
  }

  if (!isPidAlive(pid)) {
    // Stale PID file, clean up
    try {
      unlinkSync(pidFile);
    } catch {}
    try {
      if (existsSync(portFile)) unlinkSync(portFile);
    } catch {}
    return null;
  }

  const cmdline = readProcessCmdline(pid);
  if (cmdline && !looksLikeLernstoffDaemon(cmdline)) {
    // Process ID was recycled by another unrelated process
    try {
      unlinkSync(pidFile);
    } catch {}
    try {
      if (existsSync(portFile)) unlinkSync(portFile);
    } catch {}
    return null;
  }

  let port = 8188;
  if (existsSync(portFile)) {
    try {
      port = parseInt(readFileSync(portFile, "utf-8").trim(), 10) || 8188;
    } catch {}
  }

  return { pid, port };
}

/**
 * Gracefully kill a running daemon process.
 */
export function killDaemonProcess(pid: number, timeoutMs = 3000): boolean {
  if (!isPidAlive(pid)) return true;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isPidAlive(pid);
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    try {
      execSync("sleep 0.05");
    } catch {}
  }

  // Force kill if SIGTERM didn't succeed
  try {
    process.kill(pid, "SIGKILL");
  } catch {}

  return !isPidAlive(pid);
}
