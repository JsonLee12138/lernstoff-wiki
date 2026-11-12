import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { type LernstoffConfig, loadConfig } from "./config.js";
import {
  type SocraticDefense,
  validatePropositionTitle,
  validateSocraticDefense,
} from "./algorithms/socratic-guard.js";
import { buildWikilinkGraph } from "./algorithms/wikilink-graph.js";
import {
  parseScratchpad,
  formatScratchpad,
  pruneExpiredScratchpad,
  type ScratchpadEntry,
} from "./algorithms/scratchpad-gc.js";
import { QmdBridge } from "./qmd-bridge.js";
import { VaultWatcher } from "./vault-watcher.js";

export interface CrystallizeNoteInput {
  operation: "CREATE_PROPOSITION" | "AMEND_EXISTING" | "SYNTHESIZE_CLUSTER";
  propositionTitle: string;
  targetPath?: string;
  inquiryRefs?: string[];
  socraticDefense: SocraticDefense;
  markdownBody: string;
  sources?: string[];
}

export interface CrystallizeNoteResult {
  path: string;
  title: string;
  operation: string;
  outboundLinksCount: number;
}

export interface ManageInquiriesInput {
  action: "list" | "add" | "close" | "reopen";
  id?: string;
  question?: string;
  context?: string;
  resolutionNote?: string;
}

export interface InquiryItem {
  id: string;
  status: "OPEN" | "CLOSED";
  question: string;
  resolutionNote?: string;
  supportingNoteCount: number;
}

export interface ConsolidateScratchpadInput {
  action: "inspect" | "promote" | "gc" | "add";
  itemIds?: string[];
  claim?: string;
  text?: string;
  relatedEntities?: string[];
  sources?: string[];
}

export interface ConsolidateScratchpadResult {
  promotions: ScratchpadEntry[];
  activeCount: number;
  decayedArchivedCount?: number;
}

export interface LintWikiOptions {
  checkOrphans?: boolean;
  checkContradictions?: boolean;
  checkSynthesisReady?: boolean;
}

export interface LintWikiResult {
  orphans: Array<{ path: string; title: string; inDegree: number; outDegree: number }>;
  contradictions: Array<{ noteA: string; noteB: string; similarity: number; reason: string }>;
  synthesisReady: Array<{
    inquiryId: string;
    question: string;
    supportingNoteCount: number;
    notes: string[];
  }>;
  summary: {
    totalNotes: number;
    orphanCount: number;
    contradictionCount: number;
    synthesisReadyCount: number;
  };
}

export class VaultOps {
  private vaultPath: string;
  private config: LernstoffConfig;
  private qmdBridge: QmdBridge;
  private watcher?: VaultWatcher;

  constructor(
    vaultPath: string,
    qmdBridge?: QmdBridge,
    watcher?: VaultWatcher,
    config?: LernstoffConfig,
  ) {
    this.vaultPath = vaultPath;
    this.config = config || loadConfig(vaultPath);
    this.qmdBridge = qmdBridge || new QmdBridge({ vaultPath, config: this.config });
    this.watcher = watcher;
  }

  public setWatcher(watcher: VaultWatcher): void {
    this.watcher = watcher;
  }

  public updateConfig(newConfig: LernstoffConfig): void {
    this.config = newConfig;
    this.qmdBridge.updateConfig(newConfig);
  }

