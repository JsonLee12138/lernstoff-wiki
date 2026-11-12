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
  backlinks: Map<string, Array<{ source: string; relation?: LogicalRelation }>>;
}

const WIKILINK_RE = /!?\[\[([^\]\n|#]+)(?:[|#][^\]\n]*)?\]\]/g;
const TYPED_INLINE_RELATION_RE =
  /!?\[\[(supports|contradicts|extends|qualifies)::([^\]\n|#]+)(?:[|#][^\]\n]*)?\]\]/gi;
const TYPED_LIST_RELATION_RE =
  /(?:^|[\r\n])\s*[-*+]?\s*(supports|contradicts|extends|qualifies)\s*:?\s*!?\[\[([^\]\n|#]+)(?:[|#][^\]\n]*)?\]\]/gim;

export function normalizeNodeId(raw: string): string {
  return raw.trim().replace(/\.md$/i, "").toLowerCase();
}

/**
 * Parse Markdown body and frontmatter to extract outbound wikilinks and typed relations.
 */
export function extractNoteLinks(content: string): OutboundEdge[] {
  const edges: OutboundEdge[] = [];
  const edgeIndexByTarget = new Map<string, number>();

  // 1. Check for list/line prefix typed relations (e.g. - supports [[target]])
  let listMatch: RegExpExecArray | null;
  const listRe = new RegExp(TYPED_LIST_RELATION_RE.source, "gim");
  while ((listMatch = listRe.exec(content)) !== null) {
    const relation = listMatch[1]!.toLowerCase() as LogicalRelation;
    const target = normalizeNodeId(listMatch[2]!);
    if (target) {
      if (!edgeIndexByTarget.has(target)) {
        edgeIndexByTarget.set(target, edges.length);
        edges.push({ target, relation });
      } else {
        const idx = edgeIndexByTarget.get(target)!;
        edges[idx]!.relation = relation;
      }
    }
  }

  // 2. Check for typed inline relations [[supports::target]]
  let typedMatch: RegExpExecArray | null;
  const typedRe = new RegExp(TYPED_INLINE_RELATION_RE.source, "gi");
  while ((typedMatch = typedRe.exec(content)) !== null) {
    const relation = typedMatch[1]!.toLowerCase() as LogicalRelation;
    const target = normalizeNodeId(typedMatch[2]!);
    if (target) {
      if (!edgeIndexByTarget.has(target)) {
        edgeIndexByTarget.set(target, edges.length);
        edges.push({ target, relation });
      } else {
        const idx = edgeIndexByTarget.get(target)!;
        edges[idx]!.relation = relation;
      }
    }
  }

  // 3. Check standard wikilinks [[target]]
  let linkMatch: RegExpExecArray | null;
  const linkRe = new RegExp(WIKILINK_RE.source, "g");
  while ((linkMatch = linkRe.exec(content)) !== null) {
    const rawTarget = linkMatch[1]!.trim();
    if (rawTarget.includes("::")) continue;
    const target = normalizeNodeId(rawTarget);
    if (target && !edgeIndexByTarget.has(target)) {
      edgeIndexByTarget.set(target, edges.length);
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
  const backlinks = new Map<string, Array<{ source: string; relation?: LogicalRelation }>>();

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
    backlinks.set(id, []);
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

        // Backlink
        const targetBacklinks = backlinks.get(target);
        if (targetBacklinks && !targetBacklinks.some((b) => b.source === source)) {
          targetBacklinks.push({ source, relation: edge.relation });
        }

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
    backlinks,
  };
}
