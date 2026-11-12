import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { initVault } from "@lernstoff/core";
import { DEFAULT_LERNSTOFF_CONFIG, loadConfig, saveConfig } from "@lernstoff/core/config";
import { DaemonClient } from "../src/daemon-client.js";

async function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolvePort(addr.port);
      } else {
        reject(new Error("Failed to bind ephemeral port"));
      }
    });
  });
}

describe("Obsidian Plugin DaemonClient & Settings Synchronization", () => {
  let tempDir: string;
  let client: DaemonClient;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-obsidian-test-"));
    await initVault(tempDir);
    client = new DaemonClient(tempDir);
  });

  afterEach(() => {
    client.destroy();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads config with zero-config out-of-the-box defaults", () => {
    const config = client.loadLocalConfig();
    expect(config.version).toBe(DEFAULT_LERNSTOFF_CONFIG.version);
    expect(config.server.port).toBe(8188);
    expect(config.gate.tauOff).toBe(0.35);
    expect(config.gate.tauCore).toBe(0.65);
    expect(config.socratic.minOutboundLinks).toBe(2);
  });

  it("updates and persists configuration back to .lernstoff/config.json", () => {
    const config = client.loadLocalConfig();
    config.gate.tauCore = 0.72;
    config.scratchpad.ttlDays = 21;

    client.updateConfig(config);

    const reloadedClient = new DaemonClient(tempDir);
    const reloaded = reloadedClient.loadLocalConfig();
    expect(reloaded.gate.tauCore).toBe(0.72);
    expect(reloaded.scratchpad.ttlDays).toBe(21);
  });

  it("detects running daemon and notifies status listeners", async () => {
    const testPort = 8492;
    // Create a mock daemon server
    const mockDaemon = createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok", port: testPort, pid: 1234, vault: tempDir }));
      } else if (req.url === "/api/status") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            metrics: {
              conceptNotes: 10,
              totalInquiries: 3,
              openInquiries: 2,
              scratchpadTotal: 5,
              scratchpadPromotionsReady: 1,
            },
          }),
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    });

    await new Promise<void>((resolve) => mockDaemon.listen(testPort, "127.0.0.1", () => resolve()));

    try {
      // Write daemon port file
      writeFileSync(join(tempDir, ".lernstoff/daemon.port"), String(testPort), "utf-8");

      let receivedStatus: any;
      client.onStatus((status) => {
        receivedStatus = status;
      });

      const isRunning = await client.checkDaemon();
      expect(isRunning).toBe(true);
      expect(client.port).toBe(testPort);
      expect(receivedStatus).toBeDefined();
      expect(receivedStatus.running).toBe(true);
      expect(client.metrics?.conceptNotes).toBe(10);
      expect(client.metrics?.openInquiries).toBe(2);
    } finally {
      await new Promise<void>((resolve) => mockDaemon.close(() => resolve()));
    }
  });

  it("handles offline daemon gracefully without throwing", async () => {
    const isRunning = await client.checkDaemon();
    expect(isRunning).toBe(false);
    expect(client.isRunning).toBe(false);
  });

  it("ensures .lernstoff directory exists when starting daemon", async () => {
    const uninitDir = mkdtempSync(join(tmpdir(), "lernstoff-uninit-"));
    const testClient = new DaemonClient(uninitDir);
    testClient.cliPathOverride = join(uninitDir, "missing-lernstoff-bin");
    try {
      expect(existsSync(join(uninitDir, ".lernstoff"))).toBe(false);

      // startDaemon ensures .lernstoff directory even if CLI binary is offline
      const ok = await testClient.startDaemon();
      expect(existsSync(join(uninitDir, ".lernstoff"))).toBe(true);
      expect(typeof ok).toBe("boolean");
    } finally {
      await testClient.stopDaemon();
      testClient.destroy();
      if (existsSync(uninitDir)) {
        rmSync(uninitDir, { recursive: true, force: true });
      }
    }
  });

  it("normalizes vaultPath via resolve() and syncs port on loadLocalConfig / updateConfig when offline", () => {
    const unnormalized = join(tempDir, ".", "nested", "..");
    const normClient = new DaemonClient(unnormalized);
    try {
      expect(normClient.vaultPath).toBe(resolve(tempDir));

      saveConfig(tempDir, { server: { ...DEFAULT_LERNSTOFF_CONFIG.server, port: 9123 } });
      normClient.loadLocalConfig();
      expect(normClient.port).toBe(9123);

      let notifiedCount = 0;
      normClient.onStatus(() => {
        notifiedCount += 1;
      });

      normClient.config.server.port = 9234;
      normClient.updateConfig(normClient.config);
      expect(normClient.port).toBe(9234);
      expect(notifiedCount).toBe(1);
    } finally {
      normClient.destroy();
    }
  });

  it("resolves NVM >= 20 binaries descending, falls back to homedir(), and prepends dirname(cmd) to PATH", () => {
    const fakeHome = join(tempDir, "fake-home");
    for (const ver of ["v18.20.0", "v20.11.0", "v22.2.0", "v22.14.0"]) {
      const binDir = join(fakeHome, ".nvm", "versions", "node", ver, "bin");
      mkdirSync(binDir, { recursive: true });
      const binFile = join(binDir, "lernstoff");
      writeFileSync(binFile, "#!/bin/sh\nexit 0\n", "utf-8");
      chmodSync(binFile, 0o755);
    }

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origPath = process.env.PATH;

    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      process.env.PATH = "/usr/bin:/bin";

      const resolved = client.resolveCommand();
      const expectedCmd = join(fakeHome, ".nvm/versions/node/v22.14.0/bin/lernstoff");
      expect(resolved.cmd).toBe(expectedCmd);

      const env = client.getSpawnEnv(resolved.cmd);
      const pathEntries = (env.PATH || "").split(":");
      expect(pathEntries[0]).toBe(join(fakeHome, ".nvm/versions/node/v22.14.0/bin"));
      expect(pathEntries).not.toContain(join(fakeHome, ".nvm/versions/node/v18.20.0/bin"));

      delete process.env.HOME;
      delete process.env.USERPROFILE;
      const fallbackEnv = client.getSpawnEnv();
      expect(fallbackEnv.PATH).toContain(join(homedir(), ".local/bin"));
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
    }
  });

  it("cleans up stale dead daemon.pid / daemon.port and rejects mismatched vault in checkDaemon()", async () => {
    const pidFile = join(tempDir, ".lernstoff/daemon.pid");
    const portFile = join(tempDir, ".lernstoff/daemon.port");
    writeFileSync(pidFile, "999999", "utf-8");
    writeFileSync(portFile, "8599", "utf-8");

    const deadCheck = await client.checkDaemon();
    expect(deadCheck).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
    expect(existsSync(portFile)).toBe(false);

    const otherServer = createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            status: "ok",
            port: 0,
            pid: process.pid,
            vault: join(tempDir, "../other-vault"),
          }),
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    const otherPort = await listenEphemeral(otherServer);
    try {
      writeFileSync(portFile, String(otherPort), "utf-8");
      expect(await client.checkDaemon()).toBe(false);
      expect(client.isRunning).toBe(false);
    } finally {
      otherServer.closeAllConnections?.();
      await new Promise<void>((r) => otherServer.close(() => r()));
    }
  });

  it("preserves staged config.server.port (P2) while daemon runs on P1 across checkDaemon() polls (AC-3)", async () => {
    const mockDaemon = createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            status: "ok",
            port: port1,
            requestedPort: port1,
            pid: process.pid,
            vault: join(tempDir, "."),
          }),
        );
      } else if (req.url === "/api/status") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            metrics: {
              conceptNotes: 1,
              totalInquiries: 0,
              openInquiries: 0,
              scratchpadTotal: 0,
              scratchpadPromotionsReady: 0,
            },
          }),
        );
      } else if (req.url === "/api/reload-config") {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    const port1 = await listenEphemeral(mockDaemon);
    const port2 = port1 + 10;

    try {
      writeFileSync(join(tempDir, ".lernstoff/daemon.port"), String(port1), "utf-8");
      expect(await client.checkDaemon()).toBe(true);
      expect(client.port).toBe(port1);

      // Stage new port P2 while running on P1
      client.config.server.port = port2;
      client.updateConfig(client.config);

      expect(client.port).toBe(port1);
      expect(client.config.server.port).toBe(port2);
      expect(loadConfig(tempDir).server.port).toBe(port2);

      // Polling checkDaemon() must NOT overwrite staged P2 with old P1
      expect(await client.checkDaemon()).toBe(true);
      expect(client.port).toBe(port1);
      expect(client.config.server.port).toBe(port2);
    } finally {
      mockDaemon.closeAllConnections?.();
      await new Promise<void>((r) => mockDaemon.close(() => r()));
    }
  });

  it("aborts SSE connection first, resets port to staged config, and clears lastPortFallback on stopDaemon()", async () => {
    let sseConnectedResolve!: () => void;
    const sseConnected = new Promise<void>((r) => {
      sseConnectedResolve = r;
    });
    let sseAborted = false;
    let acceptHealth = true;
    const mockDaemon = createServer((req, res) => {
      if (req.url === "/health" && acceptHealth) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok", port: livePort, pid: process.pid, vault: tempDir }));
      } else if (req.url === "/api/status") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            metrics: {
              conceptNotes: 0,
              totalInquiries: 0,
              openInquiries: 0,
              scratchpadTotal: 0,
              scratchpadPromotionsReady: 0,
            },
          }),
        );
      } else if (req.url === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        res.write("event: connected\ndata: {}\n\n");
        sseConnectedResolve();
        req.on("close", () => {
          sseAborted = true;
        });
      } else {
        res.statusCode = 503;
        res.end();
      }
    });
    const livePort = await listenEphemeral(mockDaemon);
    const stagedPort = livePort + 25;

    const fakeCli = join(tempDir, "stop-shim.mjs");
    writeFileSync(
      fakeCli,
      `#!/usr/bin/env node\nimport { unlinkSync, existsSync } from "node:fs";\nconst portFile = ${JSON.stringify(join(tempDir, ".lernstoff/daemon.port"))};\nif (existsSync(portFile)) unlinkSync(portFile);\n`,
      "utf-8",
    );
    chmodSync(fakeCli, 0o755);
    client.cliPathOverride = fakeCli;

    try {
      writeFileSync(join(tempDir, ".lernstoff/daemon.port"), String(livePort), "utf-8");
      expect(await client.checkDaemon()).toBe(true);
      await sseConnected;

      client.lastPortFallback = { requestedPort: livePort - 1, actualPort: livePort };
      client.config.server.port = stagedPort;

      acceptHealth = false;
      const t0 = Date.now();
      const stopped = await client.stopDaemon();
      const elapsed = Date.now() - t0;

      for (let i = 0; i < 20 && !sseAborted; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(stopped).toBe(true);
      expect(elapsed).toBeLessThan(2000);
      expect(sseAborted).toBe(true);
      expect(client.isRunning).toBe(false);
      expect(client.port).toBe(stagedPort);
      expect(client.lastPortFallback).toBeUndefined();
    } finally {
      mockDaemon.closeAllConnections?.();
      await new Promise<void>((r) => mockDaemon.close(() => r()));
    }
  });

  it("actively detects running daemon on configured port when daemon.port file is missing and self-heals file", async () => {
    let mockServer!: Server;
    const mockDaemon = createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ status: "ok", port: configuredPort, pid: process.pid, vault: tempDir }),
        );
      } else if (req.url === "/api/status") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            metrics: {
              conceptNotes: 0,
              totalInquiries: 0,
              openInquiries: 0,
              scratchpadTotal: 0,
              scratchpadPromotionsReady: 0,
            },
          }),
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    mockServer = mockDaemon;
    const configuredPort = await listenEphemeral(mockDaemon);
    client.config.server.port = configuredPort;

    // Notice: NO daemon.port file written!
    const portFile = join(tempDir, ".lernstoff/daemon.port");
    expect(existsSync(portFile)).toBe(false);

    try {
      const isRunning = await client.checkDaemon();
      expect(isRunning).toBe(true);
      expect(client.isRunning).toBe(true);
      expect(client.port).toBe(configuredPort);

      // Verify self-healing: daemon.port file was restored
      expect(existsSync(portFile)).toBe(true);
      expect(readFileSync(portFile, "utf-8")).toBe(String(configuredPort));
    } finally {
      mockServer.closeAllConnections?.();
      await new Promise<void>((r) => mockServer.close(() => r()));
    }
  });

  it("rejects connection when /health responds with a different vault path (security guard)", async () => {
    const mockDaemon = createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            status: "ok",
            port: testPort,
            pid: process.pid,
            vault: "/different/unrelated/vault",
          }),
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    const testPort = await listenEphemeral(mockDaemon);
    client.config.server.port = testPort;

    try {
      const isRunning = await client.checkDaemon();
      expect(isRunning).toBe(false);
      expect(client.isRunning).toBe(false);
    } finally {
      mockDaemon.closeAllConnections?.();
      await new Promise<void>((r) => mockDaemon.close(() => r()));
    }
  });

  it("rejects connection when /health is missing vault property altogether (third-party endpoint guard)", async () => {
    const mockDaemon = createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("Content-Type", "application/json");
        // Emulates a third-party non-Lernstoff service that has a /health endpoint returning { status: "ok" }
        res.end(JSON.stringify({ status: "ok", uptime: 123 }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    const testPort = await listenEphemeral(mockDaemon);
    client.config.server.port = testPort;

    try {
      const isRunning = await client.checkDaemon();
      expect(isRunning).toBe(false);
      expect(client.isRunning).toBe(false);
    } finally {
      mockDaemon.closeAllConnections?.();
      await new Promise<void>((r) => mockDaemon.close(() => r()));
    }
  });

  it("idempotently returns true on startDaemon() without spawning when already online on configured port", async () => {
    const mockDaemon = createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok", port: testPort, pid: process.pid, vault: tempDir }));
      } else if (req.url === "/api/status") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            metrics: {
              conceptNotes: 0,
              totalInquiries: 0,
              openInquiries: 0,
              scratchpadTotal: 0,
              scratchpadPromotionsReady: 0,
            },
          }),
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    const testPort = await listenEphemeral(mockDaemon);
    client.config.server.port = testPort;

    // Deliberately set an invalid CLI path that would fail if spawn was actually called
    client.cliPathOverride = "/nonexistent/invalid/cli";

    try {
      // First checkDaemon connects
      expect(await client.checkDaemon()).toBe(true);

      // Calling startDaemon() should be idempotent and succeed without spawning
      const started = await client.startDaemon();
      expect(started).toBe(true);
      expect(client.isRunning).toBe(true);
    } finally {
      mockDaemon.closeAllConnections?.();
      await new Promise<void>((r) => mockDaemon.close(() => r()));
    }
  });
});
