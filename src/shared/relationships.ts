import { normCharName } from "./appearance";

export type RelationshipSubgraph = {
  focus?: string;
  nodes: { id: string; name: string; role: string }[];
  edges: { from: string; to: string; label: string }[];
};

type RelationshipCharacter = { id: string; name: string; role: string; relations?: Record<string, string> };

/** 关系目标键的介词前缀（LLM 常见「与伊芙琳」「同马库斯」等自由格式）：
 * 匹配时剥离后再比对角色名，避免关系键写成「与XX」导致图中无连线 */
const REL_PREFIX_RE = /^(与|同|和|对|跟)/;

/** 在角色列表中定位关系目标：支持 精确 id/name → 归一别名 → 介词前缀剥离（「与伊芙琳」→「伊芙琳」）→ 包含匹配。
 * 返回真实角色；匹配不到返回 undefined（调用方丢弃脏键）。 */
export function findRelationshipTarget(characters: RelationshipCharacter[], value: string): RelationshipCharacter | undefined {
  const query = String(value ?? "").trim();
  if (!query) return undefined;
  const exact = characters.find((item) => item.id === query || item.name === query);
  if (exact) return exact;
  // 归一别名匹配（去「阿/小/老」前缀，如「小飞侠→飞侠」）
  const qNorm = normCharName(query);
  if (qNorm && qNorm !== query) {
    const byNorm = characters.find((item) => normCharName(item.name) === qNorm && qNorm.length >= 2);
    if (byNorm) return byNorm;
  }
  // 介词前缀剥离：「与伊芙琳」→「伊芙琳」；仅当剥离后能匹配到角色时才采用，避免误伤以这些字开头的真实姓名
  const stripped = query.replace(REL_PREFIX_RE, "");
  if (stripped && stripped !== query) {
    const byStripped = characters.find((item) => item.id === stripped || item.name === stripped || normCharName(item.name) === normCharName(stripped));
    if (byStripped) return byStripped;
    const byStrippedInclude = characters.find((item) => stripped.includes(item.name) || item.name.includes(stripped));
    if (byStrippedInclude) return byStrippedInclude;
  }
  return characters.find((item) => query.includes(item.name) || item.name.includes(query));
}

/** Normalize legacy label->name and current name->label relationships, dedupe the
 * bidirectional representation, then optionally retain the focus node and one hop. */
export function extractRelationshipSubgraph(characters: RelationshipCharacter[], focusQuery?: string): RelationshipSubgraph | null {
  const focus = focusQuery ? findRelationshipTarget(characters, focusQuery) : undefined;
  if (focusQuery && !focus) return null;
  const edges: RelationshipSubgraph["edges"] = [];
  const seen = new Set<string>();
  for (const source of characters) {
    for (const [rawTarget, rawLabel] of Object.entries(source.relations ?? {})) {
      let target = findRelationshipTarget(characters, rawTarget);
      let label = String(rawLabel ?? "").trim();
      if (!target) {
        target = findRelationshipTarget(characters, label);
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
