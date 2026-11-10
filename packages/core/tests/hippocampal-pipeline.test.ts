import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HippocampalPipeline } from "../src/hippocampal-pipeline.js";
import { QmdBridge } from "../src/qmd-bridge.js";
import { initVault } from "../src/vault-init.js";

describe("Hippocampal Pipeline (3-Stage Epistemic Delta Gate)", () => {
  let tempDir: string;
  let bridge: QmdBridge;
  let pipeline: HippocampalPipeline;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-pipeline-test-"));
    await initVault(tempDir);

    // Setup an inquiry
    const inqPath = join(tempDir, "wiki/inquiries.md");
    writeFileSync(
      inqPath,
      `# Inquiries\n- [OPEN] #q-db: What are the latency and concurrency tradeoffs of PostgreSQL vs in-memory caching?\n`,
      "utf-8",
    );

    // Pre-populate an existing concept note
    const conceptsDir = join(tempDir, "wiki/concepts");
    writeFileSync(
      join(conceptsDir, "postgresql-mvcc-consistency.md"),
      `# PostgreSQL MVCC Consistency\nPostgreSQL uses MVCC to prevent read-write deadlocks and ensure ACID transaction isolation.\n`,
      "utf-8",
    );

    bridge = new QmdBridge({
      vaultPath: tempDir,
      mockSearch: async (options) => {
        const queryText = options.queries
          .map((q) => q.query)
          .join(" ")
          .toLowerCase();
        if (queryText.includes("postgre")) {
          return [
            {
              file: "wiki/concepts/postgresql-mvcc-consistency.md",
              title: "PostgreSQL MVCC Consistency",
              body: "PostgreSQL uses MVCC to prevent read-write deadlocks and ensure ACID transaction isolation.",
              score: 0.95,
            },
          ];
        }
        return [];
      },
      mockReranker: async (query, docs) => {
        return docs.map((doc) => {
          const qLower = query.toLowerCase();
          const dLower = doc.toLowerCase();
          if (qLower.includes("postgre") && dLower.includes("postgre")) return 0.88;
          if (qLower.includes("tradeoff") && dLower.includes("tradeoff")) return 0.85;
          if (qLower.includes("cache") && dLower.includes("cache")) return 0.5; // Defer to scratchpad range
          return 0.1; // Off-topic
        });
      },
      mockClassifier: async (claim) => {
        const cLower = claim.toLowerCase();
        if (cLower.includes("contrary")) return "CONTRADICTS_CLAIM";
        if (cLower.includes("autovacuum")) return "EXTENDS_BOUNDARY";
        if (cLower.includes("tuning")) return "EXTENDS_BOUNDARY";
        return "ENTAILS_KNOWN";
      },
    });

    pipeline = new HippocampalPipeline(tempDir, bridge);
  });

  afterEach(async () => {
    await bridge.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("filters >= 75% noise on a mixed candidate fixture", async () => {
    const sourceText = `
# System Performance Benchmark

PostgreSQL demonstrated sub-5ms transaction commit latencies under 500 concurrent connections.
However, contrary to documentation, lock contention spiked under bulk alterations.
We also reviewed side libraries (such as Memcached, Aerospike, Cassandra, and RocksDB).
The autovacuum threshold was adjusted to prevent table bloat.
`;

    // 20 items:
    // - 5 absent items
    // - 5 parenthetical aside+named items
    // - 4 off-topic items
    // - 2 borderline items (scratchpad)
    // - 1 redundant known
    // - 1 conflict
    // - 2 novel/extensions
    const candidates = [
      // Absent items (Gate 1 discard)
      ...Array.from({ length: 5 }, (_, i) => ({
        entityName: `NonExistentTool${i}`,
        claim: `Claim about tool ${i}`,
        evidence: "None",
        coverage: "named only",
      })),

      // Aside + named items (Gate 1 discard)
      {
        entityName: "Memcached",
        claim: "Memcached was reviewed",
        evidence: "side library",
        coverage: "named only",
      },
      {
        entityName: "Aerospike",
        claim: "Aerospike was reviewed",
        evidence: "side library",
        coverage: "named only",
      },
      {
        entityName: "Cassandra",
        claim: "Cassandra was reviewed",
        evidence: "side library",
        coverage: "named only",
      },
      {
        entityName: "RocksDB",
        claim: "RocksDB was reviewed",
        evidence: "side library",
        coverage: "named only",
      },
      {
        entityName: "Memcached",
        claim: "Memcached caching speeds",
        evidence: "side library",
        coverage: "named only",
      },

      // Off-topic items (Gate 2 discard)
      {
        entityName: "PostgreSQL",
        claim: "Frontend React components re-render on user scroll event.",
        evidence: "GUI",
        coverage: "substantially covered",
      },
      {
        entityName: "PostgreSQL",
        claim: "Kubernetes pod ingress routing uses Nginx ingress controller.",
        evidence: "Infra",
        coverage: "substantially covered",
      },
      {
        entityName: "PostgreSQL",
        claim: "CSS grid layout supports fractional unit track sizing.",
        evidence: "Web",
        coverage: "substantially covered",
      },
      {
        entityName: "PostgreSQL",
        claim: "Docker multi-stage build reduces final image size.",
        evidence: "Docker",
        coverage: "substantially covered",
      },

      // Borderline items (Gate 2 defer to scratchpad: score ~0.50)
      {
        entityName: "PostgreSQL",
        claim: "Cache invalidation occurs via redis pubsub channels.",
        evidence: "Cache",
        coverage: "substantially covered",
      },
      {
        entityName: "PostgreSQL",
        claim: "Cache warming runs on application startup sequence.",
        evidence: "Cache",
        coverage: "substantially covered",
      },

      // Redundant known (Gate 3 discard)
      {
        entityName: "PostgreSQL",
        claim:
          "PostgreSQL uses MVCC to prevent read-write deadlocks and ensure ACID transaction isolation.",
        evidence: "MVCC",
        coverage: "substantially covered",
      },

      // Conflict survivor (Gate 3 conflict)
      {
        entityName: "PostgreSQL",
        claim:
          "Contrary to documentation, PostgreSQL lock contention spikes during bulk alterations.",
        evidence: "Spikes",
        coverage: "substantially covered",
      },

      // Extension survivor (Gate 3 extension)
      {
        entityName: "PostgreSQL",
        claim:
          "PostgreSQL autovacuum threshold was adjusted to prevent table bloat in large tables.",
        evidence: "Vacuum",
        coverage: "substantially covered",
      },

      // Completely novel survivor (Gate 3 novel)
      {
        entityName: "PostgreSQL",
        claim:
          "Tradeoff analysis shows PostgreSQL WAL synchronous commit tuning yields 10x throughput.",
        evidence: "WAL",
        coverage: "substantially covered",
      },
    ];

    const result = await pipeline.probeDelta({
      sourceId: "benchmarks:2026-v1",
      sourceText,
      language: "en",
      candidates,
    });

    expect(result.stats.totalCandidates).toBe(20);
    // Discarded Gate 1: absent items + aside without coverage
    expect(result.stats.discardedGate1).toBeGreaterThanOrEqual(8);
    // Discarded Gate 2: off-topic items (< tauOff 0.35)
    expect(result.stats.discardedGate2).toBeGreaterThanOrEqual(4);
    // Deferred to scratchpad
    expect(result.stats.deferredScratchpad).toBeGreaterThanOrEqual(2);
    // Discarded Gate 3: redundant known items
    expect(result.stats.discardedGate3).toBe(1);

    // Total filtered >= 75%
    expect(result.stats.noiseFilteredRatio).toBeGreaterThanOrEqual(0.75);

    // Survivors = 3 (1 conflict + 1 extension + 1 novel)
    expect(result.survivors.length).toBe(3);
    const verdicts = result.survivors.map((s) => s.verdict);
    expect(verdicts).toContain("ESCALATE_CONFLICT");
    expect(verdicts).toContain("ESCALATE_EXTENSION");
  });
});
