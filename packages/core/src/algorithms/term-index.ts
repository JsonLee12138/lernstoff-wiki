export const WORD_CHAR_CLASS = "\\p{L}\\p{N}\\p{M}";
export const NO_BOUNDARY_SCRIPT =
  "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}\\p{sc=Thai}";

const NO_BOUNDARY = new RegExp(`[${NO_BOUNDARY_SCRIPT}]`, "u");
const NOT_WORD_CHAR = new RegExp(`[^${WORD_CHAR_CLASS}]`, "u");
const WORD_CHAR = new RegExp(`[${WORD_CHAR_CLASS}]`, "u");

/**
 * Script-aware tokenizer:
 * Converts Unicode NFKC normalized text to lower-case.
 * Bounded-word runs (Latin, Cyrillic, etc.) become whole words.
 * Boundaryless scripts (Han, Hiragana, Katakana, Hangul, Thai) become character bigrams.
 */
export function segment(text: string): string[] {
  const terms: string[] = [];
  const lower = text.normalize("NFKC").toLowerCase();
  const chars = [...lower];
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i]!;
    if (NOT_WORD_CHAR.test(ch)) {
      i += 1;
      continue;
    }

    const boundaryless = NO_BOUNDARY.test(ch);
    let j = i;
    while (j < chars.length) {
      const c = chars[j]!;
      if (NOT_WORD_CHAR.test(c)) break;
      if (NO_BOUNDARY.test(c) !== boundaryless) break;
      j += 1;
    }

    const run = chars.slice(i, j);
    if (boundaryless) {
      if (run.length === 1) {
        terms.push(run[0]!);
      } else {
        for (let k = 0; k + 1 < run.length; k += 1) {
          terms.push(run[k]! + run[k + 1]!);
        }
      }
    } else {
      const word = run.join("");
      if (WORD_CHAR.test(word)) {
        terms.push(word);
      }
    }
    i = j;
  }
  return terms;
}

/**
 * Compute Lexical Novelty rate:
 * Δ_lex(claim, existingDocs) = |T(claim) \ T(existingDocs)| / |T(claim)|
 * Returns a value in [0, 1].
 */
export function computeLexicalNovelty(claim: string, existingDocs: string[]): number {
  const claimTerms = new Set(segment(claim));
  if (claimTerms.size === 0) return 0;

  const existingTerms = new Set<string>();
  for (const doc of existingDocs) {
    const terms = segment(doc);
    for (const term of terms) {
      existingTerms.add(term);
    }
  }

  let novelCount = 0;
  for (const term of claimTerms) {
    if (!existingTerms.has(term)) {
      novelCount += 1;
    }
  }

  return novelCount / claimTerms.size;
}
