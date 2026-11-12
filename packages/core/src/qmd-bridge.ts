import { join, dirname } from "node:path";
import { mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import type {
  QMDStore,
  SearchOptions,
  IndexStatus,
  DocumentResult,
  DocumentNotFound,
  DocumentExcludedByIgnore,
} from "@tobilu/qmd";
import { loadConfig, type LernstoffConfig, LERNSTOFF_DIR } from "./config.js";
import { computeLexicalNovelty, segment } from "./algorithms/term-index.js";

export type EntailmentVerdict = "ENTAILS_KNOWN" | "EXTENDS_BOUNDARY" | "CONTRADICTS_CLAIM";

export type QmdSearchResult = Awaited<ReturnType<QMDStore["search"]>>;
export type QmdMultiGetResult = Awaited<ReturnType<QMDStore["multiGet"]>>;

export interface QmdBridgeOptions {
  vaultPath: string;
  config?: LernstoffConfig;
  mockSearch?: (options: SearchOptions) => Promise<any[]>;
  mockReranker?: (query: string, documents: string[]) => Promise<number[]>;
  mockClassifier?: (claim: string, existingText: string) => Promise<EntailmentVerdict>;
}

export class QmdBridge {
  private store: QMDStore | null = null;
  private vaultPath: string;
  private config: LernstoffConfig;
  private mockSearch?: (options: SearchOptions) => Promise<any[]>;
  private mockReranker?: (query: string, documents: string[]) => Promise<number[]>;
  private mockClassifier?: (claim: string, existingText: string) => Promise<EntailmentVerdict>;

  constructor(options: QmdBridgeOptions) {
    this.vaultPath = options.vaultPath;
    this.config = options.config || loadConfig(options.vaultPath);
    this.mockSearch = options.mockSearch;
    this.mockReranker = options.mockReranker;
    this.mockClassifier = options.mockClassifier;
  }

  public updateConfig(newConfig: LernstoffConfig): void {
    this.config = newConfig;
  }

  public async getStore(): Promise<QMDStore> {
    if (!this.store) {
      const dbPath = join(this.vaultPath, LERNSTOFF_DIR, "index.sqlite");
      const wikiPath = join(this.vaultPath, this.config.paths.wikiDir);
      mkdirSync(dirname(dbPath), { recursive: true });
      mkdirSync(wikiPath, { recursive: true });

      const { createStore } = await import("@tobilu/qmd");
      this.store = await createStore({
        dbPath,
        config: {
          collections: {
            wiki: {
              path: wikiPath,
              pattern: "**/*.md",
            },
          },
          models: {
            embed: this.config.models.embed,
            rerank: this.config.models.rerank,
            generate: this.config.models.generate,
          },
        },
      });
    }
    return this.store;
  }

  public async search(options: SearchOptions): Promise<any[]> {
    if (this.mockSearch) {
      return this.mockSearch(options);
    }
    const s = await this.getStore();
    const searchOpts: SearchOptions = {
      ...options,
      rerank: options.rerank ?? false,
    };
    let results: any[] = [];
    try {
      results = await s.search(searchOpts);
    } catch {
      try {
        const q = options.query || options.queries?.[0]?.query;
        if (q) {
          results = await s.searchLex(q, { limit: options.limit });
        }
      } catch {
        results = [];
      }
    }

    if (results.length === 0) {
      const q = (options.query || options.queries?.[0]?.query || "").toLowerCase();
      if (q) {
        const conceptsDir = join(this.vaultPath, this.config.paths.conceptsDir);
        if (existsSync(conceptsDir)) {
          const files = readdirSync(conceptsDir).filter((f) => f.endsWith(".md"));
          for (const f of files) {
            try {
              const text = readFileSync(join(conceptsDir, f), "utf-8");
              if (text.toLowerCase().includes(q)) {
                results.push({
                  file: join(this.config.paths.conceptsDir, f),
                  displayPath: join(this.config.paths.conceptsDir, f),
                  title: f.replace(/\.md$/i, ""),
                  snippet: text.slice(0, 200),
                  score: 0.85,
                });
              }
            } catch {}
          }
        }
      }
    }

    return results;
  }

  public async get(
    file: string,
    options?: { includeBody?: boolean },
  ): Promise<DocumentResult | DocumentNotFound | DocumentExcludedByIgnore> {
    const s = await this.getStore();
    return s.get(file, options);
  }

  public async multiGet(
    pattern: string,
    options?: { includeBody?: boolean; maxBytes?: number },
  ): Promise<any> {
    const s = await this.getStore();
    return s.multiGet(pattern, options);
  }

  public async getStatus(): Promise<IndexStatus> {
    const s = await this.getStore();
    return s.getStatus();
  }

  public async update(): Promise<void> {
    const s = await this.getStore();
    await s.update();
  }

  public async embed(): Promise<void> {
    const s = await this.getStore();
    await s.embed();
  }

  /**
   * Reranks a list of passage documents against a query string using Qwen3-Reranker-0.6B.
   * Returns an array of normalized confidence scores in [0, 1].
   */
  public async rerankPassages(query: string, documents: string[]): Promise<number[]> {
    if (documents.length === 0) return [];

    if (this.mockReranker) {
      return this.mockReranker(query, documents);
    }

    try {
      const s = await this.getStore();
      const internalLlm = (s as any).internal?.llm;
      if (internalLlm && typeof internalLlm.rerank === "function") {
        // Race against a short timeout so offline or test environments without pre-pulled GGUF models fall back gracefully
        const timeoutMs = process.env.VITEST ? 100 : 150;
        const timeoutPromise = new Promise<null>((_, reject) =>
          setTimeout(
            () => reject(new Error("LLM rerank timed out (offline/test fallback)")),
            timeoutMs,
          ),
        );
        const rerankDocs = documents.map((d, idx) => ({ file: `passage-${idx}`, text: d }));
        const result = await Promise.race([internalLlm.rerank(query, rerankDocs), timeoutPromise]);
        if (result && Array.isArray(result.results)) {
          const scores = Array.from({ length: documents.length }, () => 0);
          for (const item of result.results) {
            if (typeof item.index === "number" && typeof item.score === "number") {
              scores[item.index] = Math.max(0, Math.min(1, item.score));
            }
          }
          return scores;
        }
      }
    } catch {
      // Fall through to heuristic
    }

    // Heuristic fallback (Jaccard similarity on segment terms)
    const queryTerms = new Set(segment(query));
    return documents.map((doc) => {
      const docTerms = new Set(segment(doc));
      if (docTerms.size === 0 || queryTerms.size === 0) return 0;
      let intersect = 0;
      for (const t of queryTerms) {
        if (docTerms.has(t)) intersect += 1;
      }
      return intersect / Math.sqrt(queryTerms.size * docTerms.size);
    });
  }

  /**
   * Classify entailment relation between candidate claim and existing note passage:
   * - ENTAILS_KNOWN: The existing note already strictly entails this claim.
   * - CONTRADICTS_CLAIM: The candidate contradicts or falsifies a statement in the existing note.
   * - EXTENDS_BOUNDARY: Extends existing knowledge with new qualifications, bounds, or evidence.
   */
  public async classifyEntailment(claim: string, existingText: string): Promise<EntailmentVerdict> {
    if (this.mockClassifier) {
      return this.mockClassifier(claim, existingText);
    }

    const novelty = computeLexicalNovelty(claim, [existingText]);

    // Decision matrix (PRD.md Section 4.3):
    // If lexical novelty is low (< 0.15), it entails known facts
    if (novelty < this.config.gate.minLexNovelty) {
      return "ENTAILS_KNOWN";
    }

    // Check for explicit contradiction signals when novelty is noticeable
    const contradictionMarkers = [
      "contrary to",
      "differs from",
      "unlike",
      "instead of",
      "however",
      "whereas",
      "fails to",
      "not supported",
      "disproves",
      "反之",
      "不同于",
      "缺陷",
      "并非",
      "不适用",
      "冲突",
      "违反",
      "无法保证",
      "不成立",
    ];
    const claimLower = claim.toLowerCase();
    const hasContradictionSignal = contradictionMarkers.some((m) => claimLower.includes(m));

    if (hasContradictionSignal && novelty >= 0.15) {
      return "CONTRADICTS_CLAIM";
    }

    return "EXTENDS_BOUNDARY";
  }

  public async close(): Promise<void> {
    if (this.store) {
      await this.store.close();
      this.store = null;
    }
  }
}
