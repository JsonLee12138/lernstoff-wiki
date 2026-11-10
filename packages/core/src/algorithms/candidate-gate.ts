export type GateVerdict = "PASS_TO_GATE_2" | "DEFER_TO_SCRATCHPAD" | "AUTO_DISCARD";

export type PositionClassification = "prose" | "aside" | "absent";

export interface CandidateItem {
  entityName: string;
  claim: string;
  evidence?: string;
  coverage?: "substantially covered" | "briefly mentioned" | "named only" | string;
}

export interface Gate1Evaluation<T extends CandidateItem = CandidateItem> {
  candidate: T;
  position: PositionClassification;
  covered: boolean;
  verdict: GateVerdict;
  reason:
    | "prose+covered"
    | "prose+named"
    | "aside+covered"
    | "aside+named"
    | "absent"
    | "explicit_wikilink";
}

export interface GateLanguageProfile {
  inflection: readonly string[];
  connectives: ReadonlySet<string>;
  script?: "word" | "char";
  enumerationMarks?: readonly string[];
  exemplarMarkers?: readonly string[];
}

export const GATE_LANGUAGE_PROFILES: Readonly<Record<string, GateLanguageProfile>> = {
  de: {
    inflection: ["e", "s", "n", "en", "es", "er", "em", "ern", "nen"],
    connectives: new Set(["und", "oder", "sowie", "bzw."]),
    exemplarMarkers: [
      "\\bz\\.\\s?B\\.",
      "\\bwie\\b",
      "\\betwa\\b",
      "\\balternativ\\b",
      "\\bals\\b",
      "\\betc\\b",
      "\\bu\\.\\s?a\\.",
      "\\binkl\\b",
    ],
  },
  en: {
    inflection: ["s", "es", "'s"],
    connectives: new Set(["and", "or"]),
    exemplarMarkers: [
      "\\be\\.\\s?g\\.",
      "\\bsuch as\\b",
      "\\blike\\b",
      "\\bincluding\\b",
      "\\bincl\\b",
      "\\betc\\b",
    ],
  },
  zh: {
    inflection: [],
    connectives: new Set(["和", "及", "与", "或", "以及", "或者", "跟", "同"]),
    script: "char",
    enumerationMarks: ["、"],
  },
  ja: {
    inflection: [],
    connectives: new Set(["や", "と", "および", "及び", "または", "又は", "か", "も"]),
    script: "char",
    enumerationMarks: ["・"],
  },
};

export function gateProfileFor(language?: string | null): GateLanguageProfile {
  if (!language) return GATE_LANGUAGE_PROFILES.en!;
  const key = language.trim().toLowerCase();
  return (
    GATE_LANGUAGE_PROFILES[key] ??
    GATE_LANGUAGE_PROFILES[key.split(/[-_]/)[0]!] ??
    GATE_LANGUAGE_PROFILES.en!
  );
}

const ENUM_MIN_COMMAS = 2;
const ENUM_MAX_WORDS = 4;
const LIST_ITEM_MAX_WORDS = 6;
const ENUM_MAX_CHARS = 12;
const LIST_ITEM_MAX_CHARS = 16;

