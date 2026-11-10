import type { WikilinkGraph } from "./wikilink-graph.js";

export interface PPROptions {
  numWalks?: number;
  maxSteps?: number;
  damping?: number;
  topK?: number;
  rng?: () => number;
}

export interface PPRHit {
  nodeId: string;
  score: number;
}

/**
 * Deterministic PRNG: mulberry32 over FNV-1a hash of a seed string.
 */
export function makeSeededRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Monte Carlo Personalized PageRank over the undirected graph edges.
 * Simulates random walks starting from seed nodes.
 * Complexity: O(seeds.length * numWalks * maxSteps)
 */
export function personalizedPageRank(
  graph: WikilinkGraph,
  seeds: string | string[],
  options: PPROptions = {},
): PPRHit[] {
  const seedList = (Array.isArray(seeds) ? seeds : [seeds])
    .map((s) => s.toLowerCase().trim())
    .filter((s) => graph.nodes.includes(s));

  if (seedList.length === 0) {
    return [];
  }

  const numWalks = options.numWalks ?? 200;
  const maxSteps = options.maxSteps ?? 6;
  const damping = options.damping ?? 0.25;
  const topK = options.topK ?? 3;
  const rng = options.rng ?? makeSeededRng(seedList.join(","));

  const visitCounts = new Map<string, number>();
  for (const s of seedList) {
    visitCounts.set(s, numWalks);
  }

  for (const seed of seedList) {
    for (let walk = 0; walk < numWalks; walk++) {
      let current = seed;
      for (let step = 0; step < maxSteps; step++) {
        // Teleport back to seed with probability `damping`
        if (rng() < damping) {
          current = seed;
          visitCounts.set(current, (visitCounts.get(current) ?? 0) + 1);
          continue;
        }

        // Otherwise follow a random adjacent edge in undirectedEdges
        const outgoing = graph.undirectedEdges.get(current);
        if (!outgoing || outgoing.length === 0) {
          // Dead end teleport back to seed
          current = seed;
          visitCounts.set(current, (visitCounts.get(current) ?? 0) + 1);
          continue;
        }

        const nextIndex = Math.floor(rng() * outgoing.length);
        current = outgoing[nextIndex]!;
        visitCounts.set(current, (visitCounts.get(current) ?? 0) + 1);
      }
    }
  }

  let totalVisits = 0;
  for (const count of visitCounts.values()) {
    totalVisits += count;
  }

  if (totalVisits === 0) return [];

  // Rank nodes outside the original seed list by visit probability
  const seedSet = new Set(seedList);
  const scoredHits: PPRHit[] = [];

  for (const [nodeId, count] of visitCounts.entries()) {
    if (!seedSet.has(nodeId)) {
      scoredHits.push({
        nodeId,
        score: Math.round((count / totalVisits) * 10000) / 10000,
      });
    }
  }

  scoredHits.sort((a, b) => b.score - a.score);
  return scoredHits.slice(0, topK);
}
