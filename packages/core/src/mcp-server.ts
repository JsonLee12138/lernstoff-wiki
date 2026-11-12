import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type LernstoffConfig, loadConfig } from "./config.js";
import { QmdBridge } from "./qmd-bridge.js";
import { HippocampalPipeline } from "./hippocampal-pipeline.js";
import { VaultOps } from "./vault-ops.js";
import { VaultWatcher } from "./vault-watcher.js";
import { personalizedPageRank } from "./algorithms/monte-carlo-ppr.js";
import { buildWikilinkGraph } from "./algorithms/wikilink-graph.js";

export interface CreateLernstoffMcpServerOptions {
  vaultPath: string;
  config?: LernstoffConfig;
  qmdBridge?: QmdBridge;
  vaultOps?: VaultOps;
  pipeline?: HippocampalPipeline;
  watcher?: VaultWatcher;
}

function resolveSafeVaultPath(vaultRoot: string, userPath: string): string {
  const resolvedVault = resolve(vaultRoot);
  const target = resolve(resolvedVault, userPath);
  const rel = relative(resolvedVault, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Access denied: path '${userPath}' escapes Vault root directory.`);
  }
  return target;
}

export function createLernstoffMcpServer(options: CreateLernstoffMcpServerOptions): McpServer {
  const vaultPath = resolve(options.vaultPath);
  const config = options.config || loadConfig(vaultPath);
  const qmdBridge = options.qmdBridge || new QmdBridge({ vaultPath, config });
  const watcher = options.watcher || new VaultWatcher(vaultPath, config);
  const vaultOps = options.vaultOps || new VaultOps(vaultPath, qmdBridge, watcher, config);
  const pipeline = options.pipeline || new HippocampalPipeline(vaultPath, qmdBridge, config);

  const server = new McpServer({
    name: "lernstoff-wiki",
    version: config.version,
  });

  // ===========================================================================
  // 1. lernstoff_probe_delta (Stage 1-3 Hippocampal Gate)
  // ===========================================================================
  server.registerTool(
    "lernstoff_probe_delta",
    {
      description:
        "Evaluates external text or paper candidates against the 3-stage hippocampal gate (Syntax -> Inquiry Tree -> QMD recall/PPR/entailment). Discards redundant and off-topic items, defers borderline items to scratchpad, and escalates true epistemic deltas.",
      inputSchema: {
        sourceId: z
          .string()
          .describe("Source identifier, e.g. paper:arxiv-2605.12345 or file path"),
        sourceText: z
          .string()
          .describe("Original paragraph or excerpt for Gate 1 syntax verification"),
        language: z.string().optional().describe("Language code, e.g. zh, en, de"),
        candidates: z.array(
          z.object({
            entityName: z.string().describe("Core anchor concept or entity name"),
            claim: z.string().describe("Candidate proposition (must be a falsifiable statement)"),
            evidence: z.string().optional().describe("Key evidence or quote"),
            coverage: z
              .enum(["substantially covered", "briefly mentioned", "named only"])
              .default("substantially covered"),
          }),
        ),
      },
    },
    async (args) => {
      const result = await pipeline.probeDelta({
        sourceId: args.sourceId,
        sourceText: args.sourceText,
        language: args.language,
        candidates: args.candidates,
      });

      const summaryText = `[Epistemic Delta Gate] Total: ${result.stats.totalCandidates}, Filtered: ${Math.round(result.stats.noiseFilteredRatio * 100)}% (Gate 1: ${result.stats.discardedGate1}, Gate 2: ${result.stats.discardedGate2}, Gate 3: ${result.stats.discardedGate3}, Scratchpad: ${result.stats.deferredScratchpad}), Escalated Survivors: ${result.survivors.length}.`;

      return {
        content: [
          {
            type: "text",
            text: `${summaryText}\n\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    },
  );

  // ===========================================================================
  // 2. lernstoff_crystallize_note (Socratic-Guarded Proposition Note)
  // ===========================================================================
  server.registerTool(
    "lernstoff_crystallize_note",
    {
      description:
        "Crystallizes an Evergreen proposition note with Socratic defense guards (anti-noun topic check and >= 2 outbound typed links). Formats native Obsidian YAML Frontmatter, Callouts, and links without write loops.",
      inputSchema: {
        operation: z.enum(["CREATE_PROPOSITION", "AMEND_EXISTING", "SYNTHESIZE_CLUSTER"]),
        propositionTitle: z.string().describe("Falsifiable proposition title (not a bare noun)"),
        targetPath: z.string().optional().describe("Target note path if amending an existing note"),
        inquiryRefs: z
          .array(z.string())
          .default([])
          .describe("Associated inquiry IDs (e.g. #q-01)"),
        socraticDefense: z.object({
          deltaExplanation: z
            .string()
            .describe("Q1: Irreplaceable epistemic delta compared to recalled notes"),
          beliefUpdate: z.string().describe("Q2: Which prior assumption/belief is revised"),
          outboundLinks: z
            .array(
              z.object({
                targetNote: z.string().describe("Target note slug or title"),
                relation: z.enum(["supports", "contradicts", "extends", "qualifies"]),
              }),
            )
            .default([])
            .describe("Q3: Outbound typed logical links (>= 2 required after cold start)"),
        }),
        markdownBody: z.string().describe("Atomic proposition note body in Markdown"),
        sources: z.array(z.string()).default([]).describe("Exact source citations"),
      },
    },
    async (args) => {
      try {
        const res = await vaultOps.crystallizeNote({
          operation: args.operation,
          propositionTitle: args.propositionTitle,
          targetPath: args.targetPath,
          inquiryRefs: args.inquiryRefs,
          socraticDefense: args.socraticDefense,
          markdownBody: args.markdownBody,
          sources: args.sources,
        });

        return {
          content: [
            {
              type: "text",
              text: `Successfully crystallized proposition note: ${res.path} (${res.operation}, ${res.outboundLinksCount} outbound links).`,
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Crystallization failed: ${err.message}` }],
        };
      }
    },
  );

  // ===========================================================================
  // 3. lernstoff_manage_inquiries (Curiosity Tree CRUD)
  // ===========================================================================
  server.registerTool(
    "lernstoff_manage_inquiries",
    {
      description:
        "Manage the curiosity inquiry tree (wiki/inquiries.md) with list, add, close, or reopen actions.",
      inputSchema: {
        action: z.enum(["list", "add", "close", "reopen"]),
        id: z.string().optional().describe("Inquiry ID, e.g. #q-01"),
        question: z.string().optional().describe("Question statement when adding"),
        context: z.string().optional().describe("Background context or motivation"),
        resolutionNote: z.string().optional().describe("Resolution note when closing"),
      },
    },
    async (args) => {
      try {
        const res = await vaultOps.manageInquiries(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `manage_inquiries error: ${err.message}` }],
        };
      }
    },
  );

  // ===========================================================================
  // 4. lernstoff_consolidate_scratchpad (Fast Buffer Promotion & GC)
  // ===========================================================================
  server.registerTool(
    "lernstoff_consolidate_scratchpad",
    {
      description:
        "Inspect entries ready for promotion in inbox/scratchpad.md (hit_count >= 2 across >= 2 sources), promote them, or run TTL garbage collection pruning.",
      inputSchema: {
        action: z.enum(["inspect", "promote", "gc"]),
        itemIds: z.array(z.string()).optional().describe("Entry claims or IDs to mark promoted"),
      },
    },
    async (args) => {
      try {
        const res = await vaultOps.consolidateScratchpad(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `consolidate_scratchpad error: ${err.message}` }],
        };
      }
    },
  );

  // ===========================================================================
  // 5. lernstoff_lint_wiki (Socratic Health Audit)
  // ===========================================================================
  server.registerTool(
    "lernstoff_lint_wiki",
    {
      description:
        "Performs a Socratic health audit of the Vault: finding orphan notes (in-degree 0), latent contradiction pairs within concept clusters, and inquiries with >= 5 notes ready for synthesis.",
      inputSchema: {
        checkOrphans: z.boolean().default(true),
        checkContradictions: z.boolean().default(true),
        checkSynthesisReady: z.boolean().default(true),
      },
    },
    async (args) => {
      const res = await vaultOps.lintWiki(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    },
  );

  // ===========================================================================
  // 6. lernstoff_search_memory (QMD Hybrid Search + Monte Carlo PPR Associative Walk)
  // ===========================================================================
  server.registerTool(
    "lernstoff_search_memory",
    {
      description:
        "Hybrid search across Vault notes using @tobilu/qmd (lex/vec/hyde) combined with Monte Carlo Personalized PageRank 2-hop associative graph walk.",
      inputSchema: {
        query: z.string().optional().describe("Plaintext search query"),
        searches: z
          .array(
            z.object({
              type: z.enum(["lex", "vec", "hyde"]),
              query: z.string(),
            }),
          )
          .optional(),
        limit: z.number().default(5),
        includePpr: z.boolean().default(true),
      },
    },
    async (args) => {
      const queries =
        args.searches ||
        (args.query
          ? [
              { type: "lex" as const, query: args.query },
              { type: "vec" as const, query: args.query },
            ]
          : []);
      let directHits: any[] = [];
      try {
        directHits = await qmdBridge.search({
          queries,
          limit: args.limit,
        });
      } catch {
        directHits = [];
      }

      if (directHits.length === 0 && (args.query || args.searches?.length)) {
        const queryTerm = (args.query || args.searches?.[0]?.query || "").toLowerCase();
        const conceptsDir = join(vaultPath, config.paths.conceptsDir);
        if (existsSync(conceptsDir) && queryTerm) {
          const files = readdirSync(conceptsDir).filter((f) => f.endsWith(".md"));
          for (const f of files) {
            try {
              const text = readFileSync(join(conceptsDir, f), "utf-8");
              if (text.toLowerCase().includes(queryTerm)) {
                directHits.push({
                  file: join(config.paths.conceptsDir, f),
                  displayPath: join(config.paths.conceptsDir, f),
                  title: f.replace(/\.md$/i, ""),
                  snippet: text.slice(0, 200),
                  score: 0.8,
                });
              }
            } catch {
              // ignore
            }
          }
        }
      }

      let pprAssociativeNeighborhood: Array<{ nodeId: string; score: number }> = [];
      if (args.includePpr && directHits.length > 0) {
        const conceptsDir = join(vaultPath, config.paths.conceptsDir);
        if (existsSync(conceptsDir)) {
          const files = readdirSync(conceptsDir).filter((f) => f.endsWith(".md"));
          const nodesData = files.map((f) => ({
            id: f.replace(/\.md$/i, ""),
            content: readFileSync(join(conceptsDir, f), "utf-8"),
          }));
          const graph = buildWikilinkGraph(nodesData);
          const seeds = directHits
            .map((h) => (h.displayPath || h.file || "").replace(/\.md$/i, "").split("/").pop()!)
            .filter((s) => graph.nodes.includes(s));

          if (seeds.length > 0) {
            pprAssociativeNeighborhood = personalizedPageRank(graph, seeds, {
              numWalks: config.gate.pprNumWalks,
              maxSteps: config.gate.pprMaxSteps,
              damping: config.gate.pprDamping,
              topK: config.gate.pprTopK,
            });
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ directHits, pprAssociativeNeighborhood }, null, 2),
          },
        ],
      };
    },
  );

  // ===========================================================================
  // 7. lernstoff_get_note (Exact Line Slicing + Backlink Summary)
  // ===========================================================================
  server.registerTool(
    "lernstoff_get_note",
    {
      description:
        "Reads a note from the Vault with optional line slicing (path:fromLine:maxLines) and extracts YAML frontmatter, outbound typed links, and backlinks.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Note path, #docid, or path:fromLine:maxLines (e.g. wiki/concepts/mvcc.md:1:30)",
          ),
        includeBacklinks: z.boolean().default(true),
      },
    },
    async (args) => {
      let rawPath = args.path.trim();
      let fromLine = 1;
      let maxLines = 1000;

      // Check line slicing syntax path:fromLine:maxLines
      const sliceMatch = rawPath.match(/^(.*?):(\d+)(?::(\d+))?$/);
      if (sliceMatch && sliceMatch[1] && sliceMatch[2]) {
        rawPath = sliceMatch[1];
        fromLine = parseInt(sliceMatch[2], 10);
        if (sliceMatch[3]) {
          maxLines = parseInt(sliceMatch[3], 10);
        }
      }

      // Check #docid
      if (rawPath.startsWith("#")) {
        const docid = rawPath.slice(1);
        try {
          const doc = await qmdBridge.get(docid, { includeBody: true });
          if (doc && "body" in doc && doc.body) {
            return {
              content: [
                {
                  type: "text",
                  text: doc.body,
                },
              ],
            };
          }
        } catch {
          // fall through
        }
      }

      let fullPath: string;
      try {
        fullPath = resolveSafeVaultPath(vaultPath, rawPath);
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message || "Path traversal denied" }],
        };
      }

      if (!existsSync(fullPath)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Note '${rawPath}' not found in Vault.` }],
        };
      }

      const content = readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");
      const slicedLines = lines.slice(fromLine - 1, fromLine - 1 + maxLines);
      const textWithLineNumbers = slicedLines
        .map((line, idx) => `${String(fromLine + idx).padStart(4, " ")} | ${line}`)
        .join("\n");

      // Extract backlinks if requested
      let backlinks: string[] = [];
      if (args.includeBacklinks) {
        const conceptsDir = join(vaultPath, config.paths.conceptsDir);
        if (existsSync(conceptsDir)) {
          const targetSlug = rawPath.replace(/\.md$/i, "").split("/").pop()!;
          const files = readdirSync(conceptsDir).filter((f) => f.endsWith(".md"));
          for (const file of files) {
            if (file.replace(/\.md$/i, "") === targetSlug) continue;
            try {
              const fileContent = readFileSync(join(conceptsDir, file), "utf-8");
              if (fileContent.includes(`[[${targetSlug}`) || fileContent.includes(targetSlug)) {
                backlinks.push(file.replace(/\.md$/i, ""));
              }
            } catch {
              // ignore
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `[File: ${rawPath} (Lines ${fromLine}..${fromLine + slicedLines.length - 1}, Backlinks: ${backlinks.length})]\n\n${textWithLineNumbers}\n\n[Backlinks]: ${backlinks.join(", ") || "none"}`,
          },
        ],
      };
    },
  );

  // ===========================================================================
  // 8. lernstoff_status (Health & Metrics Snapshot)
  // ===========================================================================
  server.registerTool(
    "lernstoff_status",
    {
      description:
        "Returns the unified status of lernstoff-wiki: QMD SQLite store status, active inquiries count, concept notes count, and scratchpad metrics.",
      inputSchema: z.object({}),
    },
    async (_args) => {
      let qmdStatus: any = { status: "unknown" };
      try {
        qmdStatus = await qmdBridge.getStatus();
      } catch {
        qmdStatus = { status: "offline" };
      }

      // Count concept notes
      const conceptsDir = join(vaultPath, config.paths.conceptsDir);
      const conceptCount = existsSync(conceptsDir)
        ? readdirSync(conceptsDir).filter((f) => f.endsWith(".md")).length
        : 0;

      // Inquiries count
      let inquiriesCount = 0;
      let openInquiriesCount = 0;
      const inqFile = join(vaultPath, config.paths.inquiriesFile);
      if (existsSync(inqFile)) {
        const text = readFileSync(inqFile, "utf-8");
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.match(/^[-*]\s*\[(OPEN|CLOSED)\]/)) {
            inquiriesCount += 1;
            if (line.includes("[OPEN]")) openInquiriesCount += 1;
          }
        }
      }

      // Scratchpad count
      let scratchpadCount = 0;
      let readyForPromotionCount = 0;
      const scratchFile = join(vaultPath, config.paths.scratchpadFile);
      if (existsSync(scratchFile)) {
        const text = readFileSync(scratchFile, "utf-8");
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("|") && !line.includes("---") && !line.includes("首次记录")) {
            scratchpadCount += 1;
            if (line.includes("READY_FOR_PROMOTION")) readyForPromotionCount += 1;
          }
        }
      }

      let noiseFilteredRatio = 0;
      const logFile = join(vaultPath, config.paths.logFile);
      if (existsSync(logFile)) {
        try {
          const logText = readFileSync(logFile, "utf-8");
          const matches = [...logText.matchAll(/noise_filtered_ratio=([0-9.]+)/g)];
          if (matches.length > 0) {
            const lastVal = parseFloat(matches[matches.length - 1]![1]!);
            if (!isNaN(lastVal)) noiseFilteredRatio = lastVal;
          }
        } catch {
          // ignore
        }
      }

      const statusPayload = {
        version: config.version,
        vaultPath,
        qmd: qmdStatus,
        metrics: {
          conceptNotes: conceptCount,
          totalInquiries: inquiriesCount,
          openInquiries: openInquiriesCount,
          scratchpadEntries: scratchpadCount,
          readyForPromotion: readyForPromotionCount,
          noiseFilteredRatio,
        },
        config,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(statusPayload, null, 2),
          },
        ],
      };
    },
  );

  // ===========================================================================
  // MCP Resource: lernstoff://{+path}
  // ===========================================================================
  server.registerResource(
    "lernstoff-note",
    new ResourceTemplate("lernstoff://{+path}", { list: undefined }),
    {
      description: "Direct read access to any note or markdown document in the Vault",
      mimeType: "text/markdown",
    },
    async (uri, vars) => {
      const relPath = typeof vars.path === "string" ? vars.path : String(vars.path || "");
      const fullPath = resolveSafeVaultPath(vaultPath, relPath);

      if (!existsSync(fullPath)) {
        throw new Error(`Resource note '${relPath}' not found at ${fullPath}`);
      }

      const text = readFileSync(fullPath, "utf-8");
      return {
        contents: [
          {
            uri: uri.href,
            text,
            mimeType: "text/markdown",
          },
        ],
      };
    },
  );

  return server;
}
