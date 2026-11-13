import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile, execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "../..");
export const CLI_BIN_PATH = join(REPO_ROOT, "packages/cli/dist/bin.mjs");

export interface CliExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface E2eSandbox {
  rootDir: string;
  vaultDir: string;
  externalCwd: string;
  homeDir: string;
  binDir: string;
  port: number;
  env: NodeJS.ProcessEnv;
  runCli: (
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<CliExecResult>;
  seedPortConfig: (port?: number) => void;
  waitForDaemonHealth: (port?: number, timeoutMs?: number) => Promise<any>;
  cleanup: () => Promise<void>;
}

/**
 * Allocates an ephemeral free localhost TCP port in high range via OS kernel bind(0).
 */
export async function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("Failed to allocate free TCP port")));
      }
    });
  });
}

/**
 * Creates a strictly isolated E2E sandbox:
 * - Isolated Vault directory (`vaultDir`)
 * - Isolated external working directory (`externalCwd`)
 * - Isolated `$HOME` / `USERPROFILE` / `XDG_CONFIG_HOME` (`homeDir`) so tests NEVER touch host `~/`
 * - Executable `lernstoff` shim in `homeDir/.local/bin/lernstoff` pointing to workspace `packages/cli/dist/bin.mjs`
 * - Safe teardown that terminates ONLY processes whose command line references `vaultDir`
 */
