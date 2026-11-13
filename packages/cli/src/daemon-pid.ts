import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { LERNSTOFF_DIR, getVaultAlias } from "@lernstoff/core/config";

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

export function cleanupDaemonStateFiles(vaultPath: string): void {
  if (!vaultPath || !existsSync(vaultPath)) return;
  const lernstoffDir = join(resolve(vaultPath), LERNSTOFF_DIR);
  for (const name of ["daemon.pid", "daemon.port", "daemon.alias"]) {
    try {
      const f = join(lernstoffDir, name);
      if (existsSync(f)) unlinkSync(f);
    } catch {}
  }
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

  const killStart = Date.now();
  while (Date.now() - killStart < 500) {
    if (!isPidAlive(pid)) return true;
    try {
      execSync("sleep 0.02");
    } catch {}
  }

  return !isPidAlive(pid);
}

export interface DiscoveredDaemon {
  pid: number;
  vaultPath: string;
  alias?: string;
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
    if (
      !line.includes("server") ||
      (!line.includes("start") && !line.includes("restart") && !line.includes("daemon-server"))
    ) {
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

    // Extract vault path: handles quoted paths and unquoted paths with spaces from ps output
    const vaultMatch = line.match(
      /--vault(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(.+?))(?=\s+--[a-zA-Z-]+|$)/,
    );
    let vaultPath = "";
    if (vaultMatch) {
      const rawVault = (vaultMatch[1] || vaultMatch[2] || vaultMatch[3] || "").trim();
      if (rawVault) vaultPath = resolve(rawVault);
    }
    if (!vaultPath && process.platform !== "win32") {
      try {
        const lsofOut = execSync(`lsof -p ${pid} -a -d cwd -Fn`, {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 600,
        }).toString("utf-8");
        const cwdLine = lsofOut.split(/\r?\n/).find((l) => l.startsWith("n"));
        if (cwdLine && cwdLine.length > 1) {
          vaultPath = resolve(cwdLine.slice(1).trim());
        }
      } catch {}
    }
    if (!vaultPath) continue;

    const isOrphanedVault = !existsSync(vaultPath);
    let alias: string | undefined = getVaultAlias(vaultPath);
    const aliasFile = join(vaultPath, LERNSTOFF_DIR, "daemon.alias");
    if (existsSync(aliasFile)) {
      try {
        const parsedAlias = readFileSync(aliasFile, "utf-8").trim();
        if (parsedAlias) alias = parsedAlias;
      } catch {}
    }

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
            if (typeof data.alias === "string" && data.alias.trim()) {
              alias = data.alias.trim();
            }
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
      alias,
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
export async function stopAllRunningDaemons(options?: {
  stopSupervision?: (vaultPath: string) => void;
}): Promise<{ stopped: number; errors: string[] }> {
  const daemons = await listAllRunningDaemons();
  let stopped = 0;
  const errors: string[] = [];

  for (const d of daemons) {
    if (d.vaultPath && options?.stopSupervision) {
      try {
        options.stopSupervision(d.vaultPath);
      } catch {}
    }
    const ok = killDaemonProcess(d.pid);
    if (ok) {
      stopped++;
      cleanupDaemonStateFiles(d.vaultPath);
    } else {
      errors.push(`Failed to stop process PID ${d.pid} (${d.vaultPath})`);
    }
  }

  return { stopped, errors };
}
