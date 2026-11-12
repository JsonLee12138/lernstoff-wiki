export interface ScratchpadEntry {
  id?: string;
  firstSeen: string; // YYYY-MM-DD
  claim: string;
  hitCount: number;
  relatedEntities: string[];
  sources: string[];
  status: "DEFERRED" | "READY_FOR_PROMOTION" | "PROMOTED" | "ARCHIVED";
}

export function parseScratchpad(markdown: string): ScratchpadEntry[] {
  const entries: ScratchpadEntry[] = [];
  const lines = markdown.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || trimmed.includes("首次记录") || trimmed.includes("---")) {
      continue;
    }

    const cols = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);

    if (cols.length >= 6) {
      const firstSeen = cols[0] || new Date().toISOString().slice(0, 10);
      const claim = cols[1] || "";
      const hitCount = parseInt(cols[2] || "1", 10) || 1;
      const relatedEntities = (cols[3] || "")
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const sources = (cols[4] || "")
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const statusRaw = cols[5] || "DEFERRED";
      const status = statusRaw.includes("PROMOTION")
        ? "READY_FOR_PROMOTION"
        : statusRaw.includes("PROMOTED")
          ? "PROMOTED"
          : statusRaw.includes("ARCHIVED")
            ? "ARCHIVED"
            : "DEFERRED";

      if (claim) {
        entries.push({
          firstSeen,
          claim,
          hitCount,
          relatedEntities,
          sources,
          status,
        });
      }
    }
  }

  return entries;
}

export function formatScratchpad(entries: ScratchpadEntry[]): string {
  const header = `# 闪念缓冲池 (Fast Scratchpad Buffer)

> **双速记忆机制**：记录尚未深入展开或处于探索边缘的闪念概念与推论。当同一概念在不同资料中被碰撞提及 ≥ 2 次时，自动触发晋升合成；驻留超过 14 天未被二次碰撞的碎片将自动修剪归档。

| 首次记录 | 概念 / 临时判断 | 碰撞计数 | 关联实体 | 来源线索 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
`;

  const rows = entries.map((entry) => {
    const entitiesStr = entry.relatedEntities.join(", ");
    const sourcesStr = entry.sources.join(", ");
    const statusLabel =
      entry.status === "READY_FOR_PROMOTION"
        ? "🟡 READY_FOR_PROMOTION"
        : entry.status === "PROMOTED"
          ? "🔵 PROMOTED"
          : entry.status === "ARCHIVED"
            ? "⚪ ARCHIVED"
            : "🟢 DEFERRED";
    return `| ${entry.firstSeen} | ${entry.claim.replace(/\|/g, "\\|")} | ${entry.hitCount} | ${entitiesStr} | ${sourcesStr} | ${statusLabel} |`;
  });

  return `${header}${rows.join("\n")}\n`;
}

export function upsertScratchpadEntry(
  entries: ScratchpadEntry[],
  item: {
    claim: string;
    entityName?: string;
    sourceId?: string;
    date?: string;
  },
): { entries: ScratchpadEntry[]; updated: ScratchpadEntry } {
  const today = item.date || new Date().toISOString().slice(0, 10);
  const normalizedClaim = item.claim.trim().toLowerCase();

  const existingIdx = entries.findIndex(
    (e) =>
      e.claim.trim().toLowerCase() === normalizedClaim ||
      (item.entityName &&
        e.relatedEntities.some((r) => r.toLowerCase() === item.entityName!.toLowerCase())),
  );

  let updated: ScratchpadEntry;
  const list = [...entries];

  if (existingIdx >= 0) {
    const prev = list[existingIdx]!;
    const newHitCount = prev.hitCount + 1;
    const newSources = [...prev.sources];
    if (item.sourceId && !newSources.includes(item.sourceId)) {
      newSources.push(item.sourceId);
    }
    const newEntities = [...prev.relatedEntities];
    if (item.entityName && !newEntities.includes(item.entityName)) {
      newEntities.push(item.entityName);
    }

    const readyForPromotion = newHitCount >= 2 && newSources.length >= 2;

    updated = {
      ...prev,
      hitCount: newHitCount,
      sources: newSources,
      relatedEntities: newEntities,
      status: readyForPromotion ? "READY_FOR_PROMOTION" : prev.status,
    };
    list[existingIdx] = updated;
  } else {
    updated = {
      firstSeen: today,
      claim: item.claim.trim(),
      hitCount: 1,
      relatedEntities: item.entityName ? [item.entityName] : [],
      sources: item.sourceId ? [item.sourceId] : [],
      status: "DEFERRED",
    };
    list.push(updated);
  }

  return { entries: list, updated };
}

export function pruneExpiredScratchpad(
  entries: ScratchpadEntry[],
  ttlDays = 14,
  currentDateOrRefTerms?: Date | Set<string> | string[],
  referencedTerms?: Set<string> | string[],
): { active: ScratchpadEntry[]; expired: ScratchpadEntry[] } {
  let currentDate = new Date();
  let refTerms = referencedTerms;
  if (currentDateOrRefTerms instanceof Date) {
    currentDate = currentDateOrRefTerms;
  } else if (currentDateOrRefTerms) {
    refTerms = currentDateOrRefTerms;
  }

  const active: ScratchpadEntry[] = [];
  const expired: ScratchpadEntry[] = [];
  const nowMs = currentDate.getTime();

  const refSet = refTerms
    ? new Set((Array.isArray(refTerms) ? refTerms : [...refTerms]).map((t) => t.toLowerCase()))
    : null;

  for (const entry of entries) {
    const entryDate = new Date(entry.firstSeen).getTime();
    const ageDays = (nowMs - entryDate) / (1000 * 60 * 60 * 24);

    let isReferenced = false;
    if (refSet) {
      const claimLower = entry.claim.toLowerCase();
      for (const term of refSet) {
        if (term.includes(claimLower) || (claimLower.length > 5 && claimLower.includes(term))) {
          isReferenced = true;
          break;
        }
        for (const entity of entry.relatedEntities) {
          if (term.includes(entity.toLowerCase())) {
            isReferenced = true;
            break;
          }
        }
        if (isReferenced) break;
      }
    }

    // If it has been sitting for more than ttlDays with only 1 hit, not promoted, and not referenced by permanent notes: prune
    if (
      ageDays >= ttlDays &&
      entry.hitCount === 1 &&
      entry.status === "DEFERRED" &&
      !isReferenced
    ) {
      expired.push({ ...entry, status: "ARCHIVED" });
    } else {
      active.push(entry);
    }
  }

  return { active, expired };
}
