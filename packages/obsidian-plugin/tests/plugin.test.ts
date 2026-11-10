import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { initVault } from "@lernstoff/core";
import { DEFAULT_LERNSTOFF_CONFIG } from "@lernstoff/core/config";
import { DaemonClient } from "../src/daemon-client.js";

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
        res.end(JSON.stringify({ status: "ok", port: testPort, pid: 1234 }));
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
});
