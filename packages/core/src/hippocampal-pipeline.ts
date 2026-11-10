import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateGate1, type CandidateItem } from "./algorithms/candidate-gate.js";
import { computeLexicalNovelty } from "./algorithms/term-index.js";
import { buildWikilinkGraph } from "./algorithms/wikilink-graph.js";
import { personalizedPageRank } from "./algorithms/monte-carlo-ppr.js";
import {
  parseScratchpad,
  formatScratchpad,
  upsertScratchpadEntry,
  type ScratchpadEntry,
} from "./algorithms/scratchpad-gc.js";
import type { QmdBridge } from "./qmd-bridge.js";
import { loadConfig, type LernstoffConfig } from "./config.js";

export type SurvivorVerdict = "ESCALATE_CONFLICT" | "ESCALATE_EXTENSION" | "ESCALATE_NOVEL_CONCEPT";

export interface RecalledContextNote {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

export interface HippocampalSurvivor<T extends CandidateItem = CandidateItem> {
  candidate: T;
  verdict: SurvivorVerdict;
  semanticSimilarity: number;
  lexicalNovelty: number;
  recalledNotes: RecalledContextNote[];
  recommendedTargetNote?: string;
}

export interface PipelineStats {
  totalCandidates: number;
  discardedGate1: number;
  discardedGate2: number;
  discardedGate3: number;
  deferredScratchpad: number;
  escalated: number;
  noiseFilteredRatio: number;
}

export interface ProbeDeltaOutput<T extends CandidateItem = CandidateItem> {
  survivors: HippocampalSurvivor<T>[];
  scratchpadPromotions: ScratchpadEntry[];
  stats: PipelineStats;
}

export interface ProbeDeltaParams<T extends CandidateItem = CandidateItem> {
  sourceId: string;
  sourceText: string;
  language?: string;
  candidates: T[];
}

export class HippocampalPipeline {
  private vaultPath: string;
  private qmdBridge: QmdBridge;
  private config: LernstoffConfig;

  constructor(vaultPath: string, qmdBridge: QmdBridge, config?: LernstoffConfig) {
    this.vaultPath = vaultPath;
    this.qmdBridge = qmdBridge;
    this.config = config || loadConfig(vaultPath);
  }

