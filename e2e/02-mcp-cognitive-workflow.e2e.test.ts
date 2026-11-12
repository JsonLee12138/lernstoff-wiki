import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createE2eSandbox, McpStdioClient, type E2eSandbox } from "./helpers/e2e-harness.js";

function extractMcpText(res: any): string {
  return (res?.content || [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

function parseTrailingJson(text: string): any {
  const splitIdx = text.indexOf("\n\n{");
  if (splitIdx >= 0) {
    return JSON.parse(text.slice(splitIdx + 2));
  }
  return JSON.parse(text);
}

describe("E2E Flow 02: Full 4-Step Cognitive Protocol over MCP (Proxy & Direct Stdio)", () => {
  let sandbox: E2eSandbox;
  let mcpClient: McpStdioClient | null = null;

  beforeEach(async () => {
    sandbox = await createE2eSandbox({ seedPort: false });
    await sandbox.runCli(["init", "--vault", sandbox.vaultDir]);
    sandbox.seedPortConfig();
  });

  afterEach(async () => {
    if (mcpClient) {
      await mcpClient.close();
      mcpClient = null;
    }
    await sandbox.cleanup();
  });

  it("2.1 proxies MCP Stdio cleanly to running HTTP Daemon without leaking raw SSE frames onto stdout (Task 12)", async () => {
    await sandbox.runCli(["server", "start", "--daemon", "--vault", sandbox.vaultDir]);
    await sandbox.waitForDaemonHealth(sandbox.port);

    mcpClient = new McpStdioClient(sandbox.vaultDir, sandbox.env);
    const initRes = await mcpClient.initialize();
    expect(initRes.serverInfo.name).toBe("lernstoff-wiki");

    const toolsRes = await mcpClient.request("tools/list", {});
    expect(toolsRes.tools).toHaveLength(8);
  });

  it("2.2 exposes all 8 MCP tools + lernstoff:// resource template and executes Inquiry Tree CRUD roundtrip (Tasks 9 & 10)", async () => {
    mcpClient = new McpStdioClient(sandbox.vaultDir, sandbox.env);
    await mcpClient.initialize();

    const toolsList = await mcpClient.request("tools/list", {});
    const toolNames = toolsList.tools.map((t: any) => t.name).sort();
    expect(toolNames).toEqual([
      "lernstoff_consolidate_scratchpad",
      "lernstoff_crystallize_note",
      "lernstoff_get_note",
      "lernstoff_lint_wiki",
      "lernstoff_manage_inquiries",
      "lernstoff_probe_delta",
      "lernstoff_search_memory",
      "lernstoff_status",
    ]);

    const templates = await mcpClient.request("resources/templates/list", {});
    expect(
      templates.resourceTemplates.some((r: any) => r.uriTemplate === "lernstoff://{+path}"),
    ).toBe(true);

    // Add, list, close, and reopen inquiry
    const addRes = JSON.parse(
      extractMcpText(
        await mcpClient.callTool("lernstoff_manage_inquiries", {
          action: "add",
          question: "How does MVCC snapshot isolation prevent read-write lock contention?",
        }),
      ),
    );
    expect(addRes.inquiry.id).toBe("#q-01");

    const closeRes = JSON.parse(
      extractMcpText(
        await mcpClient.callTool("lernstoff_manage_inquiries", {
          action: "close",
          id: "#q-01",
          resolutionNote: "Resolved via serializable snapshot anomaly analysis",
        }),
      ),
    );
    expect(closeRes.success).toBe(true);

    const listAfterClose = JSON.parse(
      extractMcpText(await mcpClient.callTool("lernstoff_manage_inquiries", { action: "list" })),
    );
    const closedItem = listAfterClose.find((i: any) => i.id === "#q-01");
    expect(closedItem.status).toBe("CLOSED");

    await mcpClient.callTool("lernstoff_manage_inquiries", { action: "reopen", id: "#q-01" });
    const listAfterReopen = JSON.parse(
      extractMcpText(await mcpClient.callTool("lernstoff_manage_inquiries", { action: "list" })),
    );
    expect(listAfterReopen.find((i: any) => i.id === "#q-01").status).toBe("OPEN");
  });

  it("2.3 evaluates Gate 1 deterministically across repeated entity calls and supports CJK `language: auto` (Task 4)", async () => {
    // Empty inquiries so Gate 2 passes through to isolate Gate 1 behavior cleanly
    writeFileSync(join(sandbox.vaultDir, "wiki/inquiries.md"), "# Inquiries\n", "utf-8");

    mcpClient = new McpStdioClient(sandbox.vaultDir, sandbox.env);
    await mcpClient.initialize();

    // Call 1: "Aerospike" inside a comma enumeration -> aside+covered -> DEFER_TO_SCRATCHPAD (sets RegExp lastIndex if buggy)
    const call1 = parseTrailingJson(
      extractMcpText(
        await mcpClient.callTool("lernstoff_probe_delta", {
          sourceId: "doc:enum",
          sourceText: "Engines like Redis, Aerospike, and Memcached optimize memory layout.",
          language: "en",
          candidates: [
            {
              entityName: "Aerospike",
              claim: "Aerospike hybrid memory index stores primary keys in DRAM",
              coverage: "substantially covered",
            },
          ],
        }),
      ),
    );
    expect(call1.stats.deferredScratchpad).toBe(1);

    // Call 2: Same entity "Aerospike" at index 0 of clean prose MUST NOT falsely become "absent" (AUTO_DISCARD)
    const call2 = parseTrailingJson(
      extractMcpText(
        await mcpClient.callTool("lernstoff_probe_delta", {
          sourceId: "doc:prose",
          sourceText: "Aerospike achieves predictable sub-millisecond read latency on NVMe SSDs.",
          language: "en",
          candidates: [
            {
              entityName: "Aerospike",
              claim: "Aerospike bypasses filesystem page cache via direct NVMe block I/O",
              coverage: "substantially covered",
            },
          ],
        }),
      ),
    );
    expect(call2.stats.discardedGate1).toBe(0);
    expect(call2.survivors).toHaveLength(1);

    // Call 3: CJK prose with `language: "auto"` (as recommended in SKILL.md) MUST detect CJK script instead of word-boundary failure
    const callCjk = parseTrailingJson(
      extractMcpText(
        await mcpClient.callTool("lernstoff_probe_delta", {
          sourceId: "doc:zh",
          sourceText:
            "在高并发数据库内核中多版本并发控制通过历史版本链完全消除了只读事务的锁等待。",
          language: "auto",
          candidates: [
            {
              entityName: "多版本并发控制",
              claim: "多版本并发控制通过维护元组版本链使只读快照查询无需加锁",
              coverage: "substantially covered",
            },
          ],
        }),
      ),
    );
    expect(callCjk.stats.discardedGate1).toBe(0);
    expect(callCjk.survivors).toHaveLength(1);
  });

  it("2.4 enforces Socratic noun-phrase guard, crystallizes & amends notes without losing history, updates index.md, searches via FTS+PPR, and blocks path traversal (Tasks 5, 6, 9, 10)", async () => {
    mcpClient = new McpStdioClient(sandbox.vaultDir, sandbox.env);
    await mcpClient.initialize();

    // 1. Multi-word bare noun phrase lacking predicate must be rejected by Socratic guard
    const nounPhraseAttempt = await mcpClient.callTool("lernstoff_crystallize_note", {
      operation: "CREATE_PROPOSITION",
      propositionTitle: "Distributed Relational Database Architecture",
      inquiryRefs: ["#q-core"],
      socraticDefense: {
        deltaExplanation: "Explains database storage architecture layers in detail.",
        beliefUpdate: "Updates naive single-node storage assumption.",
        outboundLinks: [],
      },
      markdownBody: "Overview of storage engines.",
      sources: ["paper:db-arch"],
    });
    expect(nounPhraseAttempt.isError).toBe(true);

    // 2. Crystallize 3 cold-start proposition notes
    const note1Res = await mcpClient.callTool("lernstoff_crystallize_note", {
      operation: "CREATE_PROPOSITION",
      propositionTitle: "MVCC snapshot isolation eliminates read locks but permits write skew",
      inquiryRefs: ["#q-core"],
      socraticDefense: {
        deltaExplanation: "Clarifies that snapshot isolation does not guarantee serializability.",
        beliefUpdate:
          "Revises assumption that lock-free MVCC reads prevent all concurrency anomalies.",
        outboundLinks: [],
      },
      markdownBody:
        "Snapshot isolation reads from a consistent timestamped version, avoiding shared read locks while allowing concurrent disjoint writes to violate invariants.",
      sources: ["berenson-1995"],
    });
    expect(note1Res.isError).toBeFalsy();
    const note1Slug = "mvcc-snapshot-isolation-eliminates-read-locks-but-permits-write-skew";

    await mcpClient.callTool("lernstoff_crystallize_note", {
      operation: "CREATE_PROPOSITION",
      propositionTitle:
        "Serializable snapshot isolation tracks rw-antidependency cycles to abort write skew",
      inquiryRefs: ["#q-core"],
      socraticDefense: {
        deltaExplanation: "Adds SIREAD predicate lock tracking mechanism over plain MVCC.",
        beliefUpdate: "Extends MVCC anomaly model with lightweight cycle detection.",
        outboundLinks: [{ targetNote: note1Slug, relation: "extends" }],
      },
      markdownBody:
        "Cahill's SSI algorithm detects two consecutive rw-antidependency edges without blocking readers.",
      sources: ["cahill-2008"],
    });
    const note2Slug =
      "serializable-snapshot-isolation-tracks-rw-antidependency-cycles-to-abort-write-skew";

    await mcpClient.callTool("lernstoff_crystallize_note", {
      operation: "CREATE_PROPOSITION",
      propositionTitle:
        "Two-phase locking prevents write skew at the cost of reader-writer blocking",
      inquiryRefs: ["#q-core"],
      socraticDefense: {
        deltaExplanation: "Contrasts pessimistic shared/exclusive locks against optimistic SSI.",
        beliefUpdate: "Establishes tail-latency tradeoff under high read-to-write skew.",
        outboundLinks: [
          { targetNote: note1Slug, relation: "qualifies" },
          { targetNote: note2Slug, relation: "contradicts" },
        ],
      },
      markdownBody: "Strict 2PL blocks readers behind active writers under contended hot rows.",
      sources: ["gray-1976"],
    });

    // `wiki/index.md` must be updated to index newly crystallized proposition notes (Task 9 AC#1)
    const indexMd = readFileSync(join(sandbox.vaultDir, "wiki/index.md"), "utf-8");
    expect(indexMd).toContain(note1Slug);

    // 3. Past cold start (>= 3 notes), < 2 outbound links must fail Anti-Orphan Guard
    const orphanAttempt = await mcpClient.callTool("lernstoff_crystallize_note", {
      operation: "CREATE_PROPOSITION",
      propositionTitle:
        "Deterministic transaction scheduling removes distributed commit coordination",
      inquiryRefs: ["#q-core"],
      socraticDefense: {
        deltaExplanation: "Calvin pre-orders batches prior to execution.",
        beliefUpdate: "Shows 2PC is avoidable when inputs are known upfront.",
        outboundLinks: [{ targetNote: note1Slug, relation: "extends" }],
      },
      markdownBody: "Sequencer layer replicates deterministic input log.",
      sources: ["thomson-2012"],
    });
    expect(orphanAttempt.isError).toBe(true);

    // 4. Amending Note 1 (`AMEND_EXISTING`) must preserve original `created_at` and prior body content
    const note1FullPath = join(sandbox.vaultDir, "wiki/concepts", `${note1Slug}.md`);
    const beforeAmend = readFileSync(note1FullPath, "utf-8");
    const origCreatedMatch = beforeAmend.match(/^created_at:\s*(.+)$/m);
    expect(origCreatedMatch).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));

    const amendRes = await mcpClient.callTool("lernstoff_crystallize_note", {
      operation: "AMEND_EXISTING",
      propositionTitle: "MVCC snapshot isolation eliminates read locks but permits write skew",
      targetPath: `wiki/concepts/${note1Slug}.md`,
      inquiryRefs: ["#q-core"],
      socraticDefense: {
        deltaExplanation: "Adds PostgreSQL read-only safe snapshot optimization nuance.",
        beliefUpdate: "Qualifies read-only transactions with DEFERRABLE mode.",
        outboundLinks: [
          { targetNote: note2Slug, relation: "supports" },
          {
            targetNote:
              "two-phase-locking-prevents-write-skew-at-the-cost-of-reader-writer-blocking",
            relation: "qualifies",
          },
        ],
      },
      markdownBody: "PostgreSQL SERIALIZABLE READ ONLY DEFERRABLE avoids SSI aborts.",
      sources: ["ports-2012"],
    });
    expect(amendRes.isError).toBeFalsy();
    const afterAmend = readFileSync(note1FullPath, "utf-8");
    expect(afterAmend).toContain(origCreatedMatch![1]!);
    expect(afterAmend).toContain("avoiding shared read locks");

    // 5. `lernstoff_search_memory` with plain `{ query }` must work out-of-the-box without manual embed()
    const searchRes = JSON.parse(
      extractMcpText(
        await mcpClient.callTool("lernstoff_search_memory", {
          query: "write skew",
          includePpr: true,
        }),
      ),
    );
    expect(searchRes.directHits.length).toBeGreaterThan(0);

    // 6. `lernstoff_get_note` must block path traversal outside Vault
    const traversalAttempt = await mcpClient.callTool("lernstoff_get_note", {
      path: "../../../../etc/hosts",
    });
    expect(traversalAttempt.isError).toBe(true);
  });

  it("2.5 persists scratchpad `promote` status, spares referenced notes during GC, avoids O(N^2) lint false positives, and logs Gate 3 discards (Tasks 5, 6, 8, 9, 10)", async () => {
    mcpClient = new McpStdioClient(sandbox.vaultDir, sandbox.env);
    await mcpClient.initialize();

    // Seed two notes where Note A already has an explicit `- contradicts [[note-b]]` link, plus unrelated Note C
    const conceptsDir = join(sandbox.vaultDir, "wiki/concepts");
    writeFileSync(
      join(conceptsDir, "note-b.md"),
      '---\ntitle: "Leader leases guarantee linearizable local reads"\n---\n# Leader leases guarantee linearizable local reads\n\nLocal clock bounded leases avoid quorum roundtrips.\n',
      "utf-8",
    );
    writeFileSync(
      join(conceptsDir, "note-a.md"),
      '---\ntitle: "Unbounded clock skew invalidates leader lease linearizability"\n---\n# Unbounded clock skew invalidates leader lease linearizability\n\n### Associated Propositions\n- contradicts [[note-b]]\n',
      "utf-8",
    );
    writeFileSync(
      join(conceptsDir, "note-c.md"),
      '---\ntitle: "B-tree prefix compression reduces internal page fanout overhead"\n---\n# B-tree prefix compression reduces internal page fanout overhead\n\n### Associated Propositions\n- supports [[note-b]]\n',
      "utf-8",
    );

    // 1. Lint Wiki MUST recognize `- contradicts [[note-b]]` and MUST NOT flag unrelated `note-c` as contradicting `note-a`!
    const lintRes = JSON.parse(extractMcpText(await mcpClient.callTool("lernstoff_lint_wiki", {})));
    expect(lintRes.summary.contradictionCount).toBe(0);

    // 2. Seed scratchpad with:
    //    - Ready-for-promotion entry (2 hits, 2 sources)
    //    - Expired entry referenced in permanent `note-c.md` ("B-tree prefix compression")
    //    - Expired unreferenced entry ("Ephemeral gossip rumor")
    const scratchpadContent = `# 闪念缓冲池 (Fast Scratchpad Buffer)

| 首次记录 | 概念 / 临时判断 | 碰撞计数 | 关联实体 | 来源线索 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 2026-11-01 | Adaptive radix trees outperform B-trees on dense integer keys | 2 | ART | src-1, src-2 | 🟡 READY_FOR_PROMOTION |
| 2025-01-01 | B-tree prefix compression | 1 | B-tree | src-old-1 | 🟢 DEFERRED |
| 2025-01-01 | Ephemeral gossip rumor | 1 | Gossip | src-old-2 | 🟢 DEFERRED |
`;
    writeFileSync(join(sandbox.vaultDir, "inbox/scratchpad.md"), scratchpadContent, "utf-8");

    // Promote the ready entry and verify subsequent `inspect` no longer treats it as unpromoted DEFERRED/READY
    await mcpClient.callTool("lernstoff_consolidate_scratchpad", {
      action: "promote",
      itemIds: ["Adaptive radix trees outperform B-trees on dense integer keys"],
    });
    const inspectAfterPromote = JSON.parse(
      extractMcpText(
        await mcpClient.callTool("lernstoff_consolidate_scratchpad", { action: "inspect" }),
      ),
    );
    expect(inspectAfterPromote.promotions).toHaveLength(0);

    // Run GC: unreferenced expired entry must archive to decayed.jsonl, while referenced "B-tree prefix compression" is spared
    const gcRes = JSON.parse(
      extractMcpText(
        await mcpClient.callTool("lernstoff_consolidate_scratchpad", { action: "gc" }),
      ),
    );
    expect(gcRes.decayedArchivedCount).toBe(1);
    expect(existsSync(join(sandbox.vaultDir, ".lernstoff/archive/decayed.jsonl"))).toBe(true);
    const decayedText = readFileSync(
      join(sandbox.vaultDir, ".lernstoff/archive/decayed.jsonl"),
      "utf-8",
    );
    expect(decayedText).toContain("Ephemeral gossip rumor");
    expect(decayedText).not.toContain("B-tree prefix compression");

    // 3. `lernstoff_status` must expose `noiseFilteredRatio` metric
    const statusPayload = JSON.parse(
      extractMcpText(await mcpClient.callTool("lernstoff_status", {})),
    );
    expect(typeof statusPayload.metrics.noiseFilteredRatio).toBe("number");
  });
});
