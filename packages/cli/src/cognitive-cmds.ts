import { resolve, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import {
  VaultOps,
  QmdBridge,
  loadConfig,
  parseScratchpad,
  formatScratchpad,
  type ScratchpadEntry,
} from "@lernstoff/core";
import { getRunningDaemonInfo } from "./daemon-pid.js";

/**
 * Builds editor URI (e.g. obsidian://open?path={path}) for terminal hyperlinks.
 * Modeled on qmd/src/cli/qmd.ts#L2660-L2675.
 */
export function buildEditorUri(template: string, absPath: string, line = 1, col = 1): string {
  return template
    .replace("{path}", encodeURIComponent(absPath))
    .replace("{line}", String(line))
    .replace("{col}", String(col));
}

/**
 * OSC-8 terminal hyperlink format.
 */
export function termLink(
  text: string,
  url: string,
  isTTY: boolean = !!process.stdout.isTTY,
): string {
  if (!isTTY) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

export async function searchCmd(
  vaultPath: string,
  query: string,
  options: { lex?: boolean; vec?: boolean; ppr?: boolean; limit?: number; json?: boolean } = {},
): Promise<any> {
  const absVault = resolve(vaultPath);
  const config = loadConfig(absVault);
  const limit = options.limit || 5;

  const queries =
    options.lex && !options.vec
      ? [{ type: "lex" as const, query }]
      : options.vec && !options.lex
        ? [{ type: "vec" as const, query }]
        : [
            { type: "lex" as const, query },
            { type: "vec" as const, query },
          ];

  let daemonInfo = getRunningDaemonInfo(absVault);
  let searchResult: any;

  if (daemonInfo) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonInfo.port}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries,
          limit,
        }),
      });
      searchResult = await res.json();
    } catch {
      daemonInfo = null;
    }
  }

  if (!daemonInfo) {
    const bridge = new QmdBridge({ vaultPath: absVault, config });
    try {
      searchResult = await bridge.search({
        queries,
        limit,
      });
    } finally {
      await bridge.close();
    }
  }

  const hits = Array.isArray(searchResult) ? searchResult : searchResult?.directHits || [];
  if (hits.length === 0) {
    // Scan concepts dir as fallback
    const conceptsDir = join(absVault, config.paths.conceptsDir);
    if (existsSync(conceptsDir)) {
      const qLower = query.toLowerCase();
      const files = readdirSync(conceptsDir).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        try {
          const text = readFileSync(join(conceptsDir, f), "utf-8");
          if (text.toLowerCase().includes(qLower)) {
            hits.push({
              file: join(config.paths.conceptsDir, f),
              displayPath: join(config.paths.conceptsDir, f),
              title: f.replace(/\.md$/i, ""),
              snippet: text.slice(0, 150),
              score: 0.8,
            });
          }
        } catch {}
      }
      searchResult = hits;
    }
  }

  if (options.json) {
    console.log(JSON.stringify(searchResult, null, 2));
    return searchResult;
  }

  if (hits.length === 0) {
    console.log(`No results found for "${query}".`);
    return hits;
  }

  console.log(`\n🔍 Found ${hits.length} note(s) for "${query}":\n`);
  for (const hit of hits) {
    const filePath = hit.displayPath || hit.file || "";
    const fullPath = join(absVault, filePath);
    const link = termLink(filePath, buildEditorUri(config.paths.editorUriTemplate, fullPath));
    const title = hit.title || filePath;
    const score = hit.score !== undefined ? ` (score: ${(hit.score * 100).toFixed(1)}%)` : "";
    console.log(`  • ${title}${score}`);
    console.log(`    ${link}\n`);
  }

  return searchResult;
}

export async function inquiryCmd(
  vaultPath: string,
  action: "list" | "add" | "close" | "reopen",
  textOrId?: string,
  options: { json?: boolean } = {},
): Promise<any> {
  const absVault = resolve(vaultPath);
  let daemonInfo = getRunningDaemonInfo(absVault);
  let result: any;

  const payload: any = { action };
  if (action === "add") payload.question = textOrId;
  if (action === "close" || action === "reopen") payload.id = textOrId;

  if (daemonInfo) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonInfo.port}/api/inquiries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      result = await res.json();
    } catch {
      daemonInfo = null;
    }
  }

  if (!daemonInfo) {
    const ops = new VaultOps(absVault);
    result = await ops.manageInquiries(payload);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (action === "list" && Array.isArray(result)) {
    console.log(`\n🧠 Active Inquiry Tree (${result.length} questions):\n`);
    for (const inq of result) {
      const statusIcon = inq.status === "OPEN" ? "🟢" : "⚪";
      console.log(`  ${statusIcon} [${inq.id || "#"}] ${inq.question}`);
      if (inq.supportingNoteCount > 0) {
        console.log(`     ↳ ${inq.supportingNoteCount} supporting proposition note(s)`);
      }
    }
    console.log("");
  } else {
    console.log(`Inquiry updated:`, result);
  }

  return result;
}

