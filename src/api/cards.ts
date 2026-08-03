// 抽卡系统：LLM 按世界状态生成候选卡池（角色/发展方向/伏笔/章节/道具/场景卡，稀有度 N/R/SR/SSR）
import { chatJson } from "./jsonutil";
import { worldSummary, type Card, type Rarity, type WorldState } from "./world";

export type CardType = Card["type"];
const CARD_TYPES: CardType[] = ["角色", "发展方向", "伏笔", "章节", "道具", "场景"];

const GACHA_SYSTEM = `你是小说创作的"抽卡系统"。基于当前世界状态生成一组风格契合的卡牌，供玩家抽取后注入剧情。
卡牌类型（按指定类型生成）：
- 角色：新角色登场契机（身份/性格/与主角关系/登场时机）
- 发展方向：剧情走向（转折/危机/支线/高潮/结局推进）
- 伏笔：悬念埋设（内容 + 建议回收时机）
- 章节：本节推进要点（场景/节拍/视角切换/关键对话）
- 道具：关键物品（来历/用途/伏线）
- 场景：新地点（氛围/秘密/与主线关联）
稀有度：N 普通 / R 稀有 / SR 史诗 / SSR 传说（SSR 少而精）。
每张卡的 effect 必须是可直接注入写作指令的一句话。
输出必须是合法 JSON（不要 markdown 围栏）：{"cards":[{"type":"发展方向","rarity":"SR","title":"雨夜密信","description":"…","effect":"…"}]}
要求：卡牌与世界观契合、有戏剧性、避免陈词滥调；最多 5 张；至少包含 1 张伏笔卡或角色卡。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

export async function generateCardPool(world: WorldState, opts: { count?: number; types?: CardType[] } = {}): Promise<Card[]> {
  const count = Math.max(1, Math.min(opts.count ?? 4, 6));
  const types = opts.types?.length ? opts.types : CARD_TYPES;
  const userMsg = [worldSummary(world), `\n请为下一节生成 ${count} 张候选卡，类型限定为：${types.join("/")}（只输出 JSON）。`].join("\n");
  const out = await chatJson<{ cards?: { type?: string; rarity?: string; title?: string; description?: string; effect?: string }[] }>(
    [
      { role: "system", content: GACHA_SYSTEM },
      { role: "user", content: userMsg },
    ],
    { temperature: 1.0, maxTokens: 1536 },
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
    }));
}

/** 自动模式：无用户操作时自动抽取（优先稀有度 + 优先伏笔/角色卡） */
export function autoPick(pool: Card[], max = 2): Card[] {
  const rank = { N: 0, R: 1, SR: 2, SSR: 3 } as const;
  const prefer = (c: Card) => (c.type === "伏笔" || c.type === "角色" ? 1 : 0);
  const sorted = [...pool].sort((a, b) => rank[b.rarity] - rank[a.rarity] || prefer(b) - prefer(a));
  return sorted.slice(0, max);
}

/** 应用抽中的卡：生成注入指令 + 伏笔卡直接登记账本 */
export function applyCards(world: WorldState, picked: Card[]): { instructions: string[]; applied: Card[] } {
  const instructions: string[] = [];
  const applied: Card[] = [];
  for (const c of picked) {
    if (world.cards.some((x) => x.title === c.title)) continue; // 防重复
    if (c.type === "伏笔") {
      world.foreshadowing.push({
        id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        text: `${c.title}：${c.description || c.effect}`,
        plantedAt: world.nextChapter,
        status: "planted",
        note: "由抽卡埋设",
      });
      instructions.push(`[伏笔卡已生效] ${c.effect}`);
    } else if (c.type === "角色") {
      // 角色卡：登记待登场 + 注入登场指令（优先从「」提取名字，兜底取首个 2-4 字中文词）
      const quoted = c.description.match(/「([^」]{2,4})」/);
      const plain = c.description.match(/[\u4e00-\u9fa5]{2,4}/);
      const name = quoted ? quoted[1] : plain ? plain[0] : "新角色";
      if (!world.characters.some((x) => x.name === name)) {
        world.characters.push({
          id: `c${Date.now().toString(36)}`,
          name,
          role: "待登场",
          traits: [],
          motivation: c.description.slice(0, 60),
          status: "尚未登场（抽卡获得）",
          relations: {},
          introducedAt: world.nextChapter,
        });
      }
      instructions.push(`[抽中${c.rarity}角色卡《${c.title}》] ${c.effect}`);
    } else {
      instructions.push(`[抽中${c.rarity}${c.type}卡《${c.title}》] ${c.effect}`);
    }
    world.cards.push(c);
    applied.push(c);
  }
  return { instructions, applied };
}
