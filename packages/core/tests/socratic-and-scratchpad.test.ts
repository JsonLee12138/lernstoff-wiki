import { describe, it, expect } from "vitest";
import {
  validatePropositionTitle,
  validateSocraticDefense,
} from "../src/algorithms/socratic-guard.js";
import {
  parseScratchpad,
  formatScratchpad,
  upsertScratchpadEntry,
  pruneExpiredScratchpad,
} from "../src/algorithms/scratchpad-gc.js";

describe("Socratic Guard & Two-Speed Scratchpad (socratic-and-scratchpad)", () => {
  describe("validatePropositionTitle", () => {
    it("rejects bare noun topics from blocklist", () => {
      expect(validatePropositionTitle("Redis").valid).toBe(false);
      expect(validatePropositionTitle("Transformer").valid).toBe(false);
      expect(validatePropositionTitle("attention").valid).toBe(false);
    });

    it("rejects short Chinese noun titles (< 8 chars)", () => {
      const res = validatePropositionTitle("分布式缓存");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("too short");
    });

    it("accepts valid falsifiable Chinese proposition titles (>= 8 chars)", () => {
      const res = validatePropositionTitle("分布式缓存通过LRU淘汰无法保证强一致性");
      expect(res.valid).toBe(true);
    });

    it("rejects short English noun titles (< 4 words)", () => {
      const res = validatePropositionTitle("Fast Cache System");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("words");
    });

    it("accepts valid English proposition titles (>= 4 words)", () => {
      const res = validatePropositionTitle(
        "In-memory caches trade persistence for sub-millisecond latency",
      );
      expect(res.valid).toBe(true);
    });
  });

  describe("validateSocraticDefense", () => {
    it("enforces Q1, Q2, and anti-orphan Q3 (>= 2 outbound links when notes >= 3)", () => {
      const invalid = validateSocraticDefense(
        {
          deltaExplanation: "short",
          beliefUpdate: "no",
          outboundLinks: [{ targetNote: "existing-a", relation: "supports" }],
        },
        5, // existing notes = 5 (past cold start grace of 3)
      );

      expect(invalid.valid).toBe(false);
      expect(invalid.errors.some((e) => e.includes("Q1"))).toBe(true);
      expect(invalid.errors.some((e) => e.includes("Q3"))).toBe(true);

      const valid = validateSocraticDefense(
        {
          deltaExplanation:
            "Demonstrates that MVCC read locks do not block write operations under PostgreSQL.",
          beliefUpdate: "Corrects the assumption that all transactional locks create deadlocks.",
          outboundLinks: [
            { targetNote: "postgresql-mvcc", relation: "supports" },
            { targetNote: "lock-free-concurrency", relation: "extends" },
          ],
        },
        5,
      );

      expect(valid.valid).toBe(true);
      expect(valid.errors.length).toBe(0);
    });

    it("allows single outbound link during cold start grace period (< 3 notes)", () => {
      const valid = validateSocraticDefense(
        {
          deltaExplanation: "Cold start first note explaining fundamental concepts.",
          beliefUpdate: "Foundational baseline belief for the vault.",
          outboundLinks: [{ targetNote: "root-concept", relation: "supports" }],
        },
        1, // existing notes = 1 (within cold start grace)
      );

      expect(valid.valid).toBe(true);
    });
  });

  describe("scratchpad-gc", () => {
    it("upserts scratchpad entries and marks ready for promotion when hit_count >= 2 across distinct sources", () => {
      let entries: any[] = [];

      // Hit 1 from Source A
      const res1 = upsertScratchpadEntry(entries, {
        claim: "Reranker models reduce hallucination in RAG",
        entityName: "Reranker",
        sourceId: "paper:1",
      });
      entries = res1.entries;
      expect(res1.updated.hitCount).toBe(1);
      expect(res1.updated.status).toBe("DEFERRED");

      // Hit 2 from Source B (collision!)
      const res2 = upsertScratchpadEntry(entries, {
        claim: "Reranker models reduce hallucination in RAG",
        entityName: "Reranker",
        sourceId: "paper:2",
      });
      entries = res2.entries;
      expect(res2.updated.hitCount).toBe(2);
      expect(res2.updated.sources.length).toBe(2);
      expect(res2.updated.status).toBe("READY_FOR_PROMOTION");

      // Verify formatting and round-trip parsing
      const md = formatScratchpad(entries);
      expect(md).toContain("READY_FOR_PROMOTION");

      const parsed = parseScratchpad(md);
      expect(parsed.length).toBe(1);
      expect(parsed[0]?.hitCount).toBe(2);
      expect(parsed[0]?.status).toBe("READY_FOR_PROMOTION");
    });

    it("prunes solitary entries older than ttlDays (14 days)", () => {
      const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const recentDate = new Date().toISOString().slice(0, 10);

      const entries = [
        {
          firstSeen: oldDate,
          claim: "Old solitary thought",
          hitCount: 1,
          relatedEntities: [],
          sources: ["source-old"],
          status: "DEFERRED" as const,
        },
        {
          firstSeen: recentDate,
          claim: "Recent thought",
          hitCount: 1,
          relatedEntities: [],
          sources: ["source-recent"],
          status: "DEFERRED" as const,
        },
        {
          firstSeen: oldDate,
          claim: "Multi-hit thought",
          hitCount: 3,
          relatedEntities: [],
          sources: ["s1", "s2"],
          status: "READY_FOR_PROMOTION" as const,
        },
      ];

      const { active, expired } = pruneExpiredScratchpad(entries, 14);
      expect(expired.length).toBe(1);
      expect(expired[0]?.claim).toBe("Old solitary thought");
      expect(active.length).toBe(2);
    });
  });
});