export async function scratchpadCmd(
  vaultPath: string,
  action: "list" | "add" | "consolidate" | "gc",
  text?: string,
  options: { json?: boolean } = {},
): Promise<any> {
  const absVault = resolve(vaultPath);
  const config = loadConfig(absVault);
  const scratchFile = join(absVault, config.paths.scratchpadFile);

  if (action === "add") {
    if (!text) throw new Error("Text is required for scratchpad add.");
    let entries: ScratchpadEntry[] = [];
    if (existsSync(scratchFile)) {
      entries = parseScratchpad(readFileSync(scratchFile, "utf-8"));
    }
    entries.push({
      firstSeen: new Date().toISOString().slice(0, 10),
      claim: text.trim(),
      hitCount: 1,
      relatedEntities: [],
      sources: ["cli"],
      status: "DEFERRED",
    });
    writeFileSync(scratchFile, formatScratchpad(entries), "utf-8");
    console.log(`Recorded note to ${config.paths.scratchpadFile}`);
    return { added: text };
  }

  let daemonInfo = getRunningDaemonInfo(absVault);
  let result: any;
  const opAction = action === "gc" ? "gc" : "inspect";

  if (daemonInfo) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonInfo.port}/api/scratchpad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: opAction }),
      });
      result = await res.json();
    } catch {
      daemonInfo = null;
    }
  }

  if (!daemonInfo) {
    const ops = new VaultOps(absVault);
    result = await ops.consolidateScratchpad({ action: opAction });
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  console.log(
    `\n⚡ Scratchpad Buffer (Total: ${result.activeCount}, Ready for Promotion: ${result.promotions.length}):`,
  );
  for (const p of result.promotions) {
    console.log(
      `  ⭐ [PROMOTION READY] ${p.claim} (hits: ${p.hitCount}, sources: ${p.sources.join(", ")})`,
    );
  }
  if (result.decayedArchivedCount) {
    console.log(
      `  🗑️  Pruned & archived ${result.decayedArchivedCount} expired entries to .lernstoff/archive/decayed.jsonl`,
    );
  }
  console.log("");

  return result;
}

export async function lintCmd(vaultPath: string, options: { json?: boolean } = {}): Promise<any> {
  const absVault = resolve(vaultPath);
  let daemonInfo = getRunningDaemonInfo(absVault);
  let result: any;

  if (daemonInfo) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonInfo.port}/api/lint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkOrphans: true,
          checkContradictions: true,
          checkSynthesisReady: true,
        }),
      });
      result = await res.json();
    } catch {
      daemonInfo = null;
    }
  }

  if (!daemonInfo) {
    const ops = new VaultOps(absVault);
    result = await ops.lintWiki();
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  console.log(`\n🏛️  Socratic Health Audit:`);
  console.log(`   Total Notes: ${result.summary.totalNotes}`);
  console.log(`   Orphan Notes (in-degree 0): ${result.summary.orphanCount}`);
  for (const o of result.orphans) {
    console.log(`     ⚠️  Orphan: [[${o.title}]] (in: ${o.inDegree}, out: ${o.outDegree})`);
  }

  console.log(`   Contradictions: ${result.summary.contradictionCount}`);
  for (const c of result.contradictions) {
    console.log(`     ⚡ Latent Contradiction: [[${c.noteA}]] vs [[${c.noteB}]]`);
  }

  console.log(`   Synthesis Ready Inquiries: ${result.summary.synthesisReadyCount}`);
  for (const s of result.synthesisReady) {
    console.log(
      `     🌟 Ready: ${s.inquiryId} has ${s.supportingNoteCount} supporting notes -> ready for survey note!`,
    );
  }
  console.log("");

  return result;
}
