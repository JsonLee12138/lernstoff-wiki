import type { LogicalRelation } from "./wikilink-graph.js";

export interface SocraticDefense {
  deltaExplanation: string;
  beliefUpdate: string;
  outboundLinks: Array<{
    targetNote: string;
    relation: LogicalRelation;
  }>;
}

export interface SocraticValidationResult {
  valid: boolean;
  errors: string[];
}

export interface SocraticGuardOptions {
  minPropositionCharsZh?: number;
  minPropositionWordsLatin?: number;
  minOutboundLinks?: number;
  coldStartGraceNotes?: number;
}

const COMMON_NOUN_BLOCKLIST = new Set([
  "redis",
  "kafka",
  "postgresql",
  "mysql",
  "docker",
  "kubernetes",
  "transformer",
  "attention",
  "rag",
  "llm",
  "bert",
  "gpt",
  "vector",
  "embedding",
  "database",
  "cache",
]);

/**
 * Validates that a note title is a falsifiable proposition rather than a bare noun topic.
 */
export function validatePropositionTitle(
  title: string,
  options: { minCharsZh?: number; minWordsLatin?: number } = {},
): { valid: boolean; error?: string } {
  const cleanTitle = title
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/\.md$/i, "");

  if (!cleanTitle) {
    return { valid: false, error: "Proposition title cannot be empty." };
  }

  // Check noun blocklist
  if (COMMON_NOUN_BLOCKLIST.has(cleanTitle.toLowerCase())) {
    return {
      valid: false,
      error: `Title '${cleanTitle}' is a bare noun topic. Proposition titles must state a falsifiable claim or mechanism.`,
    };
  }

  // Detect script (CJK vs Latin)
  const isCjk = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u.test(cleanTitle);

  if (isCjk) {
    const minChars = options.minCharsZh ?? 8;
    if (cleanTitle.length < minChars) {
      return {
        valid: false,
        error: `Chinese proposition title '${cleanTitle}' is too short (${cleanTitle.length} < ${minChars} chars). Must be a complete judgment statement.`,
      };
    }
  } else {
    const minWords = options.minWordsLatin ?? 4;
    const words = cleanTitle.split(/\s+/).filter(Boolean);
    if (words.length < minWords) {
      return {
        valid: false,
        error: `Proposition title '${cleanTitle}' has only ${words.length} words (< ${minWords} words). Must be a complete proposition sentence.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validates Socratic defense requirements before crystallizing a permanent note.
 */
export function validateSocraticDefense(
  defense: SocraticDefense,
  existingConceptCount: number,
  options: SocraticGuardOptions = {},
): SocraticValidationResult {
  const errors: string[] = [];
  const minOutbound = options.minOutboundLinks ?? 2;
  const coldStartGrace = options.coldStartGraceNotes ?? 3;

  if (!defense.deltaExplanation || defense.deltaExplanation.trim().length < 10) {
    errors.push(
      "Q1 (Epistemic Delta): deltaExplanation must clearly specify what new knowledge is added (> 10 chars).",
    );
  }

  if (!defense.beliefUpdate || defense.beliefUpdate.trim().length < 5) {
    errors.push(
      "Q2 (Belief Update): beliefUpdate must state which premise is updated or qualified.",
    );
  }

  // Enforce minimum typed bidirectional links if past cold-start grace period
  if (existingConceptCount >= coldStartGrace) {
    if (!defense.outboundLinks || defense.outboundLinks.length < minOutbound) {
      errors.push(
        `Q3 (Anti-Orphan Guard): Note must establish at least ${minOutbound} outbound typed links (found: ${
          defense.outboundLinks?.length ?? 0
        }). No orphan notes allowed.`,
      );
    }
  }

  // Validate relation types
  const validRelations: LogicalRelation[] = ["supports", "contradicts", "extends", "qualifies"];
  for (const link of defense.outboundLinks || []) {
    if (!validRelations.includes(link.relation)) {
      errors.push(
        `Invalid link relation '${link.relation}' for target '${link.targetNote}'. Valid: ${validRelations.join(", ")}`,
      );
    }
    if (!link.targetNote || !link.targetNote.trim()) {
      errors.push("Target note name in outbound links cannot be empty.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