export async function createE2eSandbox(options: { seedPort?: boolean } = {}): Promise<E2eSandbox> {
  if (!existsSync(CLI_BIN_PATH)) {
    throw new Error(
      `Missing built CLI binary at ${CLI_BIN_PATH}. Run 'pnpm build' before running E2E tests.`,
    );
  }

  const rootDir = mkdtempSync(join(tmpdir(), "lernstoff-e2e-"));
  const vaultDir = join(rootDir, "vault");
  const externalCwd = join(rootDir, "external-cwd");
  const homeDir = join(rootDir, "home");
  const binDir = join(homeDir, ".local", "bin");

  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(externalCwd, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Create executable CLI wrapper inside sandbox HOME/.local/bin/lernstoff
  const wrapperPath = join(binDir, "lernstoff");
  const wrapperScript = `#!/bin/sh\nexec "${process.execPath}" "${CLI_BIN_PATH}" "$@"\n`;
  writeFileSync(wrapperPath, wrapperScript, "utf-8");
  chmodSync(wrapperPath, 0o755);

  // Create safe launchctl / systemctl shims in binDir so E2E tests never mutate host OS launchd/systemd
  const serviceCallsLog = join(rootDir, "service-calls.log");
  for (const svcBin of ["launchctl", "systemctl"]) {
    const shimPath = join(binDir, svcBin);
    writeFileSync(
      shimPath,
      `#!/bin/sh\necho "${svcBin} $*" >> "${serviceCallsLog}"\nexit 0\n`,
      "utf-8",
    );
    chmodSync(shimPath, 0o755);
  }

  const port = await allocateFreePort();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    PATH: `${binDir}:${dirname(process.execPath)}:${process.env.PATH || ""}`,
    NO_COLOR: "1",
    LERNSTOFF_PARENT_PID: String(process.pid),
  };
  // Ensure VITEST env does not force 100ms mock-only behavior in real subprocess E2E runs
  delete env.VITEST;

  const seedPortConfig = (customPort = port) => {
    const lernstoffDir = join(vaultDir, ".lernstoff");
    mkdirSync(lernstoffDir, { recursive: true });
    const configPath = join(lernstoffDir, "config.json");
    let existing: Record<string, any> = {};
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        existing = {};
      }
    }
    existing.server = {
      ...existing.server,
      host: "127.0.0.1",
      port: customPort,
    };
    writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf-8");
  };

  if (options.seedPort !== false) {
    seedPortConfig(port);
  }

  const runCli = (
    args: string[],
    execOpts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<CliExecResult> => {
    const cwd = execOpts.cwd || vaultDir;
    const timeout = execOpts.timeoutMs ?? 15_000;
    return new Promise((resolveRun) => {
      execFile(
        process.execPath,
        [CLI_BIN_PATH, ...args],
        { cwd, env, timeout },
        (error, stdout, stderr) => {
          const exitCode =
            error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
          resolveRun({
            code: exitCode,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        },
      );
    });
  };

  const waitForDaemonHealth = async (targetPort?: number, timeoutMs = 8000): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    const portFile = join(vaultDir, ".lernstoff", "daemon.port");
    while (Date.now() < deadline) {
      let probePort = targetPort;
      if (!probePort && existsSync(portFile)) {
        const parsed = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          probePort = parsed;
        }
      }
      if (probePort) {
        try {
          const res = await fetch(`http://127.0.0.1:${probePort}/health`, {
            signal: AbortSignal.timeout(500),
          });
          if (res.ok) {
            return await res.json();
          }
        } catch {
          // retry
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for daemon /health in ${vaultDir}`);
  };

  const cleanup = async () => {
    // If any LaunchAgent plist was generated inside sandbox HOME on macOS, unload it before rmSync
    if (process.platform === "darwin") {
      const launchAgentsDir = join(homeDir, "Library", "LaunchAgents");
      if (existsSync(launchAgentsDir)) {
        try {
          const { readdirSync } = await import("node:fs");
          for (const file of readdirSync(launchAgentsDir)) {
            if (file.endsWith(".plist")) {
              try {
                execSync(`launchctl unload "${join(launchAgentsDir, file)}"`, {
                  stdio: "ignore",
                  timeout: 2000,
                });
              } catch {}
            }
          }
        } catch {}
      }
    }

    // Safely stop any daemon bound to THIS sandbox vaultDir only
    const pidFile = join(vaultDir, ".lernstoff", "daemon.pid");
    const candidatePids = new Set<number>();

    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (Number.isInteger(pid) && pid > 0) candidatePids.add(pid);
      } catch {}
    }

    // Also scan `ps` for any detached daemon explicitly referencing this sandbox's unique vaultDir
    try {
      const psOut = execSync("ps -ax -o pid=,command=", {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).toString("utf-8");
      for (const line of psOut.split("\n")) {
        if (line.includes(vaultDir)) {
          const m = line.trim().match(/^(\d+)\s+/);
          if (m && m[1]) {
            candidatePids.add(parseInt(m[1], 10));
          }
        }
      }
    } catch {}

    for (const pid of candidatePids) {
      try {
        const cmd = execSync(`ps -p ${pid} -o command=`, {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1000,
        }).toString("utf-8");
        if (!cmd.includes(vaultDir)) continue;
        process.kill(pid, "SIGTERM");
      } catch {
        continue;
      }

      const stopDeadline = Date.now() + 2000;
      while (Date.now() < stopDeadline) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 50));
        } catch {
          break;
        }
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  };

  return {
    rootDir,
    vaultDir,
    externalCwd,
    homeDir,
    binDir,
    port,
    env,
    runCli,
    seedPortConfig,
    waitForDaemonHealth,
    cleanup,
  };
}

/**
 * Real MCP Stdio JSON-RPC 2.0 Client.
 * Spawns `lernstoff mcp --vault <vaultDir>` and communicates strictly via newline-delimited JSON-RPC on stdin/stdout.
 * Fails immediately if non-JSON frames (such as raw HTTP SSE `event: message` lines) leak onto stdout.
 */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private protocolError: Error | null = null;

  constructor(vaultDir: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [CLI_BIN_PATH, "mcp", "--vault", vaultDir], {
      cwd: vaultDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({
      input: this.child.stdout,
      terminal: false,
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        const err = new Error(
          `MCP Stdio protocol violation: non-JSON line emitted on stdout: ${JSON.stringify(trimmed)}`,
        );
        this.protocolError = err;
        for (const [, waiter] of this.pending) {
          clearTimeout(waiter.timer);
          waiter.reject(err);
        }
        this.pending.clear();
        return;
      }

      if (msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
        const waiter = this.pending.get(msg.id)!;
        clearTimeout(waiter.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          waiter.reject(new Error(`JSON-RPC Error (${msg.error.code}): ${msg.error.message}`));
        } else {
          waiter.resolve(msg.result);
        }
      }
    });

    this.child.on("exit", (code) => {
      const err =
        this.protocolError || new Error(`MCP stdio process exited prematurely (code ${code})`);
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
      this.pending.clear();
    });
  }

  public async request(
    method: string,
    params?: Record<string, any>,
    timeoutMs = 10_000,
  ): Promise<any> {
    if (this.protocolError) {
      throw this.protocolError;
    }
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  public notify(method: string, params?: Record<string, any>): void {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
    this.child.stdin.write(`${payload}\n`);
  }

  public async initialize(): Promise<any> {
    const initRes = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lernstoff-e2e-client", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
    return initRes;
  }

  public async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    return this.request("tools/call", { name, arguments: args });
  }

  public async close(): Promise<void> {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
    }
    this.pending.clear();
    try {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Helper to check if a file exists and is non-empty on disk.
 */
export function isNonEmptyFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    return statSync(filePath).size > 0;
  } catch {
    return false;
  }
}
