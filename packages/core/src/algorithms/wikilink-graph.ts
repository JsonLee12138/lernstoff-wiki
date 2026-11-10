export type LogicalRelation = "supports" | "contradicts" | "extends" | "qualifies";

export interface OutboundEdge {
  target: string;
  relation?: LogicalRelation;
}

export interface GraphNode {
  id: string; // usually note slug or note title
  title: string;
  outbound: OutboundEdge[];
}

export interface WikilinkGraph {
  nodes: string[];
  edges: Map<string, string[]>; // directed: source -> targets
  undirectedEdges: Map<string, string[]>; // undirected: node -> neighbors
  inDegrees: Map<string, number>;
  outDegrees: Map<string, number>;
  relations: Map<string, OutboundEdge[]>;
}

const WIKILINK_RE = /!?\[\[([^\]\n|#]+)(?:[|#][^\]\n]*)?\]\]/g;
const TYPED_RELATION_RE =
  /!?\[\[(supports|contradicts|extends|qualifies)::([^\]\n|#]+)(?:[|#][^\]\n]*)?\]\]/gi;

export function normalizeNodeId(raw: string): string {
  return raw.trim().replace(/\.md$/i, "").toLowerCase();
}

/**
 * Parse Markdown body and frontmatter to extract outbound wikilinks and typed relations.
 */
export function extractNoteLinks(content: string): OutboundEdge[] {
  const edges: OutboundEdge[] = [];
  const seen = new Set<string>();

  // 1. Check for typed inline relations [[supports::target]]
  let typedMatch: RegExpExecArray | null;
  const typedRe = new RegExp(TYPED_RELATION_RE.source, "gi");
  while ((typedMatch = typedRe.exec(content)) !== null) {
    const relation = typedMatch[1]!.toLowerCase() as LogicalRelation;
    const target = normalizeNodeId(typedMatch[2]!);
    if (target && !seen.has(target)) {
      seen.add(target);
      edges.push({ target, relation });
    }
  }

  // 2. Check standard wikilinks [[target]]
  let linkMatch: RegExpExecArray | null;
  const linkRe = new RegExp(WIKILINK_RE.source, "g");
  while ((linkMatch = linkRe.exec(content)) !== null) {
    const rawTarget = linkMatch[1]!.trim();
    // Skip if it was already matched as typed relation
    if (rawTarget.includes("::")) continue;
    const target = normalizeNodeId(rawTarget);
    if (target && !seen.has(target)) {
      seen.add(target);
      edges.push({ target });
    }
  }

  return edges;
}

export function buildWikilinkGraph(nodesData: { id: string; content: string }[]): WikilinkGraph {
  const nodes: string[] = [];
  const edges = new Map<string, string[]>();
  const undirectedEdges = new Map<string, string[]>();
  const inDegrees = new Map<string, number>();
  const outDegrees = new Map<string, number>();
  const relations = new Map<string, OutboundEdge[]>();

  // Initialize all nodes
  for (const item of nodesData) {
    const id = normalizeNodeId(item.id);
    if (!nodes.includes(id)) {
      nodes.push(id);
    }
    edges.set(id, []);
    undirectedEdges.set(id, []);
    inDegrees.set(id, 0);
    outDegrees.set(id, 0);
    relations.set(id, []);
  }

  // Populate edges
  for (const item of nodesData) {
    const source = normalizeNodeId(item.id);
    const parsedEdges = extractNoteLinks(item.content);
    relations.set(source, parsedEdges);

    const validTargets: string[] = [];
    for (const edge of parsedEdges) {
      const target = edge.target;
      // Only include targets that are present in the graph nodes
      if (edges.has(target) && target !== source) {
        validTargets.push(target);

        // Directed edge: source -> target
        inDegrees.set(target, (inDegrees.get(target) ?? 0) + 1);

        // Undirected edge
        const sourceUndirected = undirectedEdges.get(source)!;
        if (!sourceUndirected.includes(target)) sourceUndirected.push(target);
        const targetUndirected = undirectedEdges.get(target)!;
        if (!targetUndirected.includes(source)) targetUndirected.push(source);
      }
    }

    edges.set(source, validTargets);
    outDegrees.set(source, validTargets.length);
  }

  return {
    nodes,
    edges,
    undirectedEdges,
    inDegrees,
    outDegrees,
    relations,
  };
}