  /**
   * Helper to slugify proposition title into a clean filename preserving CJK and Latin characters.
   */
  public static slugify(title: string): string {
    return title
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\-_]+/gu, "-")
      .replace(/^-+|-+$/g, "");
  }

  /**
   * Crystallize an Evergreen proposition note with Socratic defense guards and Obsidian native styling.
   */
  public async crystallizeNote(input: CrystallizeNoteInput): Promise<CrystallizeNoteResult> {
    const {
      operation,
      propositionTitle,
      targetPath,
      inquiryRefs = [],
      socraticDefense,
      markdownBody,
      sources = [],
    } = input;

    // 1. Socratic Proposition Title Validation
    const titleCheck = validatePropositionTitle(propositionTitle, {
      minCharsZh: this.config.socratic.minPropositionCharsZh,
      minWordsLatin: this.config.socratic.minPropositionWordsLatin,
    });
    if (!titleCheck.valid) {
      throw new Error(`[SocraticGuard] ${titleCheck.error}`);
    }

    // 2. Count existing concept notes
    const conceptsDir = join(this.vaultPath, this.config.paths.conceptsDir);
    mkdirSync(conceptsDir, { recursive: true });
    const existingNotes = existsSync(conceptsDir)
      ? readdirSync(conceptsDir).filter((f) => f.endsWith(".md"))
      : [];

    // 3. Socratic 4-Question Defense Validation
    const defenseCheck = validateSocraticDefense(
      socraticDefense,
      existingNotes.length,
      this.config.socratic,
    );
    if (!defenseCheck.valid) {
      throw new Error(
        `[SocraticGuard] Socratic defense failed:\n${defenseCheck.errors.join("\n")}`,
      );
    }

    // Determine target file path
    let relPath: string;
    if (operation === "AMEND_EXISTING" && targetPath) {
      relPath = targetPath.startsWith(this.config.paths.conceptsDir)
        ? targetPath
        : join(this.config.paths.conceptsDir, basename(targetPath));
    } else {
      const slug = VaultOps.slugify(propositionTitle);
      relPath = join(this.config.paths.conceptsDir, `${slug}.md`);
    }

    const fullPath = join(this.vaultPath, relPath);
    const nowIso = new Date().toISOString();

    let originalCreatedAt = nowIso;
    let existingBody = "";
    if (operation === "AMEND_EXISTING" && existsSync(fullPath)) {
      try {
        const rawExisting = readFileSync(fullPath, "utf-8");
        const mCreated = rawExisting.match(/^created_at:\s*["']?([^"'\n\r]+)["']?/m);
        if (mCreated && mCreated[1]) {
          originalCreatedAt = mCreated[1].trim();
        }
        const sections = rawExisting.split("---");
        if (sections.length >= 3) {
          let rest = sections.slice(2).join("---").trim();
          rest = rest.replace(/^#\s+[^\n]+\n+/, "");
          rest = rest.replace(/^>\s*\[![A-Z]+\][^\n]*\n(?:>[^\n]*\n)*/gm, "");
          const propsIdx = rest.indexOf("### Associated Propositions");
          if (propsIdx >= 0) {
            existingBody = rest.slice(0, propsIdx).trim();
          } else {
            const srcIdx = rest.indexOf("### Sources");
            if (srcIdx >= 0) {
              existingBody = rest.slice(0, srcIdx).trim();
            } else {
              existingBody = rest.trim();
            }
          }
        }
      } catch {
        // ignore read error
      }
    }

    // Mark programmatic write in watcher to avoid loop
    if (this.watcher) {
      this.watcher.markRecentWrite(relPath);
    }

    // 4. Format Native Obsidian Markdown Note
    const frontmatterLines = [
      "---",
      `title: ${JSON.stringify(propositionTitle)}`,
      `operation: ${operation}`,
      `status: ${operation === "AMEND_EXISTING" ? "amended" : "crystallized"}`,
      "inquiries:",
      ...inquiryRefs.map((ref) => `  - ${JSON.stringify(ref)}`),
      "sources:",
      ...sources.map((src) => `  - ${JSON.stringify(src)}`),
      `created_at: ${operation === "AMEND_EXISTING" ? originalCreatedAt : nowIso}`,
      `updated_at: ${nowIso}`,
      "---",
      "",
    ];

    const socraticCallout = [
      "> [!NOTE] Socratic Defense",
      `> **Q1 (Epistemic Delta)**: ${socraticDefense.deltaExplanation}`,
      `> **Q2 (Belief Update)**: ${socraticDefense.beliefUpdate}`,
      "",
    ];

    const amendmentCallout =
      operation === "AMEND_EXISTING"
        ? [
            "> [!WARNING] Cognitive Revision History",
            `> Amended on ${nowIso.slice(0, 10)}: ${socraticDefense.beliefUpdate}`,
            "",
          ]
        : [];

    const outboundLinksLines = [
      "### Associated Propositions",
      ...socraticDefense.outboundLinks.map((link) => `- ${link.relation} [[${link.targetNote}]]`),
      "",
    ];

    const sourcesSection =
      sources.length > 0 ? ["### Sources", ...sources.map((s) => `- ${s}`), ""] : [];

    const combinedBody =
      operation === "AMEND_EXISTING" && existingBody && !markdownBody.includes(existingBody)
        ? `${existingBody}\n\n${markdownBody.trim()}`
        : markdownBody.trim();

    const noteContent = [
      ...frontmatterLines,
      `# ${propositionTitle}`,
      "",
      ...socraticCallout,
      ...amendmentCallout,
      combinedBody,
      "",
      ...outboundLinksLines,
      ...sourcesSection,
    ].join("\n");

    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, noteContent, "utf-8");

    // 5. Append audit entry in wiki/log.md
    try {
      const logFile = join(this.vaultPath, this.config.paths.logFile);
      if (existsSync(logFile)) {
        const logEntry = `- [${nowIso.slice(0, 16)}] **${operation}**: [[${basename(relPath, ".md")}]] (${inquiryRefs.join(", ") || "no-inquiry"})\n`;
        appendFileSync(logFile, logEntry, "utf-8");
      }
    } catch {
      // Non-critical
    }

    // Update wiki/index.md with newly crystallized proposition note
    try {
      const indexFile = join(this.vaultPath, this.config.paths.indexFile);
      mkdirSync(dirname(indexFile), { recursive: true });
      const indexContent = existsSync(indexFile)
        ? readFileSync(indexFile, "utf-8")
        : "# Wiki Index\n";
      const noteSlug = basename(relPath, ".md");
      if (!indexContent.includes(noteSlug)) {
        const entry = `\n- [[${noteSlug}]] - ${propositionTitle}`;
        writeFileSync(indexFile, indexContent.trimEnd() + entry + "\n", "utf-8");
        if (this.watcher) {
          this.watcher.markRecentWrite(this.config.paths.indexFile);
        }
      }
    } catch {
      // Non-critical
    }

    // 6. Trigger QMD update
    try {
      await this.qmdBridge.update();
    } catch {
      // Ignore in mock/offline mode
    }

    return {
      path: relPath,
      title: propositionTitle,
      operation,
      outboundLinksCount: socraticDefense.outboundLinks.length,
    };
  }

  /**
   * Manage Inquiries Tree (wiki/inquiries.md)
   */
  public async manageInquiries(input: ManageInquiriesInput): Promise<any> {
    const inquiriesFile = join(this.vaultPath, this.config.paths.inquiriesFile);
    if (!existsSync(inquiriesFile)) {
      mkdirSync(dirname(inquiriesFile), { recursive: true });
      writeFileSync(
        inquiriesFile,
        "# Inquiries\n- [OPEN] #q-01: What are the fundamental tradeoffs and mechanisms under study?\n",
        "utf-8",
      );
    }

    const content = readFileSync(inquiriesFile, "utf-8");
    const lines = content.split("\n");

    const items: InquiryItem[] = [];
    for (const line of lines) {
      const match = line.match(/^[-*]\s*\[(OPEN|CLOSED)\]\s*(#[a-zA-Z0-9_-]+)?:\s*(.*)$/);
      if (match) {
        const status = match[1] as "OPEN" | "CLOSED";
        const id = match[2] || "";
        const rawQuestion = match[3] || "";
        let question = rawQuestion;
        let resolutionNote: string | undefined;

        const resMatch = rawQuestion.match(/^(.*?)\s*\(Resolved:\s*(.*?)\)$/);
        if (resMatch) {
          question = resMatch[1]?.trim() || rawQuestion;
          resolutionNote = resMatch[2]?.trim();
        }

        items.push({
          id,
          status,
          question: question.trim(),
          resolutionNote,
          supportingNoteCount: 0,
        });
      }
    }

    // Count supporting notes per inquiry
    const conceptsDir = join(this.vaultPath, this.config.paths.conceptsDir);
    if (existsSync(conceptsDir)) {
      const files = readdirSync(conceptsDir).filter((f) => f.endsWith(".md"));
      for (const item of items) {
        if (!item.id) continue;
        let count = 0;
        for (const file of files) {
          try {
            const noteText = readFileSync(join(conceptsDir, file), "utf-8");
            if (noteText.includes(item.id)) {
              count += 1;
            }
          } catch {
            // ignore
          }
        }
        item.supportingNoteCount = count;
      }
    }

    if (input.action === "list") {
      return items;
    }

    if (input.action === "add") {
      if (!input.question) {
        throw new Error("Question text is required to add an inquiry.");
      }

      // Generate next inquiry ID (#q-01, #q-02, ...)
      let nextNum = 1;
      for (const item of items) {
        const numMatch = item.id.match(/^#q-(\d+)$/);
        if (numMatch && numMatch[1]) {
          const n = parseInt(numMatch[1], 10);
          if (n >= nextNum) nextNum = n + 1;
        }
      }
      const newId = input.id || `#q-${String(nextNum).padStart(2, "0")}`;
      const newLine = `- [OPEN] ${newId}: ${input.question.trim()}${input.context ? ` (${input.context.trim()})` : ""}`;

      if (this.watcher) {
        this.watcher.markRecentWrite(this.config.paths.inquiriesFile);
      }

      const updatedContent = `${content.trimEnd()}\n${newLine}\n`;
      writeFileSync(inquiriesFile, updatedContent, "utf-8");

      return {
        action: "add",
        inquiry: {
          id: newId,
          status: "OPEN",
          question: input.question.trim(),
        },
      };
    }

    if (input.action === "close") {
      if (!input.id && !input.question) {
        throw new Error("Inquiry ID or question text is required to close.");
      }

      let updated = false;
      const newLines = lines.map((line) => {
        if (
          (input.id && line.includes(input.id)) ||
          (input.question && line.includes(input.question))
        ) {
          updated = true;
          const cleaned = line.replace(/^[-*]\s*\[OPEN\]/, "- [CLOSED]");
          if (input.resolutionNote) {
            return `${cleaned} (Resolved: ${input.resolutionNote.trim()})`;
          }
          return cleaned;
        }
        return line;
      });

      if (!updated) {
        throw new Error(`Inquiry '${input.id || input.question}' not found.`);
      }

      if (this.watcher) {
        this.watcher.markRecentWrite(this.config.paths.inquiriesFile);
      }
      writeFileSync(inquiriesFile, newLines.join("\n"), "utf-8");
      return { action: "close", id: input.id, success: true };
    }

    if (input.action === "reopen") {
      if (!input.id && !input.question) {
        throw new Error("Inquiry ID or question text is required to reopen.");
      }

      let updated = false;
      const newLines = lines.map((line) => {
        if (
          (input.id && line.includes(input.id)) ||
          (input.question && line.includes(input.question))
        ) {
          updated = true;
          return line.replace(/^[-*]\s*\[CLOSED\]/, "- [OPEN]").replace(/\s*\(Resolved:.*?\)/, "");
        }
        return line;
      });

      if (!updated) {
        throw new Error(`Inquiry '${input.id || input.question}' not found.`);
      }

      if (this.watcher) {
        this.watcher.markRecentWrite(this.config.paths.inquiriesFile);
      }
      writeFileSync(inquiriesFile, newLines.join("\n"), "utf-8");
      return { action: "reopen", id: input.id, success: true };
    }

    return items;
  }

  /**
   * Consolidate and GC Scratchpad (inbox/scratchpad.md)
   */
  public async consolidateScratchpad(
    input: ConsolidateScratchpadInput,
  ): Promise<ConsolidateScratchpadResult> {
    const scratchpadFile = join(this.vaultPath, this.config.paths.scratchpadFile);
    if (!existsSync(scratchpadFile)) {
      return { promotions: [], activeCount: 0 };
    }

    const content = readFileSync(scratchpadFile, "utf-8");
    const entries = parseScratchpad(content);

    const getPromotions = (list: ScratchpadEntry[]) =>
      list.filter((e) => {
        if (e.status === "PROMOTED") return false;
        const uniqueSources = new Set(e.sources).size;
        return (
          e.status === "READY_FOR_PROMOTION" ||
          (e.hitCount >= this.config.scratchpad.promoteHitCount &&
            uniqueSources >= this.config.scratchpad.promoteMinSources)
        );
      });

    const promotions = getPromotions(entries);

    if (input.action === "inspect") {
      return {
        promotions,
        activeCount: entries.length,
      };
    }

    if (input.action === "add") {
      const claim = (input.claim || input.text || "").trim();
      if (!claim) {
        throw new Error("Claim text is required to add scratchpad entry.");
      }
      entries.push({
        firstSeen: new Date().toISOString().slice(0, 10),
        claim,
        hitCount: 1,
        relatedEntities: input.relatedEntities || [],
        sources: input.sources || ["manual"],
        status: "DEFERRED",
      });
      if (this.watcher) {
        this.watcher.markRecentWrite(this.config.paths.scratchpadFile);
      }
      writeFileSync(scratchpadFile, formatScratchpad(entries), "utf-8");
      return {
        promotions: getPromotions(entries),
        activeCount: entries.length,
      };
    }

    if (input.action === "promote") {
      const itemIds = new Set(input.itemIds || []);
      const updatedEntries = entries.map((e) => {
        if (itemIds.size === 0 || (e.id && itemIds.has(e.id)) || itemIds.has(e.claim)) {
          return { ...e, status: "PROMOTED" as const };
        }
        return e;
      });

      if (this.watcher) {
        this.watcher.markRecentWrite(this.config.paths.scratchpadFile);
      }
      writeFileSync(scratchpadFile, formatScratchpad(updatedEntries), "utf-8");
      return {
        promotions: getPromotions(updatedEntries),
        activeCount: updatedEntries.length,
      };
    }

    if (input.action === "gc") {
      const archiveDir = join(this.vaultPath, ".lernstoff", "archive");
      mkdirSync(archiveDir, { recursive: true });

      const referencedTerms = new Set<string>();
      const conceptsDir = join(this.vaultPath, this.config.paths.conceptsDir);
      if (existsSync(conceptsDir)) {
        const cFiles = readdirSync(conceptsDir).filter((f) => f.endsWith(".md"));
        for (const cf of cFiles) {
          try {
            const cContent = readFileSync(join(conceptsDir, cf), "utf-8");
            referencedTerms.add(basename(cf, ".md"));
            const linkMatches = cContent.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g);
            for (const lm of linkMatches) {
              if (lm[1]) referencedTerms.add(lm[1].trim());
            }
            const titleMatch =
              cContent.match(/^title:\s*["']?([^"'\n\r]+)["']?/m) || cContent.match(/^#\s+(.+)$/m);
            if (titleMatch && titleMatch[1]) {
              referencedTerms.add(titleMatch[1].trim());
            }
            for (const line of cContent.split("\n")) {
              const clean = line.replace(/^[#\-*>\s]+/, "").trim();
              if (clean.length > 3) {
                referencedTerms.add(clean);
              }
            }
          } catch {
            // ignore
          }
        }
      }

      const pruneResult = pruneExpiredScratchpad(
        entries,
        this.config.scratchpad.ttlDays,
        referencedTerms,
      );

      if (pruneResult.expired.length > 0) {
        const archiveFile = join(archiveDir, "decayed.jsonl");
        const lines = pruneResult.expired.map((e) => JSON.stringify(e)).join("\n") + "\n";
        appendFileSync(archiveFile, lines, "utf-8");
      }

      if (this.watcher) {
        this.watcher.markRecentWrite(this.config.paths.scratchpadFile);
      }
      writeFileSync(scratchpadFile, formatScratchpad(pruneResult.active), "utf-8");

      return {
        promotions: getPromotions(pruneResult.active),
        activeCount: pruneResult.active.length,
        decayedArchivedCount: pruneResult.expired.length,
      };
    }

    return { promotions, activeCount: entries.length };
  }

  /**
   * Run Socratic Wiki Health Audit:
   * 1. Detect orphan notes (in-degree 0)
   * 2. Detect latent contradiction pairs within concept clusters
   * 3. Detect inquiries ready for synthesis (>= 5 supporting notes)
   */
  public async lintWiki(options: LintWikiOptions = {}): Promise<LintWikiResult> {
    const { checkOrphans = true, checkContradictions = true, checkSynthesisReady = true } = options;

    const conceptsDir = join(this.vaultPath, this.config.paths.conceptsDir);
    if (!existsSync(conceptsDir)) {
      return {
        orphans: [],
        contradictions: [],
        synthesisReady: [],
        summary: { totalNotes: 0, orphanCount: 0, contradictionCount: 0, synthesisReadyCount: 0 },
      };
    }

    const files = readdirSync(conceptsDir).filter((f) => f.endsWith(".md"));
    const nodesData = files.map((f) => {
      const id = f.replace(/\.md$/i, "");
      const content = readFileSync(join(conceptsDir, f), "utf-8");
      return { id, content };
    });

    const graph = buildWikilinkGraph(nodesData);
    const orphans: LintWikiResult["orphans"] = [];

    // 1. Orphan Check (in-degree == 0 when total >= coldStartGraceNotes)
    if (checkOrphans && files.length >= this.config.socratic.coldStartGraceNotes) {
      for (const node of graph.nodes) {
        const inDegree = graph.inDegrees.get(node) ?? 0;
        const outDegree = graph.outDegrees.get(node) ?? 0;
        if (inDegree === 0) {
          orphans.push({
            path: join(this.config.paths.conceptsDir, `${node}.md`),
            title: node,
            inDegree,
            outDegree,
          });
        }
      }
    }

    // 2. Synthesis Ready Check
    const synthesisReady: LintWikiResult["synthesisReady"] = [];
    if (checkSynthesisReady) {
      const inquiries = await this.manageInquiries({ action: "list" });
      for (const inq of inquiries) {
        if (
          inq.status === "OPEN" &&
          inq.supportingNoteCount >= this.config.socratic.synthesisThreshold
        ) {
          const matchingNotes = files
            .filter((f) => {
              const text = readFileSync(join(conceptsDir, f), "utf-8");
              return text.includes(inq.id);
            })
            .map((f) => basename(f, ".md"));

          synthesisReady.push({
            inquiryId: inq.id,
            question: inq.question,
            supportingNoteCount: inq.supportingNoteCount,
            notes: matchingNotes,
          });
        }
      }
    }

    // 3. Contradiction Detection
    const contradictions: LintWikiResult["contradictions"] = [];
    if (checkContradictions && files.length >= 2) {
      for (let i = 0; i < nodesData.length; i++) {
        for (let j = i + 1; j < nodesData.length; j++) {
          const a = nodesData[i]!;
          const b = nodesData[j]!;

          // Check if already connected by an explicit typed 'contradicts' edge in either direction
          const edgesA = graph.relations.get(a.id) || [];
          const edgesB = graph.relations.get(b.id) || [];
          const hasContradictsEdge =
            edgesA.some((e) => e.target === b.id && e.relation === "contradicts") ||
            edgesB.some((e) => e.target === a.id && e.relation === "contradicts");

          if (hasContradictsEdge) {
            continue;
          }

          // Strip relations section so "- contradicts [[...]]" isn't treated as divergent prose
          const stripRelations = (text: string) =>
            text.replace(/###\s*Associated Propositions[\s\S]*?(?:###|$)/gi, "").trim();

          const proseA = stripRelations(a.content).toLowerCase();
          const proseB = stripRelations(b.content).toLowerCase();

          // Check if prose explicitly mentions the other note or expresses contrary/contradiction
          const aMentionsB =
            proseA.includes(`[[${b.id.toLowerCase()}]]`) ||
            proseA.includes(b.id.toLowerCase().replace(/-/g, " "));
          const bMentionsA =
            proseB.includes(`[[${a.id.toLowerCase()}]]`) ||
            proseB.includes(a.id.toLowerCase().replace(/-/g, " "));

          const aHasContrary = proseA.includes("contrary to") || proseA.includes("contradict");
          const bHasContrary = proseB.includes("contrary to") || proseB.includes("contradict");

          // Check topic overlap
          const getKeywords = (text: string) => {
            const words = text.toLowerCase().match(/\b[a-z0-9_\u4e00-\u9fa5]{3,}\b/gu) || [];
            return new Set(
              words.filter(
                (w) =>
                  ![
                    "note",
                    "title",
                    "true",
                    "false",
                    "this",
                    "that",
                    "with",
                    "from",
                    "reduces",
                    "causes",
                  ].includes(w),
              ),
            );
          };
          const wordsA = getKeywords(proseA);
          const wordsB = getKeywords(proseB);
          let overlap = 0;
          for (const w of wordsA) {
            if (wordsB.has(w)) overlap++;
          }

          const shareInquiry = (() => {
            const inqRegex = /inquiries:\s*\n((?:\s*-\s*[^\n]+\n)*)/i;
            const matchA = a.content.match(inqRegex);
            const matchB = b.content.match(inqRegex);
            const inqsA = matchA ? matchA[1]?.match(/#q-\d+/g) || [] : [];
            const inqsB = new Set(matchB ? matchB[1]?.match(/#q-\d+/g) || [] : []);
            return inqsA.some((iq) => inqsB.has(iq));
          })();

          // Latent contradiction condition:
          // 1) Either note directly mentions the other in contrary prose: (aMentionsB && aHasContrary) || (bMentionsA && bHasContrary)
          // 2) OR they share significant topic overlap (>=2 shared keywords) or share an inquiry, AND one has contrary/contradiction prose
          const isContradiction =
            (aMentionsB && aHasContrary) ||
            (bMentionsA && bHasContrary) ||
            ((overlap >= 2 || shareInquiry) && (aHasContrary || bHasContrary));

          if (isContradiction) {
            contradictions.push({
              noteA: a.id,
              noteB: b.id,
              similarity: 0.75,
              reason: `Notes '${a.id}' and '${b.id}' express divergent polarity without an explicit 'contradicts' relation edge.`,
            });
          }
        }
      }
    }

    return {
      orphans,
      contradictions,
      synthesisReady,
      summary: {
        totalNotes: files.length,
        orphanCount: orphans.length,
        contradictionCount: contradictions.length,
        synthesisReadyCount: synthesisReady.length,
      },
    };
  }
}