const SEPARATORS = /[,，、]/;
const SENTENCE_END = /[.;!?。；！？]/;
const PAREN_RE = /\([^()]*\)|\[[^[\]]*\]|（[^（）]*）|【[^【】]*】|「[^「」]*」|『[^『』]*』/g;
const LINK_RE = /!?\[\[([^\]\n|#]+)(?:[|#][^\]\n]*)?\]\]/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function atWordStart(text: string, pos: number): boolean {
  return pos === 0 || !WORD_CHAR.test(text[pos - 1]!);
}

function extractExplicitWikilinks(text: string): Set<string> {
  const set = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(LINK_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    if (match[1]) {
      set.add(match[1].trim().toLowerCase());
    }
  }
  return set;
}

const NEEDLE_CACHE = new Map<string, RegExp | null>();

function needleOf(name: string, profile: GateLanguageProfile): RegExp | null {
  const cacheKey = `${profile.script ?? "word"}:${name}`;
  if (NEEDLE_CACHE.has(cacheKey)) {
    return NEEDLE_CACHE.get(cacheKey)!;
  }

  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    NEEDLE_CACHE.set(cacheKey, null);
    return null;
  }
  if (profile.script === "char") {
    const re = new RegExp(parts.map(escapeRe).join("\\s*"), "giu");
    NEEDLE_CACHE.set(cacheKey, re);
    return re;
  }
  const inflection =
    profile.inflection.length > 0 ? `(?:${profile.inflection.map(escapeRe).join("|")})?` : "";
  const body = parts.map((p) => escapeRe(p) + inflection).join("\\s+");
  const re = new RegExp(`${body}(?![\\p{L}\\p{N}])`, "giu");
  NEEDLE_CACHE.set(cacheKey, re);
  return re;
}

export function classifyCandidatePosition(
  sourceText: string,
  name: string,
  profile: GateLanguageProfile,
): PositionClassification {
  const needle = needleOf(name, profile);
  if (!needle) return "absent";

  // Check if it appears at all
  let match: RegExpExecArray | null;
  const occurrences: { start: number; end: number }[] = [];
  while ((match = needle.exec(sourceText)) !== null) {
    if (profile.script === "char" || atWordStart(sourceText, match.index)) {
      occurrences.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  if (occurrences.length === 0) return "absent";

  // Check if at least one occurrence is in clean prose (not inside parenthesis and not in short enumeration)
  for (const occ of occurrences) {
    // 1. Is it inside parenthesis?
    let insideParen = false;
    let parenMatch: RegExpExecArray | null;
    const parenRe = new RegExp(PAREN_RE.source, "g");
    while ((parenMatch = parenRe.exec(sourceText)) !== null) {
      if (occ.start >= parenMatch.index && occ.end <= parenMatch.index + parenMatch[0].length) {
        // Parenthesis match found. Check if it's an exemplar marker list
        if (profile.exemplarMarkers && profile.exemplarMarkers.length > 0) {
          const exemplarRe = new RegExp(profile.exemplarMarkers.join("|"), "iu");
          if (exemplarRe.test(parenMatch[0])) {
            insideParen = false; // Exempted
            break;
          }
        }
        insideParen = true;
        break;
      }
    }
    if (insideParen) continue;

    // 2. Is it inside a short enumeration list item or comma list?
    const lineStart = sourceText.lastIndexOf("\n", occ.start) + 1;
    const lineEndIndex = sourceText.indexOf("\n", occ.end);
    const lineEnd = lineEndIndex === -1 ? sourceText.length : lineEndIndex;
    const line = sourceText.slice(lineStart, lineEnd).trim();

    // Check markdown list item
    const isListItem = /^[-*+]\s+/.test(line);
    if (isListItem) {
      const isChar = profile.script === "char";
      const length = isChar ? line.length : line.split(/\s+/).length;
      const maxLen = isChar ? LIST_ITEM_MAX_CHARS : LIST_ITEM_MAX_WORDS;
      if (length <= maxLen) {
        continue; // Aside / short bullet enumeration
      }
    }

    // Check comma series within sentence
    const sentenceStartMatch = sourceText
      .slice(0, occ.start)
      .search(new RegExp(`${SENTENCE_END.source}[^${SENTENCE_END.source}]*$`));
    const sentStart = sentenceStartMatch === -1 ? 0 : sentenceStartMatch + 1;
    const sentenceEndMatch = sourceText.slice(occ.end).search(SENTENCE_END);
    const sentEnd = sentenceEndMatch === -1 ? sourceText.length : occ.end + sentenceEndMatch;
    const sentence = sourceText.slice(sentStart, sentEnd);

    const separatorsCount = (sentence.match(new RegExp(SEPARATORS.source, "g")) || []).length;
    if (separatorsCount >= ENUM_MIN_COMMAS) {
      // Find chunk holding name
      const chunks = sentence.split(SEPARATORS);
      const needleChunk = chunks.find((c) => needle.test(c));
      if (needleChunk) {
        const isChar = profile.script === "char";
        const chunkLen = isChar
          ? needleChunk.trim().length
          : needleChunk.trim().split(/\s+/).length;
        const maxChunkLen = isChar ? ENUM_MAX_CHARS : ENUM_MAX_WORDS;
        if (chunkLen <= maxChunkLen) {
          continue; // Enumeration entry
        }
      }
    }

    // If we reached here, this occurrence is genuine prose!
    return "prose";
  }

  // If all occurrences were inside parentheses or short enumerations:
  return "aside";
}

export function evaluateGate1<T extends CandidateItem>(
  candidates: T[],
  sourceText: string,
  language?: string | null,
): Gate1Evaluation<T>[] {
  const profile = gateProfileFor(language);
  const explicitLinks = extractExplicitWikilinks(sourceText);

  return candidates.map((cand) => {
    const normalizedName = cand.entityName.trim().toLowerCase();
    const isExplicitlyLinked = explicitLinks.has(normalizedName);

    if (isExplicitlyLinked) {
      return {
        candidate: cand,
        position: "prose",
        covered: true,
        verdict: "PASS_TO_GATE_2",
        reason: "explicit_wikilink",
      };
    }

    const position = classifyCandidatePosition(sourceText, cand.entityName, profile);
    const coverage = (cand.coverage || "substantially covered").toLowerCase().trim();
    const covered = coverage === "substantially covered";

    if (position === "absent") {
      return {
        candidate: cand,
        position,
        covered,
        verdict: "AUTO_DISCARD",
        reason: "absent",
      };
    }

    if (position === "aside" && !covered) {
      return {
        candidate: cand,
        position,
        covered,
        verdict: "AUTO_DISCARD",
        reason: "aside+named",
      };
    }

    if (position === "prose" && !covered) {
      return {
        candidate: cand,
        position,
        covered,
        verdict: "DEFER_TO_SCRATCHPAD",
        reason: "prose+named",
      };
    }

    if (position === "aside" && covered) {
      return {
        candidate: cand,
        position,
        covered,
        verdict: "DEFER_TO_SCRATCHPAD",
        reason: "aside+covered",
      };
    }

    // position === 'prose' && covered
    return {
      candidate: cand,
      position: "prose",
      covered: true,
      verdict: "PASS_TO_GATE_2",
      reason: "prose+covered",
    };
  });
}
