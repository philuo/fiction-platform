// 抽卡系统：LLM 按世界状态生成候选卡池（角色/发展方向/伏笔/章节/道具/场景卡，稀有度 N/R/SR/SSR）
// P3.5 提案化（修 F1-F3）：角色卡输出结构化人物 → characterProposals（确认前不入册）；伏笔卡带回收时机；去重 title+description
import { chatJson } from "./jsonutil";
import { worldSummary, type Card, type Rarity, type WorldState } from "./world";

export type CardType = Card["type"];
const CARD_TYPES: CardType[] = ["角色", "发展方向", "伏笔", "章节", "道具", "场景"];

const GACHA_SYSTEM = `你是小说创作的"抽卡系统"。基于当前世界状态生成一组风格契合的卡牌，供玩家抽取后注入剧情。
卡牌类型（按指定类型生成）：
- 角色：新角色登场契机（必须同时给出 character 结构化人物：姓名/定位/特质/动机/说话风格）
- 发展方向：剧情走向（转折/危机/支线/高潮/结局推进）
- 伏笔：悬念埋设（内容 + 建议回收时机 dueHint）
- 章节：本节推进要点（场景/节拍/视角切换/关键对话）
- 道具：关键物品（来历/用途/伏线）
- 场景：新地点（氛围/秘密/与主线关联）
稀有度：N 普通 / R 稀有 / SR 史诗 / SSR 传说（SSR 少而精）。
每张卡的 effect 必须是可直接注入写作指令的一句话。
输出必须是合法 JSON（不要 markdown 围栏）：{"cards":[{"type":"角色","rarity":"SR","title":"…","description":"…","effect":"…","character":{"name":"姓名","role":"定位","traits":["特质"],"motivation":"动机","voice":"说话风格"},"dueHint":"伏笔卡专用：建议回收时机"}]}
要求：卡牌与世界观契合、有戏剧性、避免陈词滥调；最多 5 张；至少包含 1 张伏笔卡或角色卡。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

export async function generateCardPool(world: WorldState, opts: { count?: number; types?: CardType[] } = {}): Promise<Card[]> {
  const count = Math.max(1, Math.min(opts.count ?? 4, 6));
  const types = opts.types?.length ? opts.types : CARD_TYPES;
  const userMsg = [worldSummary(world), `\n请为下一章生成 ${count} 张候选卡，类型限定为：${types.join("/")}（只输出 JSON）。`].join("\n");
  const out = await chatJson<{ cards?: { type?: string; rarity?: string; title?: string; description?: string; effect?: string; dueHint?: string; character?: { name?: string; role?: string; traits?: string[]; motivation?: string; voice?: string } }[] }>(
    [
      { role: "system", content: GACHA_SYSTEM },
      { role: "user", content: userMsg },
    ],
    {
      temperature: 1.0,
      maxTokens: 60000,
      schema: {
        type: "object",
        required: ["cards"],
        properties: {
          cards: {
            type: "array",
            items: {
              type: "object", required: ["type", "rarity", "title"],
              properties: {
                type: { type: "string", enum: ["角色", "发展方向", "伏笔", "章节", "道具", "场景"] },
                rarity: { type: "string", enum: ["N", "R", "SR", "SSR"] },
                title: { type: "string" }, description: { type: "string" }, effect: { type: "string" }, dueHint: { type: "string" },
                character: { type: "object", required: ["name"], properties: { name: { type: "string" }, role: { type: "string" }, traits: { type: "array", items: { type: "string" } }, motivation: { type: "string" }, voice: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  );
  const rarities: Rarity[] = ["N", "R", "SR", "SSR"];
  return (Array.isArray(out.cards) ? out.cards : [])
    .filter((c) => c && c.title)
    .slice(0, count)
    .map((c, i) => ({
      id: `card-${Date.now().toString(36)}-${i}`,
      type: CARD_TYPES.includes(c.type as CardType) ? (c.type as CardType) : "发展方向",
      rarity: rarities.includes(c.rarity as Rarity) ? (c.rarity as Rarity) : "R",
      title: String(c.title).trim(),
      description: String(c.description ?? "").trim(),
      effect: String(c.effect ?? "").trim(),
      dueHint: typeof c.dueHint === "string" ? c.dueHint.trim() || undefined : undefined,
      character:
        c.character?.name
          ? {
              name: String(c.character.name).trim().slice(0, 12),
              role: String(c.character.role ?? "配角").trim().slice(0, 20),
              traits: (Array.isArray(c.character.traits) ? c.character.traits : []).map(String).slice(0, 5),
              motivation: String(c.character.motivation ?? "").trim().slice(0, 120),
              voice: c.character.voice ? String(c.character.voice).trim().slice(0, 80) : undefined,
            }
          : undefined,
    }));
}

/** 自动模式：无用户操作时自动抽取（优先稀有度 + 优先伏笔/角色卡） */
export function autoPick(pool: Card[], max = 2): Card[] {
  const rank = { N: 0, R: 1, SR: 2, SSR: 3 } as const;
  const prefer = (c: Card) => (c.type === "伏笔" || c.type === "角色" ? 1 : 0);
  const sorted = [...pool].sort((a, b) => rank[b.rarity] - rank[a.rarity] || prefer(b) - prefer(a));
  return sorted.slice(0, max);
}

/** 卡牌去重键（修 F3：仅比 title 易漏；title+description 归一化比较） */
function cardKey(c: Card): string {
  return `${c.title}|${c.description}`.replace(/\s+/g, "");
}

/** 应用抽中的卡：生成注入指令 + 伏笔卡入账（带回收时机）+ 角色卡入提案区（修 F1/F2） */
export function applyCards(world: WorldState, picked: Card[]): { instructions: string[]; applied: Card[] } {
  const instructions: string[] = [];
  const applied: Card[] = [];
  for (const c of picked) {
    if (world.cards.some((x) => cardKey(x) === cardKey(c))) continue; // 防重复
    if (c.type === "伏笔") {
      world.foreshadowing.push({
        id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        text: `${c.title}：${c.description || c.effect}`,
        plantedAt: world.nextChapter,
        status: "planted",
        note: `抽卡预登记（待埋设：将随第${world.nextChapter}章正文落地）`,
        dueHint: c.dueHint,
      });
      instructions.push(`[伏笔卡已生效] ${c.effect}`);
    } else if (c.type === "角色") {
      // 角色卡 → 提案区（pending），确认前不入册、不写入正文（修 F1/F2）
      const name = c.character?.name || c.title;
      const pend = world.characterProposals ?? [];
      if (!world.characters.some((x) => x.name === name) && !pend.some((p) => p.name === name && p.status === "pending")) {
        pend.push({
          id: `cp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
          name,
          role: c.character?.role ?? "配角",
          traits: c.character?.traits ?? [],
          motivation: c.character?.motivation ?? c.description.slice(0, 60),
          voice: c.character?.voice,
          source: "gacha",
          status: "pending",
        });
        world.characterProposals = pend;
      }
      instructions.push(`[抽中${c.rarity}角色卡《${c.title}》] ${c.effect}（角色「${name}」已入待确认提案，确认后方可正式登场）`);
    } else {
      instructions.push(`[抽中${c.rarity}${c.type}卡《${c.title}》] ${c.effect}`);
    }
    world.cards.push(c);
    applied.push(c);
  }
  return { instructions, applied };
}
