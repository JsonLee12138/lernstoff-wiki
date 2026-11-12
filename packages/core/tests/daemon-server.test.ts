import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { createServer, get as httpGet } from "node:http";
import { initVault } from "../src/vault-init.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { QmdBridge } from "../src/qmd-bridge.js";
import { DaemonServer } from "../src/daemon-server.js";

async function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolvePort(p));
      } else {
        srv.close(() => reject(new Error("Failed to allocate free port")));
      }
    });
  });
}

describe("Unified Background HTTP/SSE Daemon Server", () => {
  let tempDir: string;
  let basePort: number;
  let bridge: QmdBridge;
  let daemon: DaemonServer;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-daemon-test-"));
    await initVault(tempDir);
    basePort = await allocateFreePort();
    saveConfig(tempDir, {
      server: { ...loadConfig(tempDir).server, port: basePort },
    });

    bridge = new QmdBridge({
      vaultPath: tempDir,
      mockSearch: async () => [],
    });

    daemon = new DaemonServer({
      vaultPath: tempDir,
      qmdBridge: bridge,
    });
  });

  afterEach(async () => {
    await daemon.stop();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("starts on available port, writes daemon.port/daemon.pid, and responds to GET /health with requestedPort", async () => {
    const port = await daemon.start();
    expect(port).toBeGreaterThanOrEqual(basePort);

    const portFile = join(tempDir, ".lernstoff/daemon.port");
    const pidFile = join(tempDir, ".lernstoff/daemon.pid");
    expect(existsSync(portFile)).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    expect(readFileSync(portFile, "utf-8")).toBe(String(port));
    expect(readFileSync(pidFile, "utf-8")).toBe(String(process.pid));

    // Test GET /health
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const health = await res.json();
    expect(health.status).toBe("ok");
    expect(health.port).toBe(port);
    expect(health.requestedPort).toBe(basePort);
    expect(health.pid).toBe(process.pid);
  });

  it("handles REST endpoints (/api/inquiries, /api/status, /api/reload-config)", async () => {
    const port = await daemon.start();

    // 1. Add inquiry via POST /api/inquiries
    const addInqRes = await fetch(`http://127.0.0.1:${port}/api/inquiries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        question: "Does asynchronous checkpointing eliminate fsync latency spikes?",
      }),
    });
    expect(addInqRes.status).toBe(200);
    const inqData = await addInqRes.json();
    expect(inqData.inquiry.id).toMatch(/^#q-\d+$/);

    // 2. Query status via GET /api/status
    const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.metrics.openInquiries).toBeGreaterThanOrEqual(2);

    // 3. Reload config via POST /api/reload-config
    const reloadRes = await fetch(`http://127.0.0.1:${port}/api/reload-config`, {
      method: "POST",
    });
    expect(reloadRes.status).toBe(200);
    const reloadData = await reloadRes.json();
    expect(reloadData.success).toBe(true);
  });

  it("streams real-time SSE events via GET /api/events", async () => {
    const port = await daemon.start();

    let clientReq: any;
    const eventPromise = new Promise<string>((resolve) => {
      clientReq = httpGet(`http://127.0.0.1:${port}/api/events`, (res) => {
        res.on("data", (chunk) => {
          const text = chunk.toString();
          if (text.includes("inquiries_changed")) {
            resolve(text);
          }
        });
      });
    });

    // Small delay to allow SSE client registration
    await new Promise((r) => setTimeout(r, 100));

    // Trigger an inquiry change
    await fetch(`http://127.0.0.1:${port}/api/inquiries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", question: "SSE test inquiry" }),
    });

    const receivedEvent = await eventPromise;
    expect(receivedEvent).toContain("inquiries_changed");
    clientReq?.destroy();
  });

  it("auto-increments port when occupied, persists bound port to .lernstoff/config.json, and exposes requestedPort on /health", async () => {
    const dummyServer = createServer((_req, res) => res.end("dummy"));
    const occupiedPort = await allocateFreePort();
    saveConfig(tempDir, {
      server: { ...loadConfig(tempDir).server, port: occupiedPort },
    });

    await new Promise<void>((resolve) =>
      dummyServer.listen(occupiedPort, "127.0.0.1", () => resolve()),
    );

    try {
      const collidingDaemon = new DaemonServer({
        vaultPath: tempDir,
        qmdBridge: bridge,
      });

      const boundPort = await collidingDaemon.start();
      expect(boundPort).toBeGreaterThan(occupiedPort);
      expect(collidingDaemon.requestedPort).toBe(occupiedPort);
      expect(collidingDaemon.config.server.port).toBe(boundPort);
      expect(loadConfig(tempDir).server.port).toBe(boundPort);

      const healthRes = await fetch(`http://127.0.0.1:${boundPort}/health`);
      expect(healthRes.status).toBe(200);
      const health = await healthRes.json();
      expect(health.port).toBe(boundPort);
      expect(health.requestedPort).toBe(occupiedPort);

      await collidingDaemon.stop();
    } finally {
      await new Promise<void>((resolve) => dummyServer.close(() => resolve()));
    }
  });

  it("prevents duplicate instance and throws on port conflict when occupied by same vault", async () => {
    const livePort = await daemon.start();
    expect(loadConfig(tempDir).server.port).toBe(livePort);

    const duplicateDaemon = new DaemonServer({
      vaultPath: tempDir,
      qmdBridge: bridge,
    });

    await expect(duplicateDaemon.start()).rejects.toThrow(
      /is already running on port \d+\. Preventing duplicate instance\./,
    );

    // Config should not be mutated or advanced to livePort + 1
    expect(loadConfig(tempDir).server.port).toBe(livePort);
  });

  it("persists explicit port override to .lernstoff/config.json when config.json has a different port", async () => {
    const customPort = await allocateFreePort();
    expect(loadConfig(tempDir).server.port).toBe(basePort);

    const customDaemon = new DaemonServer({
      vaultPath: tempDir,
      qmdBridge: bridge,
    });
    customDaemon.config.server.port = customPort;

    try {
      const boundPort = await customDaemon.start();
      expect(boundPort).toBe(customPort);
      expect(loadConfig(tempDir).server.port).toBe(customPort);

      const health = await fetch(`http://127.0.0.1:${boundPort}/health`).then((r) => r.json());
      expect(health.port).toBe(customPort);
      expect(health.requestedPort).toBe(customPort);
    } finally {
      await customDaemon.stop();
    }
  });

  it("cleans up daemon.port and daemon.pid on graceful stop", async () => {
    await daemon.start();
    const portFile = join(tempDir, ".lernstoff/daemon.port");
    const pidFile = join(tempDir, ".lernstoff/daemon.pid");
    expect(existsSync(portFile)).toBe(true);

    await daemon.stop();
    expect(existsSync(portFile)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });
});
