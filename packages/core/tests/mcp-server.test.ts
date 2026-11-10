import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../src/vault-init.js";
import { QmdBridge } from "../src/qmd-bridge.js";
import { createLernstoffMcpServer } from "../src/mcp-server.js";

describe("8-Tool MCP Superset & lernstoff:// Resource", () => {
  let tempDir: string;
  let bridge: QmdBridge;
  let server: any;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-mcp-test-"));
    await initVault(tempDir);

    bridge = new QmdBridge({
      vaultPath: tempDir,
      mockSearch: async (options) => {
        const queryText = options.queries
          .map((q) => q.query)
          .join(" ")
          .toLowerCase();
        if (queryText.includes("postgresql")) {
          return [
            {
              file: "wiki/concepts/postgres.md",
              title: "PostgreSQL Isolation",
              body: "PostgreSQL uses MVCC.",
              score: 0.9,
            },
          ];
        }
        return [];
      },
    });

    server = createLernstoffMcpServer({
      vaultPath: tempDir,
      qmdBridge: bridge,
    });
  });

  afterEach(async () => {
    await bridge.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("registers the complete 8-tool MCP superset and lernstoff:// resource template", () => {
    const registeredTools = Object.keys(server._registeredTools);
    expect(registeredTools).toHaveLength(8);
    expect(registeredTools).toContain("lernstoff_probe_delta");
    expect(registeredTools).toContain("lernstoff_crystallize_note");
    expect(registeredTools).toContain("lernstoff_manage_inquiries");
    expect(registeredTools).toContain("lernstoff_consolidate_scratchpad");
    expect(registeredTools).toContain("lernstoff_lint_wiki");
    expect(registeredTools).toContain("lernstoff_search_memory");
    expect(registeredTools).toContain("lernstoff_get_note");
    expect(registeredTools).toContain("lernstoff_status");

    expect(server._registeredResourceTemplates["lernstoff-note"]).toBeDefined();
  });

  it("executes lernstoff_status returning system metrics and configuration", async () => {
    const handler = server._registeredTools["lernstoff_status"].handler;
    const res = await handler({});

    expect(res.content).toBeDefined();
    expect(res.content[0]?.type).toBe("text");
    const parsed = JSON.parse(res.content[0]?.text);
    expect(parsed.vaultPath).toBe(tempDir);
    expect(parsed.version).toBe("2.0.0");
    expect(parsed.metrics.openInquiries).toBeGreaterThanOrEqual(1);
  });

  it("executes lernstoff_get_note with line slicing and backlink extraction", async () => {
    const handler = server._registeredTools["lernstoff_get_note"].handler;
    const res = await handler({
      path: "wiki/inquiries.md:1:3",
      includeBacklinks: true,
    });

    expect(res.content[0]?.text).toContain("File: wiki/inquiries.md");
    expect(res.content[0]?.text).toContain("1 | # 好奇心问题树");
  });

  it("reads lernstoff://{+path} resource through template callback", async () => {
    const resTemplate = server._registeredResourceTemplates["lernstoff-note"];
    const readCallback = resTemplate.readCallback;

    const uri = new URL("lernstoff://wiki/inquiries.md");
    const result = await readCallback(uri, { path: "wiki/inquiries.md" });

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.text).toContain("Active Inquiry Tree");
    expect(result.contents[0]?.mimeType).toBe("text/markdown");
  });

  it("executes lernstoff_crystallize_note and lernstoff_manage_inquiries", async () => {
    // 1. Crystallize Note
    const crysHandler = server._registeredTools["lernstoff_crystallize_note"].handler;
    const crysRes = await crysHandler({
      operation: "CREATE_PROPOSITION",
      propositionTitle: "Multi-Version Concurrency Eliminates Read Blocking",
      inquiryRefs: ["#q-core"],
      socraticDefense: {
        deltaExplanation: "Provides lock-free read transactions without shared locks.",
        beliefUpdate:
          "Replaces two-phase pessimistic locking with multiversion snapshot isolation.",
        outboundLinks: [],
      },
      markdownBody: "PostgreSQL MVCC ensures snapshot isolation.",
      sources: ["paper:sigmod-2026"],
    });

    expect(crysRes.content[0]?.text).toContain("Successfully crystallized proposition note");

    // 2. Manage Inquiries (add)
    const inqHandler = server._registeredTools["lernstoff_manage_inquiries"].handler;
    const inqRes = await inqHandler({
      action: "add",
      question: "How do Write-Ahead Logs maintain durability across hardware crash?",
    });

    const parsedInq = JSON.parse(inqRes.content[0]?.text);
    expect(parsedInq.action).toBe("add");
    expect(parsedInq.inquiry.question).toContain("Write-Ahead Logs");
  });

  it("executes lernstoff_search_memory returning direct hits and PPR neighborhood", async () => {
    const searchHandler = server._registeredTools["lernstoff_search_memory"].handler;
    const res = await searchHandler({
      query: "PostgreSQL transaction isolation",
      limit: 5,
      includePpr: true,
    });

    const parsed = JSON.parse(res.content[0]?.text);
    expect(parsed.directHits).toBeDefined();
    expect(parsed.directHits.length).toBe(1);
    expect(parsed.pprAssociativeNeighborhood).toBeDefined();
  });
});
