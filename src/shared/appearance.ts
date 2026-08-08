// 角色出场判定与登场章节显示 —— 前端（左栏脉络/右栏人物）与服务端（chronicler 重算登场）
// 共用的唯一实现，保证「本章出场角色」与角色卡「登场章节」统计永远同源、口径一致。
// 双轨：已结算章节用 LLM 记账语义名单 chapterSummaries[].appeared（被提及或出场，随结算/编辑/回滚自动刷新）；
//       名单为空（结算失败降级 / 回滚后旧名单被清空 / 判定无人出场）→ 回退实时正文文本匹配。
// 注意：名单为空时不得绕过文本兜底，否则章节内容变更/版本切换后会停留旧账本（修「脉络未更新」）。
import type { Character, WorldState } from "../api/world";
export { formatChapterRange } from "./chapterRange";

/** 角色名别名归一：去空白 + 去「阿/小/老」前缀（与 chronicler.normCharName 同款实现，
 * 此处为唯一实现，chronicler 与前端组件均从这里引用，避免口径漂移） */
export function normCharName(name: string): string {
  return name.replace(/\s+/g, "").replace(/^(阿|小|老)/, "");
}

/** 角色在本章正文中被提及或出场（实时全文匹配：出场有台词/行动必含名字，旁白提及也算；
 * 别名归一宽松匹配处理「小飞侠→飞侠」类前缀变体；单字归一不做宽松匹配以免误伤） */
export function appearsInChapter(c: Character, text: string): boolean {
  if (!c.name) return false;
  if (text.includes(c.name)) return true;
  const norm = normCharName(c.name);
  return norm.length >= 2 && norm !== c.name && text.includes(norm);
}

/** 某章结算名单是否按归一匹配到该角色（与 appearedChars 的 LLM 名单分支同款） */
function llmNamesContain(llmNames: string[], c: Character): boolean {
  const normC = normCharName(c.name);
  return llmNames.some((n) => n === c.name || (n !== c.name && normCharName(n) === normC && normCharName(n).length >= 2));
}

/** 单章双轨判定：角色 c 是否在第 chapterIndex 章出场/登场。
 * 与 appearedChars 完全同源，recomputeAppearedIn 与「本章出场角色」因此保持一致。 */
export function appearedInChapter(w: WorldState, c: Character, chapterIndex: number): boolean {
  const summary = (w.chapterSummaries ?? []).find((s) => s.index === chapterIndex) ?? null;
  const llmNames = summary?.appeared ?? [];
  const useLlm = summary != null && llmNames.length > 0;
  if (useLlm) return llmNamesContain(llmNames, c);
  const chapter = w.chapters.find((ch) => ch.index === chapterIndex);
  return !!chapter && appearsInChapter(c, chapter.text ?? "");
}

/** 本章出场角色（双轨判定，返回名册角色数组；chapterIdx < 0 或章节不存在（已删除/悬空）返回空） */
export function appearedChars(world: WorldState, chapterIdx: number): Character[] {
  if (chapterIdx < 0) return [];
  const chapter = world.chapters.find((c) => c.index === chapterIdx);
  if (!chapter) return []; // 章节不存在（删除后残留旧账本条目）→ 无角色可展示
  const chapterText = chapter.text ?? "";
  const summary = (world.chapterSummaries ?? []).find((s) => s.index === chapterIdx) ?? null;
  const llmNames = summary?.appeared ?? [];
  // 仅当 LLM 记账成功且给出了出场名单时采信语义名单；名单为空（结算失败降级 / 回滚后清单清空 / 判定无人提及）
  // 一律回退实时文本匹配，保证章节内容变更、版本切换、删除章节后脉络与正文一致
  const useLlm = summary != null && llmNames.length > 0;
  if (!useLlm) return world.characters.filter((c) => appearsInChapter(c, chapterText));
  return world.characters.filter((c) => llmNamesContain(llmNames, c));
}
