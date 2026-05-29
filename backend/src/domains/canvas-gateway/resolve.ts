// -----------------------------------------------------------------------------
// Node references — the `+<nodeId>` import primitive.
//
// A whitespace-prefixed `+<nodeId>` token inside a node's content imports
// that node. Resolution is PULL: it happens only when someone reads the
// node (canvas-gateway GET, resolve on by default), never on write.
// There is no propagation, no NATS fan-out, no subscription state — an
// agent "subscribes" by putting `+refs` in a node it chooses to read.
//
// This module is PURE: it never touches the database. The caller fetches
// every node in the arrangement once (one query), hands us an id→content
// map, and we walk it in memory. That makes resolution trivially unit-
// testable and keeps the I/O boundary in the controller.
//
// Unresolved references — a missing node, a cycle, or a depth-cap hit —
// are simply SKIPPED: their `+id` token is left verbatim in the output.
// This doubles as the escape hatch: a `+foo` that isn't a real node id
// just stays as literal text. No "[not found]" clutter.
//
// `+` must be preceded by start-of-string or whitespace so "C++" and
// "1+2" aren't mistaken for references. The id charset matches cuid plus
// the `m_<hex>` ids the gateway mints.
// -----------------------------------------------------------------------------

// Group 1 = the leading boundary (kept on replace), group 2 = the node id.
const REF_PATTERN = /(^|\s)\+([A-Za-z0-9_-]+)/g;

// Cycles are caught by the per-path visited set; this is the belt-and-
// suspenders cap for very deep (non-cyclic) chains.
const MAX_DEPTH = 8;

// A resolved node and ONLY its successfully-resolved children. A ref that
// couldn't be resolved (missing / cycle / too deep) is absent from `refs`
// — the formatter then leaves its token literal.
export type ResolvedNode = {
  content: string;
  refs: Map<string, ResolvedNode>;
};

// Pure: pull referenced node ids out of a content string — first-
// appearance order, de-duplicated.
export function parseRefs(content: string): string[] {
  const ids = new Set<string>();
  for (const m of content.matchAll(REF_PATTERN)) {
    if (m[2]) ids.add(m[2]);
  }
  return [...ids];
}

// Pure forward-walk over an in-memory id→content map. `visited` is per-
// PATH (copied at each branch): a diamond (A→B→D, A→C→D) resolves D twice
// rather than being mislabelled a cycle; only a true back-edge (A→B→A) is
// a cycle. Anything not in `nodes` (missing, or in another arrangement —
// the map only holds this arrangement) is skipped, as are cycles and
// depth-cap hits.
export function resolveNode(
  nodes: Map<string, string>,
  nodeId: string,
  visited: Set<string>,
  depth: number,
): ResolvedNode | null {
  const content = nodes.get(nodeId);
  if (content === undefined) return null;

  const refs = new Map<string, ResolvedNode>();
  if (depth < MAX_DEPTH) {
    for (const refId of parseRefs(content)) {
      if (visited.has(refId)) continue; // cycle → skip (token stays literal)
      const child = resolveNode(nodes, refId, new Set(visited).add(nodeId), depth + 1);
      if (child) refs.set(refId, child); // missing → skip
    }
  }
  return { content, refs };
}

// Pure: flatten a ResolvedNode into the assembled text an agent reads.
// Each `+ref` token whose node resolved is replaced IN PLACE with a
// delimited block; every other `+token` is left exactly as written.
export function formatResolved(node: ResolvedNode): string {
  return node.content.replace(REF_PATTERN, (whole, lead: string, refId: string) => {
    const child = node.refs.get(refId);
    if (!child) return whole; // unresolved → literal (skip)
    const inner = formatResolved(child);
    const bar = '─'.repeat(Math.max(4, 48 - refId.length));
    // Trailing \n so content following a mid-string ref starts on its own
    // line instead of clinging to the closing border.
    return `${lead}\n╭─ +${refId} ${bar}\n${inner}\n╰${'─'.repeat(50)}\n`;
  });
}

// Convenience for callers that already hold the node map: resolve a root
// id and return the assembled string (or null if the root isn't present).
export function resolveFromMap(nodes: Map<string, string>, rootId: string): string | null {
  const tree = resolveNode(nodes, rootId, new Set(), 0);
  return tree ? formatResolved(tree) : null;
}
