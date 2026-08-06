// 风格与去 AI 味（P2，修 C3）：疲劳词表 + 禁用句式（确定性检测，零 LLM）+ 风格指纹提取 + 字数守卫
import { chat } from "./agnes";
import type { GenProfile } from "./world";

/** 疲劳词表（AI 高频套词，参考 inkos / ainovel-cli 反 AI 味基线） */
export const TIRED_WORDS: string[] = [
  "只见", "不禁", "缓缓", "仿佛", "似乎", "顿时", "瞬间", "赫然",
  "眼中闪过一丝", "嘴角勾起", "嘴角微微上扬", "空气仿佛凝固", "空气凝固",
  "命运的齿轮", "瞳孔骤缩", "瞳孔一缩", "心头一震", "心中一动", "眸光微闪",
  "一抹", "一丝不易察觉", "低沉的声音响起", "冰冷的声音", "淡淡地说",
  "深吸一口气", "长舒一口气", "嘴角勾起一抹", "眼中精光", "气势如潮水",
  "时间仿佛静止", "整个世界都安静了", "如同潮水般", "排山倒海", "无法言喻",
  "难以言表", "不言而喻", "毋庸置疑", "由此可见", "值得一提的是",
];

/** 禁用句式（总结式收尾/说教/模板转折，正则） */
export const BANNED_PATTERNS: RegExp[] = [
  /总之[，,]/,
  /就这样[，,].{0,20}(结束|过去|落幕)/,
  /也许这就是.{0,15}(吧|了)[。.]?$/,
  /新的篇章.{0,10}(展开|开始)/,
  /故事还在继续/,
  /这一切[，,]才刚刚开始/,
  /命运的齿轮开始转动/,
  /没有人知道[，,].{0,20}(将会|会)/,
  /而这一切的背后/,
];

/** 确定性 AI 味检测：返回命中项列表（≥3 项时由管线生成 aiTone finding / 触发自愈润色） */
export function detectAiTone(text: string): string[] {
  const hits: string[] = [];
  for (const w of TIRED_WORDS) {
    // 同一词计一次（高频重复另由 prose 维度审）
    if (text.includes(w)) hits.push(w);
  }
  for (const re of BANNED_PATTERNS) {
    if (re.test(text)) hits.push(re.source.slice(0, 12));
  }
  return hits;
}

/** 字数守卫：目标字数 ±40% 治理区间（inkos 式：不承诺精确命中，超限走纠偏） */
export function wordCountGuard(text: string, g: GenProfile): "ok" | "short" | "long" {
  const target = g.targetChapterWords ?? Math.round(((g.minWords ?? 800) + (g.maxWords ?? 1600)) / 2);
  const lo = target * 0.6;
  const hi = target * 1.4;
  const len = text.length;
  if (len < lo) return "short";
  if (len > hi) return "long";
  return "ok";
}

const FINGERPRINT_SYSTEM = `你是文风分析师。分析给定的小说样章，提取可指导模仿写作的风格指纹。
输出 ≤400 字的纯文本描述（不要 JSON、不要 markdown），必须覆盖：
1) 句子长度与节奏（短句/长句占比、段落密度）2) 对话密度与对话风格 3) 常用意象与感官描写偏好
4) 叙事视角与心理描写深度 5) 口癖/标志性修辞（如有）。只描述特征，不复述剧情。`;

/** 从样章提取风格指纹（1 次调用；失败返回空串，不阻塞） */
export async function extractFingerprint(sample: string): Promise<string> {
  try {
    const out = await chat(
      [
        { role: "system", content: FINGERPRINT_SYSTEM },
        { role: "user", content: `样章：\n${sample.slice(0, 6000)}` },
      ],
      { temperature: 0.3, maxTokens: 60000 },
    );
    return out.trim().slice(0, 500);
  } catch {
    return "";
  }
}

/** 注入 writer system 的反 AI 味规则摘要（精简版，控制 prompt 体积） */
export function antiAiToneRules(): string {
  return (
    "[反 AI 味硬规则] 禁用词（出现即视为败笔）：" +
    TIRED_WORDS.slice(0, 16).join("、") +
    "…；禁止总结式收尾（总之/就这样/新的篇章）；禁止解释性旁白与说教；" +
    "句式长短交错，避免连续排比；情绪用动作与感官细节呈现，不用「感到/充满」直陈。"
  );
}