  public async probeDelta<T extends CandidateItem>(
    params: ProbeDeltaParams<T>,
  ): Promise<ProbeDeltaOutput<T>> {
    const { sourceId, sourceText, language, candidates } = params;
    let discardedGate1 = 0;
    let discardedGate2 = 0;
    let discardedGate3 = 0;
    let deferredScratchpad = 0;

    const scratchpadFile = join(this.vaultPath, this.config.paths.scratchpadFile);
    let scratchpadEntries: ScratchpadEntry[] = [];
    if (existsSync(scratchpadFile)) {
      try {
        scratchpadEntries = parseScratchpad(readFileSync(scratchpadFile, "utf-8"));
      } catch {
        scratchpadEntries = [];
      }
    }

    const newlyPromoted: ScratchpadEntry[] = [];

    // Helper to defer items to scratchpad
    const deferToScratchpad = (item: { claim: string; entityName?: string }) => {
      deferredScratchpad += 1;
      const res = upsertScratchpadEntry(scratchpadEntries, {
        claim: item.claim,
        entityName: item.entityName,
        sourceId,
      });
      scratchpadEntries = res.entries;
      if (res.updated.status === "READY_FOR_PROMOTION") {
        if (!newlyPromoted.some((p) => p.claim === res.updated.claim)) {
          newlyPromoted.push(res.updated);
        }
      }
    };

    // =========================================================================
    // Stage 1: Multilingual Syntactic Position & Coverage Gate (< 1ms)
    // =========================================================================
    const gate1Evaluations = evaluateGate1(candidates, sourceText, language);
    const gate1Survivors: T[] = [];

    for (const evalItem of gate1Evaluations) {
      if (evalItem.verdict === "AUTO_DISCARD") {
        discardedGate1 += 1;
        continue;
      }
      if (evalItem.verdict === "DEFER_TO_SCRATCHPAD") {
        deferToScratchpad({
          claim: evalItem.candidate.claim,
          entityName: evalItem.candidate.entityName,
        });
        continue;
      }
      gate1Survivors.push(evalItem.candidate);
    }

    // =========================================================================
    // Stage 2: Inquiry Tree Alignment Gate (wiki/inquiries.md)
    // =========================================================================
    const openInquiries = this.loadOpenInquiries();
    const gate2Survivors: T[] = [];

    for (const candidate of gate1Survivors) {
      if (openInquiries.length === 0) {
        // Cold start fallback: when no open questions are present, pass to Gate 3
        gate2Survivors.push(candidate);
        continue;
      }

      const candidateProbeText = `${candidate.claim} ${candidate.evidence || ""}`.trim();
      const scores = await this.qmdBridge.rerankPassages(candidateProbeText, openInquiries);
      const maxInqScore = scores.length > 0 ? Math.max(...scores) : 0;

      if (maxInqScore < this.config.gate.tauOff) {
        discardedGate2 += 1; // OFF_TOPIC
        continue;
      }

      if (maxInqScore < this.config.gate.tauCore) {
        deferToScratchpad({
          claim: candidate.claim,
          entityName: candidate.entityName,
        });
        continue;
      }

      gate2Survivors.push(candidate);
    }

    // =========================================================================
    // Stage 3: Dual-Channel Memory Recall & Epistemic Delta Gate
    // =========================================================================
    const survivors: HippocampalSurvivor<T>[] = [];

    for (const candidate of gate2Survivors) {
      // Channel 1: QMD hybrid search recall (Top-5)
      let directHits: any[] = [];
      try {
        directHits = await this.qmdBridge.search({
          queries: [
            { type: "lex", query: candidate.entityName },
            { type: "vec", query: candidate.claim },
          ],
          limit: 5,
        });
      } catch {
        directHits = [];
      }

      // Channel 2: Monte Carlo PPR 2-hop associative graph walk
      const graph = await this.loadConceptsGraph();
      const directNoteSlugs = directHits
        .map((h) => h.displayPath || h.file || "")
        .filter(Boolean)
        .map((p) => p.replace(/\.md$/i, "").split("/").pop()!);

      const pprHits =
        directNoteSlugs.length > 0
          ? personalizedPageRank(graph, directNoteSlugs, {
              numWalks: this.config.gate.pprNumWalks,
              maxSteps: this.config.gate.pprMaxSteps,
              damping: this.config.gate.pprDamping,
              topK: this.config.gate.pprTopK,
            })
          : [];

      // Combine recalled notes W*
      const recalledNotes: RecalledContextNote[] = [];
      const seenPaths = new Set<string>();

      for (const hit of directHits) {
        const path = hit.displayPath || hit.file || "";
        if (path && !seenPaths.has(path)) {
          seenPaths.add(path);
          recalledNotes.push({
            path,
            title: hit.title || path,
            snippet: hit.body?.slice(0, 300) || "",
            score: hit.score || 0,
          });
        }
      }

      for (const ppr of pprHits) {
        const path = `wiki/concepts/${ppr.nodeId}.md`;
        if (!seenPaths.has(path)) {
          seenPaths.add(path);
          recalledNotes.push({
            path,
            title: ppr.nodeId,
            snippet: "",
            score: ppr.score,
          });
        }
      }

      // Completely novel concept with no recalled notes
      if (recalledNotes.length === 0) {
        survivors.push({
          candidate,
          verdict: "ESCALATE_NOVEL_CONCEPT",
          semanticSimilarity: 0,
          lexicalNovelty: 1.0,
          recalledNotes: [],
        });
        continue;
      }

      // Compute Semantic Similarity S_sem and Lexical Novelty Δ_lex
      const recalledSnippets = recalledNotes.map((n) => n.snippet).filter(Boolean);
      const semScores = await this.qmdBridge.rerankPassages(candidate.claim, recalledSnippets);
      const sSem = semScores.length > 0 ? Math.max(...semScores) : (recalledNotes[0]?.score ?? 0);
      const deltaLex = computeLexicalNovelty(candidate.claim, recalledSnippets);

      // Decision Matrix (PRD.md Section 4.3):
      if (sSem >= this.config.gate.maxSemRedundant && deltaLex < this.config.gate.minLexNovelty) {
        discardedGate3 += 1; // REDUNDANT_KNOWN
        continue;
      }

      let verdict: SurvivorVerdict = "ESCALATE_NOVEL_CONCEPT";
      if (sSem >= this.config.gate.entailmentTriggerScore) {
        const mostSimilarDoc =
          recalledSnippets[semScores.indexOf(sSem)] || recalledSnippets[0] || "";
        const entailment = await this.qmdBridge.classifyEntailment(candidate.claim, mostSimilarDoc);

        if (entailment === "ENTAILS_KNOWN") {
          discardedGate3 += 1; // REDUNDANT_KNOWN
          continue;
        } else if (entailment === "CONTRADICTS_CLAIM") {
          verdict = "ESCALATE_CONFLICT";
        } else {
          verdict = "ESCALATE_EXTENSION";
        }
      } else if (deltaLex >= 0.2) {
        verdict = "ESCALATE_NOVEL_CONCEPT";
      }

      survivors.push({
        candidate,
        verdict,
        semanticSimilarity: Math.round(sSem * 100) / 100,
        lexicalNovelty: Math.round(deltaLex * 100) / 100,
        recalledNotes,
        recommendedTargetNote: recalledNotes[0]?.path,
      });
    }

    // Persist scratchpad updates
    if (deferredScratchpad > 0) {
      try {
        writeFileSync(scratchpadFile, formatScratchpad(scratchpadEntries), "utf-8");
      } catch (err) {
        console.warn("[HippocampalPipeline] Failed to write scratchpad:", err);
      }
    }

    const totalCandidates = candidates.length;
    const totalDiscarded = discardedGate1 + discardedGate2 + discardedGate3 + deferredScratchpad;
    const noiseFilteredRatio =
      totalCandidates > 0 ? Math.round((totalDiscarded / totalCandidates) * 100) / 100 : 0;

    return {
      survivors,
      scratchpadPromotions: newlyPromoted,
      stats: {
        totalCandidates,
        discardedGate1,
        discardedGate2,
        discardedGate3,
        deferredScratchpad,
        escalated: survivors.length,
        noiseFilteredRatio,
      },
    };
  }

