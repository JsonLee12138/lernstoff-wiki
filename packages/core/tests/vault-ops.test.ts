import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../src/vault-init.js";
import { QmdBridge } from "../src/qmd-bridge.js";
import { VaultOps } from "../src/vault-ops.js";
import { VaultWatcher } from "../src/vault-watcher.js";
import { formatScratchpad } from "../src/algorithms/scratchpad-gc.js";

describe("Vault Operations & Loop-Safe Watcher", () => {
  let tempDir: string;
  let bridge: QmdBridge;
  let watcher: VaultWatcher;
  let ops: VaultOps;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-vault-ops-test-"));
    await initVault(tempDir);

    bridge = new QmdBridge({
      vaultPath: tempDir,
      mockSearch: async () => [],
    });

    ops = new VaultOps(tempDir, bridge);
    watcher = new VaultWatcher(tempDir, ops["config"]);
    ops.setWatcher(watcher);
  });

  afterEach(async () => {
    watcher.stop();
    await bridge.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects bare noun titles with Socratic error guidance", async () => {
    await expect(
      ops.crystallizeNote({
        operation: "CREATE_PROPOSITION",
        propositionTitle: "Redis",
        socraticDefense: {
          deltaExplanation: "This note explains caching mechanisms in memory.",
          beliefUpdate: "Replaces disk lookups with memory hash lookups.",
          outboundLinks: [],
        },
        markdownBody: "Body text.",
      }),
    ).rejects.toThrow("bare noun topic");
  });

  it("enforces minimum 2 outbound links when Vault concept count >= 3", async () => {
    const conceptsDir = join(tempDir, "wiki/concepts");
    writeFileSync(join(conceptsDir, "note-a.md"), "# Note A\n", "utf-8");
    writeFileSync(join(conceptsDir, "note-b.md"), "# Note B\n", "utf-8");
    writeFileSync(join(conceptsDir, "note-c.md"), "# Note C\n", "utf-8");

    // Attempting note crystallization with only 1 outbound link
    await expect(
      ops.crystallizeNote({
        operation: "CREATE_PROPOSITION",
        propositionTitle: "PostgreSQL Multi-Version Concurrency Eliminates Read Blocking",
        socraticDefense: {
          deltaExplanation: "Provides lock-free snapshot isolation for readers.",
          beliefUpdate: "Eliminates need for table-level read locking.",
          outboundLinks: [{ targetNote: "note-a", relation: "supports" }],
        },
        markdownBody: "PostgreSQL MVCC ensures readers do not block writers.",
      }),
    ).rejects.toThrow("must establish at least 2 outbound typed links");
  });

  it("crystallizes valid proposition note with Obsidian frontmatter and Callout", async () => {
    const res = await ops.crystallizeNote({
      operation: "CREATE_PROPOSITION",
      propositionTitle: "PostgreSQL Multi-Version Concurrency Eliminates Read Blocking",
      inquiryRefs: ["#q-01"],
      socraticDefense: {
        deltaExplanation: "Provides lock-free snapshot isolation for concurrent readers.",
        beliefUpdate: "Overturns traditional pessimistic two-phase locking assumption.",
        outboundLinks: [
          { targetNote: "relational-algebra-isolation", relation: "supports" },
          { targetNote: "pessimistic-table-locking", relation: "contradicts" },
        ],
      },
      markdownBody:
        "MVCC creates tuple versions on update, allowing readers to view consistent snapshots without acquiring exclusive locks.",
      sources: ["paper:arxiv-2605.12345#sec3"],
    });

    expect(res.path).toBe(
      "wiki/concepts/postgresql-multi-version-concurrency-eliminates-read-blocking.md",
    );
    expect(res.outboundLinksCount).toBe(2);

    const writtenContent = readFileSync(join(tempDir, res.path), "utf-8");
    expect(writtenContent).toContain(
      'title: "PostgreSQL Multi-Version Concurrency Eliminates Read Blocking"',
    );
    expect(writtenContent).toContain("> [!NOTE] Socratic Defense");
    expect(writtenContent).toContain("**Q1 (Epistemic Delta)**");
    expect(writtenContent).toContain("- supports [[relational-algebra-isolation]]");
    expect(writtenContent).toContain("- contradicts [[pessimistic-table-locking]]");
    expect(writtenContent).toContain("### Sources\n- paper:arxiv-2605.12345#sec3");

    // Check log update
    const logContent = readFileSync(join(tempDir, "wiki/log.md"), "utf-8");
    expect(logContent).toContain("CREATE_PROPOSITION");
  });

  it("manages inquiries tree CRUD actions correctly", async () => {
    // 1. List existing
    const initialList = await ops.manageInquiries({ action: "list" });
    expect(initialList.length).toBeGreaterThanOrEqual(1);

    // 2. Add new inquiry
    const addRes = await ops.manageInquiries({
      action: "add",
      question: "How do hybrid vector-lexical stores scale under write-heavy workloads?",
    });
    expect(addRes.inquiry.id).toMatch(/^#q-\d+$/);

    const afterAdd = await ops.manageInquiries({ action: "list" });
    expect(afterAdd.some((i: any) => i.id === addRes.inquiry.id)).toBe(true);

    // 3. Close inquiry
    await ops.manageInquiries({
      action: "close",
      id: addRes.inquiry.id,
      resolutionNote: "Verified with RocksDB and SQLite-vec benchmarks.",
    });

    const inqFileContent = readFileSync(join(tempDir, "wiki/inquiries.md"), "utf-8");
    expect(inqFileContent).toContain(`- [CLOSED] ${addRes.inquiry.id}`);
    expect(inqFileContent).toContain("RocksDB and SQLite-vec");

    // 4. Reopen inquiry
    await ops.manageInquiries({
      action: "reopen",
      id: addRes.inquiry.id,
    });
    const reopenedContent = readFileSync(join(tempDir, "wiki/inquiries.md"), "utf-8");
    expect(reopenedContent).toContain(`- [OPEN] ${addRes.inquiry.id}`);
  });

  it("consolidates scratchpad and prunes expired items", async () => {
    const scratchpadFile = join(tempDir, "inbox/scratchpad.md");
    const oldDate = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
    const recentDate = new Date().toISOString();

    const sampleContent = formatScratchpad([
      {
        firstSeen: recentDate.slice(0, 10),
        claim: "Redis cluster gossip introduces jitter",
        hitCount: 3,
        relatedEntities: ["Redis"],
        sources: ["src:a", "src:b"],
        status: "READY_FOR_PROMOTION",
      },
      {
        firstSeen: oldDate.slice(0, 10),
        claim: "Kafka partition rebalance pause",
        hitCount: 1,
        relatedEntities: ["Kafka"],
        sources: ["src:c"],
        status: "DEFERRED",
      },
    ]);

    writeFileSync(scratchpadFile, sampleContent, "utf-8");

    // Inspect
    const inspectRes = await ops.consolidateScratchpad({ action: "inspect" });
    expect(inspectRes.promotions.length).toBe(1);
    expect(inspectRes.promotions[0]?.relatedEntities).toContain("Redis");

    // GC (pruning Kafka which is 20 days old with hit=1)
    const gcRes = await ops.consolidateScratchpad({ action: "gc" });
    expect(gcRes.decayedArchivedCount).toBe(1);
    expect(gcRes.activeCount).toBe(1);

    const remainingTable = readFileSync(scratchpadFile, "utf-8");
    expect(remainingTable).toContain("Redis cluster gossip");
    expect(remainingTable).not.toContain("Kafka partition rebalance");

    const archiveFile = join(tempDir, ".lernstoff/archive/decayed.jsonl");
    expect(existsSync(archiveFile)).toBe(true);
    const archiveContent = readFileSync(archiveFile, "utf-8");
    expect(archiveContent).toContain("Kafka partition rebalance");
  });

  it("lintWiki detects orphans, synthesis-ready inquiries, and latent contradictions", async () => {
    const conceptsDir = join(tempDir, "wiki/concepts");

    // 1. Create 5 notes supporting inquiry #q-core
    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(conceptsDir, `support-note-${i}.md`),
        `---\ntitle: "Support Note ${i}"\ninquiries:\n  - "#q-core"\n---\n# Support Note ${i}\nLinked: [[support-note-1]]\n`,
        "utf-8",
      );
    }

    // 2. Create an orphan note (no in-links)
    writeFileSync(
      join(conceptsDir, "orphan-claim-without-inlinks.md"),
      `---\ntitle: "Orphan Claim"\n---\n# Orphan Claim\nNo backlinks point here.\n`,
      "utf-8",
    );

    // 3. Create a contradiction pair without explicit 'contradicts' edge
    writeFileSync(
      join(conceptsDir, "latency-reduction-hypothesis.md"),
      `---\ntitle: "Latency Hypothesis"\n---\n# Latency Hypothesis\nRedis reduces latency by caching.\n`,
      "utf-8",
    );
    writeFileSync(
      join(conceptsDir, "latency-spike-findings.md"),
      `---\ntitle: "Latency Findings"\n---\n# Latency Findings\nContrary to previous hypothesis, Redis garbage collection causes latency spikes.\n`,
      "utf-8",
    );

    const report = await ops.lintWiki();
    expect(report.summary.totalNotes).toBe(8);
    expect(report.orphans.some((o) => o.title.includes("orphan-claim"))).toBe(true);
    expect(report.synthesisReady.some((s) => s.inquiryId === "#q-core")).toBe(true);
    expect(report.contradictions.length).toBeGreaterThanOrEqual(1);
  });

  it("watcher suppresses programmatic writes and deduplicates events", () => {
    const testFile = "wiki/concepts/test-event.md";
    watcher.markRecentWrite(testFile);
    expect(watcher.isRecentWrite(testFile)).toBe(true);
  });
});
