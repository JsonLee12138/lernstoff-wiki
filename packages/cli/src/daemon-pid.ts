import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { LERNSTOFF_DIR } from "@lernstoff/core/config";

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

export interface DiscoveredDaemon {
  pid: number;
  vaultPath: string;
  port?: number;
  requestedPort?: number;
  uptime?: number;
  isOrphanedVault: boolean;
  status: "running" | "unhealthy" | "orphaned";
}

/**
 * Scan the OS process table for all running Lernstoff daemons across any Vault.
 * Zero global file state: 100% derived from live process inspection and local vault health checks.
 */
export async function listAllRunningDaemons(): Promise<DiscoveredDaemon[]> {
  const discovered: DiscoveredDaemon[] = [];
  const seenPids = new Set<number>();

  let psOutput = "";
  try {
    if (process.platform === "win32") {
      psOutput = execSync(
        `wmic process where "name like '%node%' or name like '%lernstoff%'" get ProcessId,CommandLine /format:csv`,
        { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
      ).toString("utf-8");
    } else {
      psOutput = execSync("ps -ax -o pid=,command=", {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).toString("utf-8");
    }
  } catch {
    return [];
  }

  const lines = psOutput.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || !looksLikeLernstoffDaemon(line)) continue;
    // Check if process is running a server command
    if (!line.includes("server") || (!line.includes("start") && !line.includes("daemon-server"))) {
      continue;
    }

    let pid: number | null = null;
    if (process.platform === "win32") {
      const parts = line.split(",");
      const pidStr = parts[parts.length - 1]?.trim();
      if (pidStr && /^\d+$/.test(pidStr)) pid = parseInt(pidStr, 10);
    } else {
      const m = line.trim().match(/^(\d+)\s+/);
      if (m && m[1]) pid = parseInt(m[1], 10);
    }

    if (!pid || pid === process.pid || seenPids.has(pid)) continue;
    if (!isPidAlive(pid)) continue;
    seenPids.add(pid);

    // Extract vault path: e.g. --vault /path/to/vault or --vault="/path/to/vault"
    const vaultMatch = line.match(/--vault(?:=|\s+)("([^"]+)"|'([^']+)'|([^\s]+))/);
    let vaultPath = "";
    if (vaultMatch) {
      vaultPath = resolve(vaultMatch[2] || vaultMatch[3] || vaultMatch[4] || "");
    }
    if (!vaultPath) continue;

    const isOrphanedVault = !existsSync(vaultPath);

    // Try reading local daemon.port
    let port: number | undefined;
    const portFile = join(vaultPath, LERNSTOFF_DIR, "daemon.port");
    if (existsSync(portFile)) {
      try {
        const parsed = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) port = parsed;
      } catch {}
    }

    // Also check if --port <port> was explicitly passed in cmdline
    if (!port) {
      const portMatch = line.match(/--port(?:=|\s+)(\d+)/);
      if (portMatch && portMatch[1]) {
        port = parseInt(portMatch[1], 10);
      }
    }

    let status: DiscoveredDaemon["status"] = isOrphanedVault ? "orphaned" : "running";
    let uptime: number | undefined;
    let requestedPort: number | undefined;

    if (port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(400),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (data && data.status === "ok") {
            uptime = data.uptime;
            requestedPort = data.requestedPort;
            if (data.vault && resolve(String(data.vault)) !== vaultPath) {
              // Port collision with a different vault
              status = "unhealthy";
            }
          }
        } else {
          if (!isOrphanedVault) status = "unhealthy";
        }
      } catch {
        if (!isOrphanedVault) status = "unhealthy";
      }
    }

    discovered.push({
      pid,
      vaultPath,
      port,
      requestedPort,
      uptime,
      isOrphanedVault,
      status,
    });
  }

  return discovered;
}

/**
 * Stop all running Lernstoff daemons found across the system.
 */
export async function stopAllRunningDaemons(): Promise<{ stopped: number; errors: string[] }> {
  const daemons = await listAllRunningDaemons();
  let stopped = 0;
  const errors: string[] = [];

  for (const d of daemons) {
    const ok = killDaemonProcess(d.pid);
    if (ok) {
      stopped++;
      // Clean up PID/port files if vault directory exists
      if (d.vaultPath && existsSync(d.vaultPath)) {
        try {
          const pidFile = join(d.vaultPath, LERNSTOFF_DIR, "daemon.pid");
          if (existsSync(pidFile)) unlinkSync(pidFile);
        } catch {}
        try {
          const portFile = join(d.vaultPath, LERNSTOFF_DIR, "daemon.port");
          if (existsSync(portFile)) unlinkSync(portFile);
        } catch {}
      }
    } else {
      errors.push(`Failed to stop process PID ${d.pid} (${d.vaultPath})`);
    }
  }

  return { stopped, errors };
}