  private loadOpenInquiries(): string[] {
    const inquiriesPath = join(this.vaultPath, this.config.paths.inquiriesFile);
    if (!existsSync(inquiriesPath)) return [];

    try {
      const content = readFileSync(inquiriesPath, "utf-8");
      const lines = content.split("\n");
      const openQuestions: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- [OPEN]") || trimmed.startsWith("* [OPEN]")) {
          const qText = trimmed.replace(/^[-*]\s*\[OPEN\]\s*(#[a-zA-Z0-9_-]+:)?/, "").trim();
          if (qText) {
            openQuestions.push(qText);
          }
        }
      }
      return openQuestions;
    } catch {
      return [];
    }
  }

  private async loadConceptsGraph() {
    const conceptsDir = join(this.vaultPath, this.config.paths.conceptsDir);
    if (!existsSync(conceptsDir)) {
      return buildWikilinkGraph([]);
    }

    const { readdirSync } = await import("node:fs");
    try {
      const files = readdirSync(conceptsDir).filter((f) => f.endsWith(".md"));
      const nodesData = files.map((f) => {
        const id = f.replace(/\.md$/i, "");
        const content = readFileSync(join(conceptsDir, f), "utf-8");
        return { id, content };
      });
      return buildWikilinkGraph(nodesData);
    } catch {
      return buildWikilinkGraph([]);
    }
  }
}
