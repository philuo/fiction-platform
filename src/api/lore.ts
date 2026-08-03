// M3 世界书（Lorebook）：自动生成 + 匹配注入（参考 SillyTavern 世界书设计）
import type { LoreEntry, WorldState } from "./world";

/** 从世界状态自动生成设定条目（人物/时代/地点/规则） */
export function buildAutoLore(w: WorldState): LoreEntry[] {
  const entries: LoreEntry[] = [];
  const push = (keywords: string[], content: string) => {
    if (!content.trim()) return;
    entries.push({
      id: `lore-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
      keywords: keywords.filter(Boolean).slice(0, 4),
      content: content.trim().slice(0, 200),
      enabled: true,
      auto: true,
    });
  };
  if (w.setting.time) push([w.setting.time.slice(0, 8)], `时代：${w.setting.time}`);
  if (w.setting.place) push([w.setting.place.slice(0, 8)], `地点：${w.setting.place}`);
  if (w.setting.tone) push([w.setting.tone.slice(0, 6)], `文风基调：${w.setting.tone}`);
  w.setting.rules.forEach((r) => push([r.slice(0, 8)], `世界规则：${r}`));
  w.characters.forEach((c) =>
    push(
      [c.name],
      `${c.name}（${c.role}）：特质 ${c.traits.join("、")}。动机：${c.motivation}。现状：${c.status}。`,
    ),
  );
  return entries;
}

/** 合并自动条目与手动条目：手动条目保留，自动条目重建 */
export function mergeLore(w: WorldState, auto: LoreEntry[]): LoreEntry[] {
  const manual = (w.lore ?? []).filter((e) => !e.auto);
  return [...auto, ...manual];
}

/** 注入用条目（enabled + 上限 15 条） */
export function activeLore(w: WorldState): LoreEntry[] {
  return (w.lore ?? []).filter((e) => e.enabled).slice(0, 15);
}

/** 世界书注入文本（writer 上下文用） */
export function loreBlock(w: WorldState): string {
  const list = activeLore(w);
  if (!list.length) return "";
  return (
    "\n[世界书·设定条目] 以下为必须遵循的世界设定（写作时不得违背）：\n" +
    list.map((e) => `- ${e.keywords.join("/")}：${e.content}`).join("\n")
  );
}
