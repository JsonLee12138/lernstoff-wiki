import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QmdBridge } from "../src/qmd-bridge.js";
import { initVault } from "../src/vault-init.js";

describe("QMD SDK Bridge (qmd-bridge)", { timeout: 30_000 }, () => {
  let tempDir: string;
  let bridge: QmdBridge;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-bridge-test-"));
    await initVault(tempDir);
    bridge = new QmdBridge({ vaultPath: tempDir });
  });

  afterEach(async () => {
    await bridge.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("initializes QMD store and returns valid index status", async () => {
    const status = await bridge.getStatus();
    expect(status).toBeDefined();
    expect(typeof status.totalDocuments).toBe("number");
  });

  it("reranks passages with mock or fallback scorer", async () => {
    const query = "PostgreSQL ACID transaction concurrency";
    const docs = [
      "PostgreSQL uses MVCC to provide ACID transaction consistency under high concurrency.",
      "Redis is an in-memory key-value cache with lightweight transaction support.",
      "Weather forecast for tomorrow is sunny.",
    ];

    const scores = await bridge.rerankPassages(query, docs);
    expect(scores.length).toBe(3);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[1]).toBeGreaterThan(scores[2]!);
  });

  it("classifies entailment accurately into ENTAILS_KNOWN, EXTENDS_BOUNDARY, or CONTRADICTS_CLAIM", async () => {
    const existing =
      "PostgreSQL multi-version concurrency control ensures reads never block writes.";

    // Entails known (same core proposition, minor stopword difference, novelty < 0.15)
    const entails = await bridge.classifyEntailment(
      "PostgreSQL multi-version concurrency control ensures that reads never block writes.",
      existing,
    );
    expect(entails).toBe("ENTAILS_KNOWN");

    // Contradicts claim (explicit contradiction signal)
    const contradicts = await bridge.classifyEntailment(
      "Contrary to common belief, PostgreSQL table-level lock conflicts cause reads to block writes under schema alter.",
      existing,
    );
    expect(contradicts).toBe("CONTRADICTS_CLAIM");

    // Extends boundary (new facts/parameters)
    const extendsBoundary = await bridge.classifyEntailment(
      "PostgreSQL MVCC vacuum autovacuum_vacuum_scale_factor defaults to 0.2 to prevent table bloat.",
      existing,
    );
    expect(extendsBoundary).toBe("EXTENDS_BOUNDARY");
  });
});
