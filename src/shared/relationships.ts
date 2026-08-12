export type RelationshipSubgraph = {
  focus?: string;
  nodes: { id: string; name: string; role: string }[];
  edges: { from: string; to: string; label: string }[];
};

type RelationshipCharacter = { id: string; name: string; role: string; relations?: Record<string, string> };

function findCharacter(characters: RelationshipCharacter[], value: string): RelationshipCharacter | undefined {
  const query = String(value ?? "").trim();
  if (!query) return undefined;
  return characters.find((item) => item.id === query || item.name === query)
    ?? characters.find((item) => query.includes(item.name) || item.name.includes(query));
}

/** Normalize legacy label->name and current name->label relationships, dedupe the
 * bidirectional representation, then optionally retain the focus node and one hop. */
export function extractRelationshipSubgraph(characters: RelationshipCharacter[], focusQuery?: string): RelationshipSubgraph | null {
  const focus = focusQuery ? findCharacter(characters, focusQuery) : undefined;
  if (focusQuery && !focus) return null;
  const edges: RelationshipSubgraph["edges"] = [];
  const seen = new Set<string>();
  for (const source of characters) {
    for (const [rawTarget, rawLabel] of Object.entries(source.relations ?? {})) {
      let target = findCharacter(characters, rawTarget);
      let label = String(rawLabel ?? "").trim();
      if (!target) {
        target = findCharacter(characters, label);
        label = rawTarget;
      }
      if (!target || target.id === source.id) continue;
      const key = [source.id, target.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: source.id, to: target.id, label: label || "关系" });
    }
  }
  const scopedEdges = focus ? edges.filter((edge) => edge.from === focus.id || edge.to === focus.id) : edges;
  const nodeIds = focus
    ? new Set([focus.id, ...scopedEdges.flatMap((edge) => [edge.from, edge.to])])
    : new Set(scopedEdges.flatMap((edge) => [edge.from, edge.to]));
  return {
    ...(focus ? { focus: focus.id } : {}),
    nodes: characters.filter((item) => nodeIds.has(item.id)).map(({ id, name, role }) => ({ id, name, role })),
    edges: scopedEdges,
  };
}
