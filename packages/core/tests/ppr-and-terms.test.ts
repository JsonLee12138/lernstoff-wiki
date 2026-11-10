import { describe, it, expect } from "vitest";
import { segment, computeLexicalNovelty } from "../src/algorithms/term-index.js";
import { buildWikilinkGraph, extractNoteLinks } from "../src/algorithms/wikilink-graph.js";
import { personalizedPageRank } from "../src/algorithms/monte-carlo-ppr.js";

describe("Gate 3: Lexical Novelty & Graph PPR (ppr-and-terms)", () => {
  describe("term-index segment & novelty", () => {
    it("segments English words and CJK character bigrams without language flags", () => {
      const enTerms = segment("RAG with PostgreSQL and Redis cache!");
      expect(enTerms).toContain("rag");
      expect(enTerms).toContain("postgresql");
      expect(enTerms).toContain("redis");
      expect(enTerms).toContain("cache");

      // CJK text
      const zhTerms = segment("基于Raft共识算法的一致性校验");
      expect(zhTerms).toContain("raft");
      expect(zhTerms).toContain("基于");
      expect(zhTerms).toContain("共识");
      expect(zhTerms).toContain("算法");
      expect(zhTerms).toContain("一致");
    });

    it("computes lexical novelty rate correctly", () => {
      const existing = [
        "PostgreSQL supports ACID transactions with multi-version concurrency control.",
        "Redis is an in-memory key-value store used for low latency caching.",
      ];

      // Highly redundant claim sharing terms
      const redundantClaim = "PostgreSQL multi-version concurrency control supports ACID.";
      const redundancyScore = computeLexicalNovelty(redundantClaim, existing);
      expect(redundancyScore).toBeLessThan(0.15); // Almost all terms already present

      // Highly novel claim
      const novelClaim =
        "Quantum annealing algorithms optimize quadratic unconstrained binary problems.";
      const noveltyScore = computeLexicalNovelty(novelClaim, existing);
      expect(noveltyScore).toBeGreaterThan(0.7); // Most terms are completely new
    });
  });

  describe("wikilink-graph & Monte Carlo PPR", () => {
    it("extracts standard and typed wikilinks", () => {
      const markdown = `
# Sample Note

This note [[supports::acid-guarantees]] and [[extends::concurrency-models]].
It also mentions [[redis-cache]] and [[standard-note|alias]].
`;
      const edges = extractNoteLinks(markdown);
      expect(edges).toEqual([
        { target: "acid-guarantees", relation: "supports" },
        { target: "concurrency-models", relation: "extends" },
        { target: "redis-cache" },
        { target: "standard-note" },
      ]);
    });

    it("builds bidirectional graph and performs 2-hop PPR random walk", () => {
      // Graph topology:
      // A <-> B <-> C <-> D
      // E (isolated)
      const graph = buildWikilinkGraph([
        { id: "note-a", content: "Links to [[note-b]]" },
        { id: "note-b", content: "Links to [[note-a]] and [[note-c]]" },
        { id: "note-c", content: "Links to [[note-b]] and [[note-d]]" },
        { id: "note-d", content: "Links to [[note-c]]" },
        { id: "note-e", content: "No links" },
      ]);

      expect(graph.nodes.length).toBe(5);
      expect(graph.undirectedEdges.get("note-b")).toContain("note-a");
      expect(graph.undirectedEdges.get("note-b")).toContain("note-c");

      // Starting walk from note-a:
      // 1-hop neighbor is note-b.
      // 2-hop neighbor is note-c.
      const pprHits = personalizedPageRank(graph, "note-a", { topK: 3 });
      expect(pprHits.length).toBeGreaterThan(0);
      expect(pprHits[0]?.nodeId).toBe("note-b"); // Closest neighbor gets highest probability
      expect(pprHits.map((h) => h.nodeId)).toContain("note-c"); // 2-hop associative neighbor reached
      expect(pprHits.map((h) => h.nodeId)).not.toContain("note-e"); // Disconnected node is not reached
    });
  });
});
