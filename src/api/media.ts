// 段落锚定媒体：分镜 LLM 读正文+角色/场景上下文，将情节「转写」为中文视觉 prompt（绝不摘抄原文、绝不虚构外推），
// 挑选最具画面感的关键段落（planScenes），再生成插画（generateSceneImage）或视频（createSceneVideo，5~15s）。
// 一致性机制：画风锚点（styleAnchor，全书统一）+ 角色参考图图生图（findCharacterRef）+ 视频 i2v 首帧（findAnchorImage）。
import { chatJson } from "./jsonutil";
import { generateImage, saveImage, readImage, compressToJpeg } from "./images";
import { createVideoTask, durationToNumFrames, VIDEO_MIN_SECONDS, VIDEO_MAX_SECONDS } from "./videos";
import type { Chapter, ChapterMedia, Character, SceneType, WorldState } from "./world";

/** 归一化：去空白、「」『』引号与全部中英文标点（与渲染端 ChapterView.norm 一致；LLM 摘抄 anchor 的标点差异不影响匹配） */
export const normAnchor = (s: string): string => s.replace(/[\s「」『』“”‘’"'()（）\[\]【】{}《》，。！？；：、—…,.!?;:'\-]/g, "");

export type ScenePlan = { anchor: string; scene: string; caption?: string; type?: SceneType; /** 画面主体角色名（参考图选择/图生图主体控制）；无角色则省略 */ subject?: string; /** 角色审计：scene 中出现但 anchor 段落正文未出场的角色名（前端黄色提示用）；无加戏则为空/省略 */ extraChars?: string[] };

/** 字符袋相似度：a 中每个字符能在 b 中按序找到的比例（容忍换序/轻改写，不要求子串连续） */
function charBagSim(a: string, b: string): number {
  if (!a.length) return 0;
  const cnt = new Map<string, number>();
  for (const ch of b) cnt.set(ch, (cnt.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of a) {
    const n = cnt.get(ch) ?? 0;
    if (n > 0) { hit++; cnt.set(ch, n - 1); }
  }
  return hit / a.length;
}

/**
 * anchor 模糊匹配兜底（纯函数，可单测）：精确子串失配时（LLM 把正文句子换序/轻改写，
 * 如把“一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去”合并换序成“柳青霜用白布蘸去沈夜唇角溢出的黑血”），
 * 按段落→句子窗口（1~3 句）做字符袋匹配；相似度 ≥0.85 时接受并回填该窗口的正文原文片段
 * （保证渲染端/巡检按正文子串稳定定位）。返回回填后的 anchor 原文，无匹配返回 undefined。
 */
export function fuzzyMatchAnchor(rawText: string, na: string): string | undefined {
  if (na.length < 4) return undefined;
  let best: { sim: number; text: string } | undefined;
  const paras = rawText.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  for (const para of paras) {
    // 按中文句末标点切句（保留标点，回填时保持原文风味）
    const sentences = para.split(/(?<=[。！？；…])/).map((s) => s.trim()).filter(Boolean);
    for (let win = 1; win <= 3 && win <= sentences.length; win++) {
      for (let i = 0; i + win <= sentences.length; i++) {
        const seg = sentences.slice(i, i + win).join("");
        const sim = charBagSim(na, normAnchor(seg));
        if (!best || sim > best.sim) best = { sim, text: seg };
      }
    }
  }
  return best && best.sim >= 0.85 ? best.text : undefined;
}

/**
 * 角色审计（纯函数，可单测）：对比所选 anchor 段落正文出场的角色 vs scene 中出现的角色名，
 * 找出「scene 画了段落中未出场的角色」（LLM 加戏/串场，前端据此黄色提示、不拦截）。
 * 只按角色名做字面点名匹配（角色名是专有名词，正文与 scene 均须点名出现）；同段多人各计一次。
 * 段落定位与 normalizeScenePlans 一致（anchor 所在段落，归一化包含匹配）；anchor 无法定位到段落时
 * 保守返回 []（避免误报）。返回 scene 中出现但段落正文未出场的角色名（按角色名册顺序去重）。
 */
export function sceneCharAudit(w: WorldState, chapterIndex: number, anchor: string, scene: string): string[] {
  const ch = w.chapters.find((c) => c.index === chapterIndex);
  if (!ch || !anchor || !scene) return [];
  const paras = ch.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const nAnchor = normAnchor(anchor);
  const para = paras.find((p) => normAnchor(p).includes(nAnchor));
  if (!para) return []; // 定位不到段落：保守不报（anchor 失配场景已在 normalize 过滤）
  const paraText = normAnchor(para);
  const roster = w.characters.map((c) => c.name).filter(Boolean);
  return roster.filter((name) => scene.includes(name) && !paraText.includes(name));
}

/** 每章插画数量上限（用户确认）：超限禁用生成，手动删除后可补 */
export const MAX_IMAGES_PER_CHAPTER = 3;

// —— 画风锚点：全书统一风格短语（纯函数零 LLM；按 genre/tone/time 关键词映射，兜底通用电影级动漫风）——
// 提示词全中文（Agnes 为国产模型，官方推荐示例即中文，用户也能看懂）
const STYLE_RULES: { keys: string[]; style: string }[] = [
  { keys: ["古风", "武侠", "仙侠", "玄幻", "宫廷", "历史", "古代"], style: "水墨风动漫插画，飘逸流畅的线条，淡雅绸缎色调，电影级光影" },
  { keys: ["科幻", "赛博", "未来", "星际", "机甲", "末世"], style: "电影级科幻概念画面，利落的未来感质感，霓虹与冷钢色调，体积光" },
  { keys: ["悬疑", "推理", "惊悚", "恐怖", "暗黑", "侦探"], style: "阴郁电影感画面，深邃阴影，低饱和色调，低调戏剧光" },
  { keys: ["奇幻", "魔法", "西幻", "冒险", "史诗"], style: "史诗奇幻概念画面，细腻的厚涂细节，暖色戏剧光" },
  { keys: ["都市", "现代", "职场", "校园", "青春", "现实"], style: "现代动漫插画，干净柔和的上色，自然日光色调，电影感构图" },
  { keys: ["言情", "爱情", "治愈", "温馨", "浪漫"], style: "柔和浪漫动漫插画，暖粉彩色调，温柔光晕" },
];
const STYLE_FALLBACK = "电影级动漫插画，统一画风，戏剧性光影，高细节";

// —— 时代服饰映射：按 setting.time 关键词转成具体服饰/造型指令（硬性转换，杜绝“现代人混进古代”类年代错乱）——
// 头部统一束发/挽髻、明确禁帽子（避免模型自行画出官帽/乌纱帽等易混淆头饰）；男女装束分写，供模型区分性别形象
const ERA_DRESS_RULES: { keys: string[]; dress: string }[] = [
  { keys: ["明", "崇祯", "万历", "永乐"], dress: "明朝装束：男子圆领袍或直身长衫，束发用布巾系扎，不戴任何帽子；女子交领袄裙配褙子，长发挽髻插簪" },
  { keys: ["唐", "贞观", "开元", "天宝"], dress: "唐朝装束：男子圆领袍，束发，不戴帽子；女子齐胸襦裙配披帛，高髻插花钿" },
  { keys: ["宋", "北宋", "南宋", "靖康"], dress: "宋朝装束：男子直裰长衫，束发，不戴帽子；女子褙子配百褶裙，梳发髻" },
  { keys: ["秦", "汉", "两汉", "西汉", "东汉"], dress: "秦汉装束：男子深衣或曲裾袍，束发，不戴帽子；女子曲裾深衣，垂髫发式" },
  { keys: ["民国", "近现代"], dress: "民国装束：男子长衫或中山装，短发；女子旗袍或学生装，民国发型" },
  { keys: ["现代", "都市", "当代"], dress: "现代日常服饰，当代发型" },
  { keys: ["未来", "星际", "赛博", "末世"], dress: "未来科技感服饰，赛博朋克风造型" },
];
const ERA_DRESS_FALLBACK = "古代东方服饰，束发盘髻，不戴帽子，无任何现代元素";

// —— 身份服饰映射：按角色身份/职业（identity）叠加具体服饰与配饰，解决“全书角色同款服装”的同质化问题 ——
// 与 eraDress（时代底衣）分层：先按时代统一底衣，再按身份叠加标识性服饰/配饰
// 分块组织，顺序匹配首个命中；同块内先具体后通用，避免泛化词（工程师/经理/医生等）抢占具体职业
// 块序：仙侠修真 → 西幻/星际异世界 → 现代办公/IT/政商 → 医疗健康 → 服务/餐饮/零售/物流
//      → 政法/建筑/运输/市政/军警 → 文娱/艺术/体育 → 传统手艺与古代补充 → 古代原有条目
// 全表共 300+ 条规则，覆盖 10 大领域 40+ 类常见社会身份，未命中任何条目时仅用时代底衣
export const IDENTITY_DRESS_RULES: { keys: string[]; dress: string }[] = [
  // —— 一、仙侠修真（置于最前：含「道人」等词，须先于僧道条目命中）——
  { keys: ["修仙者", "修士", "修真者", "修炼者", "修仙", "道人", "修道者", "问道"], dress: "仙家道袍：月白或青灰交领广袖道袍，束发挽髻插玉簪，气度出尘" },
  { keys: ["剑修", "剑仙"], dress: "剑修剑袍：青白长袍，背后或腰间佩长剑，眉宇凌厉" },
  { keys: ["丹修", "炼丹师", "丹师"], dress: "丹师法袍：素色长袍缀丹火暗纹，腰佩丹葫芦" },
  { keys: ["符修", "符箓师", "画符"], dress: "符箓道袍：袍上隐现符纹，腰系朱砂笔与符纸袋" },
  { keys: ["阵修", "阵法师"], dress: "阵师法袍：绣星阵纹的长袍，手持阵盘或阵旗" },
  { keys: ["器修", "炼器师", "铸器师"], dress: "炼器短褐：打铁短褐束袖，系皮质围裙，臂膀结实" },
  { keys: ["体修", "炼体士"], dress: "体修劲装：束袖劲装半露臂膀，肌肉线条分明" },
  { keys: ["魔修", "邪修", "魔尊"], dress: "魔修玄袍：玄黑长袍带魔纹暗绣，周身煞气" },
  { keys: ["鬼修", "魂修"], dress: "鬼修灰袍：灰白旧袍，面色苍白阴冷" },
  { keys: ["妖修", "狐妖", "精怪", "化形"], dress: "妖修华服：妖异华丽的锦袍或裙衫，眉眼带魅" },
  { keys: ["掌门", "宗主", "老祖", "门主"], dress: "掌门法袍：华贵法袍绣宗门纹章，气度威严" },
  { keys: ["内门弟子", "外门弟子", "杂役弟子", "弟子"], dress: "宗门弟子服：统一色系门派制服，束发" },
  { keys: ["散修", "游方修士"], dress: "散修布袍：洗旧的素色布袍，风尘仆仆" },
  { keys: ["国师", "天师", "司天监", "观星"], dress: "国师法袍：星斗纹深色法袍，手持罗盘或星图" },
  { keys: ["采药人", "药农", "采药"], dress: "采药人装束：粗布短褐，背负草编药篓，袖口扎紧" },
  { keys: ["驭兽师", "御兽师"], dress: "驭兽装束：兽皮披风与皮质护腕，腰佩兽笛" },
  { keys: ["相师", "算命先生", "占卜师", "卜算"], dress: "相师长衫：灰布长衫，手执卦幡或龟壳铜钱" },
  { keys: ["护法", "山门", "守山"], dress: "护法劲装：玄色劲装，腰佩兵刃，身形魁梧" },
  { keys: ["药童", "药庐"], dress: "药童短褐：素色短衣配布围裙，背小药篓，一脸稚气" },
  { keys: ["灵植"], dress: "灵植师青袍：青绿长衫袖口挽起，腰挂灵锄，指间沾灵土" },
  { keys: ["护道"], dress: "护道劲装：暗金束袖劲装，腰佩宗门令符，气息沉稳" },

  // —— 二、西幻异世界 ——
  { keys: ["巫师", "魔法师", "法师", "术士", "女巫", "魔女"], dress: "巫师法袍：深色尖顶兜帽法袍，手持魔杖，周身魔法微光" },
  { keys: ["骑士", "圣骑士"], dress: "骑士铠甲：亮银铠甲与骑士披风，佩长剑与盾" },
  { keys: ["吟游诗人", "游吟诗人"], dress: "吟游诗人装束：彩纹披风配竖琴，衣饰洒脱" },
  { keys: ["剑士", "勇者", "角斗士"], dress: "剑士轻甲：皮质轻甲配长剑，护腕束带" },
  { keys: ["弓箭手", "弓手", "猎手"], dress: "弓箭手皮甲：绿色皮甲，背长弓与箭袋" },
  { keys: ["牧师", "神父", "修女", "传教士"], dress: "神职圣袍：白色或黑色神职长袍，佩戴圣徽" },
  { keys: ["国王", "王后", "王子", "公主", "贵族", "王族", "公爵", "伯爵", "侯爵", "子爵", "男爵", "领主"], dress: "王族华服：丝绒华服或锦缎礼服，佩王冠或纹章饰物" },
  { keys: ["佣兵", "赏金猎人"], dress: "佣兵装束：皮甲斗篷，腰挎兵器，风霜满面" },
  { keys: ["德鲁伊"], dress: "德鲁伊皮袍：树皮色皮袍缀藤蔓枝叶，手持橡木法杖" },
  { keys: ["萨满"], dress: "萨满服饰：兽皮长袍配骨珠项链，手持图腾法杖" },
  { keys: ["祭司"], dress: "祭司圣袍：白金色圣袍佩圣徽，庄重肃穆" },
  { keys: ["先知"], dress: "先知长袍：灰白兜帽长袍，手托水晶球，神秘莫测" },
  { keys: ["炼金"], dress: "炼金术师装束：皮革工作袍配护目镜，腰间挂满试剂瓶" },
  { keys: ["猎魔"], dress: "猎魔人装束：黑色皮甲配银质兵刃，斗篷猎猎" },
  { keys: ["驱魔"], dress: "驱魔师装束：长款风衣配圣水瓶与十字架" },
  { keys: ["灵媒"], dress: "灵媒装束：复古长裙配水晶挂饰，气质神秘" },
  { keys: ["海盗", "海贼"], dress: "海盗装束：船长外套配三角帽与眼罩，腰挎弯刀" },
  { keys: ["舰长"], dress: "星际舰服：银白舰服配徽章肩章，英气逼人" },
  { keys: ["机甲"], dress: "机甲驾驶服：紧身连体驾驶服配飞行头盔" },
  { keys: ["星际商人", "星际走私"], dress: "星际商人装束：华丽星际斗篷，手持全息账本" },

  // —— 三、现代办公/IT/政商 ——
  { keys: ["程序员", "码农", "软件工程师", "开发工程师", "算法工程师", "数据分析师", "运维工程师", "测试工程师", "后端", "前端开发"], dress: "程序员装束：格子衬衫或连帽卫衣，戴眼镜，随性休闲" },
  { keys: ["产品经理", "项目经理"], dress: "产品经理装束：商务休闲衬衫，干练利落" },
  { keys: ["设计师", "平面设计", "UI设计", "插画师", "视觉设计", "室内设计"], dress: "设计师装束：简约时尚穿搭，个性气质" },
  { keys: ["架构师", "技术总监", "技术负责人", "CTO"], dress: "技术高管装束：深色商务衬衫，沉稳专业" },
  { keys: ["总裁", "CEO", "董事长", "总经理", "副总裁", "企业高管"], dress: "企业高管装束：高级定制西装，领带袖扣，气度不凡" },
  { keys: ["国企", "央企"], dress: "国企干部装束：深蓝夹克配白衬衫，沉稳朴素" },
  { keys: ["公务员", "机关干部", "科长", "处长", "乡长", "镇长", "县长", "市长", "省委", "市委", "政府"], dress: "机关干部装束：藏青夹克或白衬衫，正派干练" },
  { keys: ["施工员", "监理", "建筑工程师", "造价师", "预算员", "工程管理"], dress: "工程人员装束：白衬衫或工装，戴安全帽，夹着图纸" },
  { keys: ["律师", "法务", "诉讼"], dress: "律师正装：深色西装领带，手提公文包，气质严谨" },
  { keys: ["会计", "财务", "出纳", "审计"], dress: "财务正装：职业套装，干练整洁" },
  { keys: ["人事", "HR", "人力资源"], dress: "HR职业装：商务套装，亲和专业" },
  { keys: ["白领", "文员", "行政", "内勤", "职员"], dress: "都市白领装束：衬衫西裤或职业裙装，通勤风" },
  { keys: ["前台", "接待", "迎宾"], dress: "前台制服：公司制服，妆容精致" },
  { keys: ["销售", "业务员", "客户经理", "销售经理", "推销"], dress: "销售正装：西装领带，精神利落" },
  { keys: ["市场", "营销", "策划", "品牌", "广告"], dress: "市场人装束：商务休闲装，创意干练" },
  { keys: ["新媒体", "自媒体", "博主", "网红", "运营"], dress: "新媒体装束：时尚休闲穿搭，镜头感强" },
  { keys: ["记者", "编辑", "主编", "媒体", "新闻"], dress: "记者装束：采访马甲配衬衫，随身采访本" },
  { keys: ["教师", "老师", "教授", "讲师", "班主任", "教员"], dress: "教师装束：衬衫长裤，戴眼镜，温和知性" },
  { keys: ["科学家", "研究员", "学者", "科研"], dress: "科研白大褂：白大褂配内搭衬衫，实验室风" },
  { keys: ["考古学家", "文物专家", "考古"], dress: "考古装束：户外工装，背工具包，手持放大镜" },
  { keys: ["心理咨询师", "心理医生", "咨询师"], dress: "心理师装束：休闲正装，温和专业" },
  { keys: ["学生", "大学生", "研究生", "博士生", "中学生", "小学生", "学生党"], dress: "学生装束：校服或青春休闲装，学生气" },
  { keys: ["工程师", "技术员", "工程人员"], dress: "工程师装束：衬衫或工装，干练务实" },
  { keys: ["秘书", "助理"], dress: "助理装束：职业套装，干练利落" },
  { keys: ["人工智能", "大模型"], dress: "AI从业者装束：简约休闲衫配工牌，气质冷静" },
  { keys: ["黑客", "网络安全", "白帽"], dress: "黑客装束：深色连帽卫衣配双屏电脑，专注凌厉" },
  { keys: ["游戏制作", "游戏开发"], dress: "游戏制作人装束：休闲T恤配工牌，创意十足" },
  { keys: ["原画"], dress: "原画师装束：围裙配数位板，指间沾颜料" },
  { keys: ["漫画家"], dress: "漫画家装束：宽松家居服配数位板，伏案专注" },
  { keys: ["配音", "声优"], dress: "配音演员装束：宽松卫衣配录音麦克风，神情专注" },
  { keys: ["翻译", "同声传译", "译员", "口译"], dress: "译员装束：商务套装配同传耳机，干练专业" },
  { keys: ["图书管理员", "图书馆"], dress: "图书管理员装束：朴素衬衫配眼镜，温文尔雅" },
  { keys: ["档案"], dress: "档案员装束：白衬衫配袖套，严谨细致" },
  { keys: ["校长"], dress: "校长装束：深色西装，稳重威严" },
  { keys: ["留学"], dress: "留学顾问装束：商务休闲装，亲和专业" },
  { keys: ["家教"], dress: "家教装束：便装配教材袋，温和耐心" },
  { keys: ["校对"], dress: "校对员装束：衬衫眼镜，手执红笔与样稿" },
  { keys: ["文物修复"], dress: "文物修复师装束：白大褂配放大镜与修复工具" },
  { keys: ["古籍修复"], dress: "古籍修复师装束：素色围裙配镊子毛刷" },

  // —— 四、医疗健康（细分科室置于前，避免被通用「医生」条目抢占）——
  { keys: ["眼科"], dress: "眼科医生白大褂：白大褂配视光镜与裂隙灯" },
  { keys: ["儿科", "儿童医院"], dress: "儿科医生白大褂：白大褂配听诊器，亲和温暖" },
  { keys: ["妇产"], dress: "产科医生白大褂：白大褂配听诊器，沉稳专业" },
  { keys: ["骨科"], dress: "骨科医生装束：白大褂内衬手术服，身形壮硕" },
  { keys: ["内科", "外科"], dress: "内外科医生白大褂：白大褂配胸牌，从容专业" },
  { keys: ["急诊"], dress: "急诊医生装束：急救马甲配听诊器，风风火火" },
  { keys: ["麻醉"], dress: "麻醉师装束：手术服配手术帽，专注细致" },
  { keys: ["影像", "放射"], dress: "影像医生白大褂：白大褂，身后是医学影像屏" },
  { keys: ["检验", "化验"], dress: "检验员白大褂：白大褂配乳胶手套，手执试管" },
  { keys: ["急救", "救护车"], dress: "急救员装束：荧光急救服配急救箱，随时待命" },
  { keys: ["殡葬", "入殓"], dress: "殡葬师装束：黑色正装，庄重肃穆" },
  { keys: ["催眠"], dress: "催眠师装束：深色马甲配怀表，气质深沉" },
  { keys: ["验光"], dress: "验光师装束：白衬衫配验光仪器，细致专业" },
  { keys: ["兽医"], dress: "兽医白大褂：白大褂配听诊器，常沾宠物毛" },
  { keys: ["法医"], dress: "法医白大褂：白大褂配乳胶手套，冷静专业" },
  { keys: ["牙医", "口腔"], dress: "牙医白大褂：白大褂配口罩，手持牙镜" },
  { keys: ["医生", "医师", "主治", "名医", "医学", "医院"], dress: "医生白大褂：白大褂配听诊器，专业干练" },
  { keys: ["护士", "护工", "护理"], dress: "护士服：浅色护士服或分体护理服，别护士表" },
  { keys: ["药剂师", "药师", "药房"], dress: "药师白大褂：白大褂配胸牌，药房风" },
  { keys: ["康复师", "理疗师", "针灸", "推拿"], dress: "康复师工作服：浅色工作服，手法专业" },
  { keys: ["美容师", "美甲师", "纹绣", "医美", "美容"], dress: "美容师工服：浅色美容工服，妆容精致" },
  { keys: ["健身教练", "私教", "健身"], dress: "健身教练装束：运动背心或紧身运动服，肌肉线条" },
  { keys: ["瑜伽教练", "瑜伽"], dress: "瑜伽教练装束：瑜伽服，身姿舒展" },
  { keys: ["营养师"], dress: "营养师装束：休闲装，气质健康" },

  // —— 五、服务/餐饮/零售/物流 ——
  { keys: ["美团"], dress: "美团骑手服：标志黄色工服配骑行头盔，胸前保温箱，反光条" },
  { keys: ["饿了么"], dress: "饿了么骑手服：蓝色工服配骑行头盔，胸前保温箱，反光条" },
  { keys: ["淘宝外卖", "闪购"], dress: "淘宝闪购骑手服：橙色工服配骑行头盔，胸前保温箱，反光条" },
  { keys: ["京东外卖", "达达"], dress: "京东秒送骑手服：红色工服配骑行头盔，胸前保温箱，反光条" },
  { keys: ["外卖", "骑手"], dress: "外卖骑手服：平台工装（黄蓝橙红），骑行头盔，胸前保温箱" },
  { keys: ["快递", "跑腿", "闪送", "配送"], dress: "快递员工服：快递工装马甲配帽子，手持扫码枪" },
  { keys: ["服务员", "侍应生", "传菜员", "服务生"], dress: "服务员制服：餐厅制服配围裙，托盘服务" },
  { keys: ["厨师", "大厨", "主厨", "后厨", "烹饪"], dress: "厨师服：白色厨师服，头戴厨师帽" },
  { keys: ["面点师", "烘焙师", "糕点师", "甜品师", "面包师"], dress: "面点师装束：围裙配袖套，双手沾面粉" },
  { keys: ["咖啡师", "奶茶店员", "奶茶", "咖啡"], dress: "咖啡师装束：工装围裙，别工作牌" },
  { keys: ["收银员", "营业员", "导购", "售货员", "店员", "店长"], dress: "门店工服：商场或门店统一工服" },
  { keys: ["理货员", "分拣员", "仓管", "仓库", "库管", "打包员"], dress: "仓库工装：工装马甲，忙碌利落" },
  { keys: ["保洁", "清洁工"], dress: "保洁工服：浅蓝或灰色工作服，手持清洁工具" },
  { keys: ["环卫", "扫街"], dress: "环卫工服：橙色反光马甲，配环卫工具" },
  { keys: ["保安", "门卫", "秩序员", "安保"], dress: "保安制服：深色保安制服，配警棍和对讲机" },
  { keys: ["保姆", "月嫂", "育儿嫂", "家政"], dress: "家政装束：家政围裙，朴素整洁" },
  { keys: ["出租车", "网约车", "滴滴", "的哥", "的姐"], dress: "出租司机装束：便装或浅色衬衫，干净利落" },
  { keys: ["公交", "大巴", "客车", "班车"], dress: "司机制服：公交司机制服，端庄稳练" },
  { keys: ["货车", "卡车", "长途司机", "挂车"], dress: "货车司机装束：工装夹克，风尘仆仆" },
  { keys: ["代驾"], dress: "代驾装束：反光背心，随身折叠电动车" },
  { keys: ["司机", "驾驶员"], dress: "专职司机装束：深色便装，白手套" },
  { keys: ["房产", "中介", "置业顾问", "售楼"], dress: "房产中介装束：西装领带，佩戴工牌" },
  { keys: ["保险代理人", "保险", "理赔员"], dress: "保险从业装束：西装或商务装，文件包" },
  { keys: ["银行", "柜员", "大堂经理"], dress: "银行制服：银行制服配丝巾或领带，端庄专业" },
  { keys: ["理财师", "基金经理", "证券", "分析师", "金融"], dress: "金融精英装束：深色西装，精英气质" },
  { keys: ["空乘", "空姐", "空少", "航空", "机组"], dress: "空乘制服：航司制服，妆容精致仪态优雅" },
  { keys: ["列车员", "乘务员", "乘务长", "铁路", "高铁", "动车"], dress: "乘务制服：铁路乘务制服，端庄亲切" },
  { keys: ["酒店", "礼宾", "门童", "客房"], dress: "酒店制服：酒店工作制服，礼貌专业" },
  { keys: ["汽修", "修车", "洗车", "机修"], dress: "汽修工装：工装连体服，手持工具" },
  { keys: ["茶艺"], dress: "茶艺师装束：素雅中式茶服，气质沉静" },
  { keys: ["品酒", "侍酒"], dress: "品酒师装束：深色围裙配领结，手持酒杯" },
  { keys: ["花艺"], dress: "花艺师装束：布围裙配花剪，指间沾绿意" },
  { keys: ["珠宝", "鉴宝"], dress: "珠宝鉴定师装束：深色正装配珠宝放大镜" },
  { keys: ["典当", "当铺"], dress: "典当行装束：中式长衫配小算盘，目光精明" },
  { keys: ["修表", "钟表"], dress: "修表匠装束：工作围裙配单目放大镜，手稳心细" },
  { keys: ["锁匠", "开锁"], dress: "锁匠装束：工装马甲配钥匙工具包" },
  { keys: ["送水"], dress: "送水工装束：工装背心，肩扛水桶" },
  { keys: ["手机维修", "电脑维修"], dress: "数码维修师装束：工装围裙配精密螺丝刀" },
  { keys: ["训犬"], dress: "训犬师装束：工装马甲配口哨与牵引绳" },
  { keys: ["加油站"], dress: "加油站员工装束：加油工服配工作手套" },
  { keys: ["泊车", "停车场"], dress: "泊车员制服：制服配白手套与对讲机" },
  { keys: ["民宿"], dress: "民宿老板装束：棉麻休闲装，亲切随和" },
  { keys: ["花店"], dress: "花店老板装束：布围裙配花剪，笑容温暖" },
  { keys: ["书店"], dress: "书店老板装束：针织衫配眼镜，满身书卷气" },
  { keys: ["古玩"], dress: "古玩店主装束：中式马褂配老花镜" },
  { keys: ["日料", "寿司"], dress: "日料师傅装束：和服式工作服配头巾" },
  { keys: ["烧烤", "烤肉"], dress: "烧烤师傅装束：围裙配长柄铁钳，烟火气十足" },
  { keys: ["食堂"], dress: "食堂师傅装束：白围裙配白帽，朴实热情" },
  { keys: ["面馆", "拉面"], dress: "面馆师傅装束：围裙配护袖，甩面利落" },

  // —— 六、建筑/运输/市政/军警 ——
  { keys: ["建筑工人", "农民工", "瓦工", "泥工", "架子工", "钢筋工", "工地", "搬砖"], dress: "建筑工装：工装服配安全帽，双手粗糙有力" },
  { keys: ["木工", "装修", "油漆工"], dress: "装修工装：工装服，随身工具包" },
  { keys: ["电工", "水电", "管道工", "维修工", "安装工"], dress: "电工工装：工装服配工具腰带，专业干练" },
  { keys: ["焊工", "电焊"], dress: "焊工装束：防护工装配焊接面罩护目镜" },
  { keys: ["矿工", "煤矿", "采矿"], dress: "矿工装束：矿工服配头灯，面有煤尘" },
  { keys: ["消防员", "消防", "火警"], dress: "消防战斗服：消防战斗服配头盔，英姿飒爽" },
  { keys: ["交警"], dress: "交警制服：交警制服配反光背心与白手套" },
  { keys: ["特警", "武警", "防暴"], dress: "特警作战服：深色作战服配战术装备" },
  { keys: ["警察", "民警", "刑警", "片警", "警长", "警官", "公安", "派出所"], dress: "警服：深蓝警服配警徽，正气凛然" },
  { keys: ["城管", "行政执法"], dress: "城管制服：城管制服，规范文明" },
  { keys: ["军人", "士兵", "军官", "战士", "特种兵", "侦察兵", "少将", "中将", "上将", "大校", "少校", "上尉", "连长", "营长", "团长", "参谋"], dress: "军装：军装军靴，英武挺拔" },
  { keys: ["海关", "边检", "缉私"], dress: "海关制服：海关制服，庄重威严" },
  { keys: ["狱警", "监狱", "看守所"], dress: "狱警制服：深色制服配警衔" },
  { keys: ["船长", "水手", "海员", "船员", "大副", "轮机"], dress: "海员制服：深蓝航海制服或水手服" },
  { keys: ["飞行员", "机长", "副驾驶"], dress: "飞行制服：飞行夹克或制服，配肩章" },
  { keys: ["塔吊", "挖掘机", "叉车", "吊车"], dress: "机械操作装束：工装服，高空作业安全带" },
  { keys: ["护林员", "巡山"], dress: "护林装束：户外工装配背包，风尘朴实" },
  { keys: ["工人", "厂工", "普工", "流水线", "车间", "纺织", "操作工"], dress: "产业工人工装：车间工装，务实勤劳" },
  { keys: ["法官", "审判"], dress: "法官装束：黑色法袍，威严庄重" },
  { keys: ["检察官", "公诉"], dress: "检察官制服：深蓝制服配检徽，正气凛然" },
  { keys: ["书记员"], dress: "书记员装束：正装配速录设备，专注严谨" },
  { keys: ["法警"], dress: "法警制服：司法警服，庄重威严" },
  { keys: ["辅警"], dress: "辅警制服：执勤制服配反光背心" },
  { keys: ["社区", "社工"], dress: "社区工作者装束：马甲配工作证，亲切热忱" },
  { keys: ["协管"], dress: "交通协管装束：反光背心配指挥旗" },
  { keys: ["狙击手"], dress: "狙击手装束：迷彩作战服配吉利服，静如处子" },
  { keys: ["情报员", "间谍", "特工", "卧底"], dress: "情报人员装束：深色便装风衣，气质冷峻" },
  { keys: ["军需"], dress: "军需官装束：军装配账册，干练务实" },
  { keys: ["地质", "勘探"], dress: "地质勘探装束：户外工装配地质锤与罗盘" },
  { keys: ["环保"], dress: "环保监测装束：工装马甲配检测仪器" },
  { keys: ["押运", "运钞"], dress: "押运员装束：防弹背心配钢盔，戒备森严" },
  { keys: ["乘警"], dress: "乘警制服：铁路警服，威武干练" },

  // —— 七、文娱/艺术/体育 ——
  { keys: ["演员", "明星", "艺人", "影星"], dress: "明星穿搭：时尚穿搭，气质出众" },
  { keys: ["歌手", "歌星", "音乐人", "歌唱家"], dress: "歌手舞台装：舞台装束，华丽闪亮" },
  { keys: ["导演", "编剧", "监制"], dress: "导演装束：导演马甲配棒球帽，专注从容" },
  { keys: ["摄影师", "摄像师", "摄影"], dress: "摄影师装束：多口袋摄影马甲，身挎相机" },
  { keys: ["画家", "书法家", "艺术家"], dress: "艺术家装束：围裙配贝雷帽，指间颜料" },
  { keys: ["作家", "小说家", "诗人", "撰稿人"], dress: "作家装束：毛衣配眼镜，文气儒雅" },
  { keys: ["钢琴家", "音乐家", "乐手", "演奏家", "乐师"], dress: "音乐家礼服：深色礼服或演出服" },
  { keys: ["舞者", "舞蹈家", "芭蕾", "伴舞"], dress: "舞者练功服：舞蹈练功服，身姿优美" },
  { keys: ["主持人", "播音员", "司仪"], dress: "主持人正装：西装或礼服，台风端正" },
  { keys: ["模特", "超模"], dress: "模特穿搭：时尚潮流穿搭，身形高挑" },
  { keys: ["运动员", "球员", "拳手", "拳击"], dress: "运动员装束：运动服，充满活力" },
  { keys: ["电竞", "职业选手"], dress: "电竞选手装束：战队队服，专注电竞" },
  { keys: ["魔术师", "杂技演员", "马戏"], dress: "魔术师装束：燕尾服或马戏演出服" },
  { keys: ["调酒师", "酒吧老板"], dress: "调酒师装束：马甲领结，动作潇洒" },
  { keys: ["理发师", "发型师", "造型师"], dress: "理发师装束：深色围布，手持剪刀" },
  { keys: ["化妆师"], dress: "化妆师装束：化妆围裙，刷具随身" },
  { keys: ["驯兽师"], dress: "驯兽师装束：马甲配长鞭，气势十足" },
  { keys: ["导游", "讲解员"], dress: "导游装束：马甲配小旗，热情开朗" },
  { keys: ["主播", "直播", "带货"], dress: "主播装束：上镜时尚装，灯光下亮眼" },
  { keys: ["相声"], dress: "相声演员装束：传统长衫，台风活泼" },
  { keys: ["京剧", "戏曲", "昆曲"], dress: "戏曲演员装束：戏服或练功水袖" },
  { keys: ["评书"], dress: "评书艺人装束：长衫配醒木，气度从容" },
  { keys: ["DJ", "打碟"], dress: "DJ装束：潮流穿搭配监听耳机，动感十足" },
  { keys: ["录音"], dress: "录音师装束：休闲装配监听耳机，专注调音台" },
  { keys: ["剪辑"], dress: "剪辑师装束：休闲装，紧盯屏幕" },
  { keys: ["灯光"], dress: "灯光师装束：黑色工作装配对讲机" },
  { keys: ["主唱", "乐队"], dress: "乐队主唱装束：摇滚穿搭，个性张扬" },
  { keys: ["裁判"], dress: "裁判装束：黑白条纹裁判服配口哨" },
  { keys: ["赛车"], dress: "赛车手装束：赛车服配头盔，英姿飒爽" },
  { keys: ["高尔夫"], dress: "高尔夫球手装束：Polo衫配球帽，潇洒从容" },
  { keys: ["马拉松", "长跑"], dress: "跑者装束：速干运动服配跑鞋，活力满满" },
  { keys: ["骑行"], dress: "骑行者装束：骑行服配头盔，风尘仆仆" },
  { keys: ["钓鱼", "钓手"], dress: "钓手装束：钓鱼背心配遮阳帽，悠然自得" },
  { keys: ["潜水"], dress: "潜水员装束：潜水服配氧气瓶与脚蹼" },
  { keys: ["登山", "攀岩"], dress: "登山者装束：冲锋衣配登山包与登山杖" },
  { keys: ["滑雪"], dress: "滑雪教练装束：滑雪服配雪镜，活力四射" },
  { keys: ["游泳"], dress: "游泳教练装束：运动装配口哨，身形健美" },
  { keys: ["武术", "武馆"], dress: "武术教练装束：练功服配束带，身手矫健" },
  { keys: ["特技"], dress: "特技演员装束：护具配紧身衣，胆识过人" },
  { keys: ["街头卖艺", "流浪歌手"], dress: "街头艺人装束：随性穿搭配乐器，自由洒脱" },
  { keys: ["经纪人"], dress: "经纪人装束：时尚正装，干练利落" },
  { keys: ["星探"], dress: "星探装束：时尚休闲装，目光敏锐" },
  { keys: ["策展", "画廊"], dress: "策展人装束：简约艺术风穿搭，品味独特" },
  { keys: ["拍卖"], dress: "拍卖师装束：深色正装配小木槌" },

  // —— 八、传统手艺与古代行业补充 ——
  { keys: ["铁匠", "打铁", "锻工", "铸剑"], dress: "铁匠装束：皮围裙配粗布短褐，肌肉结实" },
  { keys: ["石匠", "瓦匠", "泥水匠"], dress: "石匠短褐：粗布短褐，手生老茧" },
  { keys: ["木匠"], dress: "木匠装束：粗布衣配围裙，手持刨凿" },
  { keys: ["裁缝", "绣娘", "织女", "织工"], dress: "裁缝装束：素色衣裳，颈挂软尺，手戴顶针" },
  { keys: ["屠户", "屠夫"], dress: "屠户装束：油布围裙，膀大腰圆" },
  { keys: ["车夫", "马夫", "轿夫", "船夫", "艄公", "纤夫"], dress: "车夫短褐：粗布短褐束腰带，腿脚利索" },
  { keys: ["更夫", "守夜人", "打更"], dress: "更夫装束：深色短衣，手提灯笼与梆子" },
  { keys: ["花匠", "园丁", "花农"], dress: "花匠装束：布围裙，沾着泥土" },
  { keys: ["乞丐", "流民", "难民", "流浪汉", "拾荒"], dress: "乞丐衣衫：破旧衣衫，蓬头垢面" },
  { keys: ["强盗", "山贼", "土匪", "马贼", "绑匪", "劫匪"], dress: "强盗短打：绑腿短打，腰插朴刀" },
  { keys: ["伙夫", "厨娘", "灶头"], dress: "伙夫装束：粗布围裙，烟火气十足" },
  { keys: ["账房", "管家", "管账"], dress: "账房先生装束：长衫配算盘，精明干练" },
  { keys: ["师爷", "幕僚", "谋士", "军师"], dress: "师爷文士衫：青灰长衫，手持折扇" },
  { keys: ["画师", "画工", "丹青"], dress: "画师装束：素色长衫，指间墨迹" },
  { keys: ["金银匠", "首饰匠", "打银"], dress: "金银匠装束：粗布围裙配小锤，手艺精巧" },
  { keys: ["篾匠", "竹匠"], dress: "篾匠装束：短衣配竹刀，手指粗糙灵巧" },
  { keys: ["漆匠"], dress: "漆匠装束：粗布衣沾漆渍，手持漆刷" },
  { keys: ["染布", "染坊"], dress: "染布匠装束：围裙沾靛蓝，双手泛蓝" },
  { keys: ["补锅"], dress: "补锅匠装束：粗布短衣，担着风箱炉具" },
  { keys: ["磨刀"], dress: "磨刀匠装束：粗布衣配磨刀凳，走街串巷" },
  { keys: ["剃头"], dress: "剃头匠装束：白围布配剃刀，手艺娴熟" },
  { keys: ["货郎"], dress: "货郎装束：布衣配货担，摇着拨浪鼓" },
  { keys: ["糖画"], dress: "糖画艺人装束：围裙配铜勺，糖浆飘香" },
  { keys: ["捏面", "面人"], dress: "捏面艺人装束：围裙配彩面团，指尖生花" },
  { keys: ["卖炭", "炭翁"], dress: "卖炭翁装束：粗黑衣衫配炭筐，满脸风霜" },
  { keys: ["豆腐"], dress: "豆腐匠装束：白围裙，浑身豆香" },
  { keys: ["酿酒", "酒坊"], dress: "酿酒师装束：短褐配酒勺，酒气微醺" },
  { keys: ["养蜂", "蜂农"], dress: "养蜂人装束：防蜂服配面纱网帽" },
  { keys: ["采参", "参农"], dress: "采参人装束：短褐配背篓，红绳系参" },
  { keys: ["淘金"], dress: "淘金者装束：粗布衣配淘金盘，双手沾泥" },
  { keys: ["盐工", "晒盐"], dress: "盐工装束：短衣配草帽，衣上结盐霜" },
  { keys: ["窑工", "烧窑"], dress: "窑工装束：粗布衣沾窑灰，汗流浃背" },

  // —— 九、古代原有条目（保留原描述与语义）——
  { keys: ["捕快", "捕头", "衙役", "差役", "巡捕"], dress: "捕快公服：青灰色短打公服，腰系红布带并佩刀，扎袖束发" },
  { keys: ["提督", "厂公", "督主", "东厂", "锦衣卫", "指挥使", "千户"], dress: "厂卫官服：玄色或绛红织金蟒袍/飞鱼服（金线绣蟒纹），腰束革带，佩绣春刀，气势威重" },
  { keys: ["仵作", "仵役"], dress: "仵作短褐：灰褐短褐布衣，袖口挽起，腰系布带" },
  { keys: ["郎中", "大夫", "杏林", "医馆", "药堂", "坐堂", "神医", "医者", "医师"], dress: "医者布衣：素色长衫，肩挎药箱或背搭裢" },
  { keys: ["将军", "武将", "统领", "校尉", "都尉", "元帅", "总兵", "副将"], dress: "武将戎装：玄色战袍配轻甲或山文甲，束甲带，佩兵刃" },
  { keys: ["皇帝", "帝王", "太子", "亲王", "国主", "天子", "皇上", "圣上", "陛下"], dress: "帝王衮服：明黄龙袍或衮冕" },
  { keys: ["皇后", "太后", "皇贵妃", "贵妃", "嫔妃", "妃子", "娘娘", "皇妃"], dress: "后妃宫装：凤冠霞帔或华贵宫装，仪态雍容" },
  { keys: ["尚书", "侍郎", "御史", "知府", "知县", "宰相", "内阁", "官员", "巡抚", "总督", "节度使", "太守", "刺史"], dress: "官员朝服：靛蓝或藏青补子官服，束发戴乌纱帽" },
  { keys: ["书生", "学子", "秀才", "举人", "文人", "才子", "进士", "儒生", "童生"], dress: "书生青衫：青布长衫，束发，手持书卷或折扇" },
  { keys: ["侠", "剑客", "镖", "杀手", "刺客", "江湖", "游侠", "刀客"], dress: "江湖劲装：玄色劲装短打，束腰带，佩刀剑" },
  { keys: ["僧", "和尚", "道士", "尼姑", "禅", "方丈", "住持", "僧人", "师太", "行者", "沙弥"], dress: "僧道衣袍：灰褐僧袍或青灰道袍，手持拂尘或念珠" },
  { keys: ["宫女", "嬷嬷", "内侍", "太监", "宦官", "女官"], dress: "宫廷服制：素雅宫装或深色内侍服" },
  { keys: ["商人", "掌柜", "商贩", "行商", "商贾", "铺子", "绸缎庄", "米行"], dress: "商人绸衫：靛青长衫马褂，腰系钱袋" },
  { keys: ["丫鬟", "小厮", "家丁", "仆役", "奴仆", "婢女", "长工"], dress: "仆役短衣：素色短衣，腰束布带" },
  { keys: ["青楼", "花魁", "乐工", "伶人", "舞姬", "舞女", "歌女"], dress: "乐伎装束：绯红或藕荷色裙衫配披帛，妆容精致" },
  { keys: ["农", "樵", "渔", "猎户", "猎人", "佃", "农户", "庄稼", "种田"], dress: "粗布短褐：土黄麻布衣裤，草鞋或布鞋" },
  { keys: ["稳婆", "接生婆"], dress: "稳婆装束：深色粗布衣挽袖，手脚麻利" },
  { keys: ["媒婆"], dress: "媒婆装束：红绿花衣配团扇，能说会道" },
  { keys: ["奶娘", "乳母"], dress: "奶娘装束：素净衣裳，温厚和蔼" },
  { keys: ["刽子手", "行刑"], dress: "刽子手装束：红衣黑头巾，膀大腰圆" },
  { keys: ["狱卒", "牢头"], dress: "狱卒装束：皂衣配水火棍，凶悍壮实" },
  { keys: ["驿卒", "驿差", "驿站"], dress: "驿卒装束：皂衣配令牌，腿脚飞快" },
  { keys: ["书吏", "书办"], dress: "书吏装束：青衫配毛笔，伏案抄录" },
  { keys: ["马倌", "马童", "槽头"], dress: "马倌装束：短衣配马刷，满身草料味" },
  { keys: ["脚夫", "挑夫"], dress: "脚夫装束：短褐配扁担，肩宽腿粗" },
  { keys: ["船娘"], dress: "船娘装束：布衣配包头巾，摇橹唱曲" },
  { keys: ["装卸", "码头工"], dress: "装卸工装束：短打配麻绳腰带，臂力过人" },
  { keys: ["抬棺", "棺材铺"], dress: "抬棺人装束：黑衣黑布带，沉默寡言" },
  { keys: ["守墓"], dress: "守墓人装束：灰黑旧衣配灯笼，沉默阴郁" },
  { keys: ["书童"], dress: "书童装束：青布短衣配书箱，机灵乖巧" },
  { keys: ["琴师"], dress: "琴师装束：素色长衫，手抚古琴" },
  { keys: ["棋士", "棋手"], dress: "棋士装束：长衫配折扇，气定神闲" },
  { keys: ["茶博士", "茶馆"], dress: "茶博士装束：长衫配长嘴铜壶，滴水不漏" },
  { keys: ["酒保", "酒肆"], dress: "酒保装束：短衣配抹布，肩搭汗巾" },
  { keys: ["店小二", "小二"], dress: "店小二装束：短衣配搭巾，吆喝麻利" },
  { keys: ["厨子", "掌勺"], dress: "厨子装束：围裙配袖套，颠勺利落" },
  { keys: ["风水", "堪舆"], dress: "风水师装束：中式长衫配罗盘，玄之又玄" },
  { keys: ["方士"], dress: "方士装束：宽袍配拂尘，仙风道骨" },
  { keys: ["居士"], dress: "居士装束：素袍配念珠，清心寡欲" },
  { keys: ["说书"], dress: "说书人装束：长衫配醒木，嗓音洪亮" },
  { keys: ["里正", "地保", "保长"], dress: "里正装束：布衣配木杖，村中长者" },
  { keys: ["牙人", "牙行"], dress: "牙人装束：长衫配算盘，精明圆滑" },
  { keys: ["讼师", "状师"], dress: "讼师装束：青灰长衫配纸扇，能言善辩" },
  { keys: ["暗卫", "死士"], dress: "暗卫装束：夜行玄衣，低调迅捷" },
  { keys: ["禁军", "御林军", "羽林"], dress: "禁军甲胄：金甲或玄甲，持戟肃立" },
  { keys: ["传令兵", "斥候", "探子"], dress: "传令兵装束：轻装快马，腰挎令旗" },
];
const IDENTITY_DRESS_FALLBACK = ""; // 未匹配到身份服饰：仅用时代底衣

/** 身份服饰造型锚点（纯函数零 LLM）：按角色身份/职业返回标识性服饰/配饰；未匹配返回空串（仅用时代底衣） */
export function identityDress(c: Character): string {
  const hay = `${c.identity ?? ""} ${c.role ?? ""} ${c.name ?? ""}`;
  for (const r of IDENTITY_DRESS_RULES) {
    if (r.keys.some((k) => hay.includes(k))) return r.dress;
  }
  return IDENTITY_DRESS_FALLBACK;
}

/** 时代服饰造型锚点（纯函数零 LLM）：把 setting.time 硬转换为服饰/发型指令，头像/立绘/分镜上下文共用，保证全书年代统一 */
export function eraDress(w: WorldState): string {
  const hay = `${w.setting?.time ?? ""} ${w.setting?.place ?? ""} ${w.genre ?? ""}`;
  for (const r of ERA_DRESS_RULES) {
    if (r.keys.some((k) => hay.includes(k))) return r.dress;
  }
  return ERA_DRESS_FALLBACK;
}

/** 全书画风锚点（图/视频 prompt 共用，保证跨媒介风格一致） */
export function styleAnchor(w: WorldState): string {
  const hay = `${w.genre ?? ""} ${w.setting?.tone ?? ""} ${w.setting?.time ?? ""}`;
  for (const r of STYLE_RULES) {
    if (r.keys.some((k) => hay.includes(k))) return r.style;
  }
  return STYLE_FALLBACK;
}

/** 风格后缀强制拼接：prompt 缺画风锚点签名则追加（用户改词重生成同样生效），并保证无文字/无水印要求 */
export function ensureStyleSuffix(prompt: string, styleAnchorPhrase: string): string {
  const appendNoText = (p: string) =>
    p.includes("无水印") || p.toLowerCase().includes("no watermark") ? p : `${p}，画面中不要出现文字，无水印`;
  const p = prompt.trim().replace(/[，,\s]+$/, "");
  if (!p) return appendNoText(styleAnchorPhrase);
  const signature = styleAnchorPhrase.split("，")[0]?.split(",")[0]?.trim() ?? "";
  if (!signature || p.includes(signature)) return appendNoText(p);
  return appendNoText(`${p}，${styleAnchorPhrase}`);
}

/**
 * 场景人数守卫子句（纯函数，可单测）：按 scene 中出现的角色名数量生成消歧约束，帮助弱生图模型
 * 正确理解多人/单人状态归属（根治「两人画面里状态只修饰一人」「单人参考图被复制成多个」类幻觉）。
 * - 出现 ≥2 个角色名：追加「画面中共 N 人（名单），各自状态/动作按描述一一对应，禁止名单外人物」；
 * - 恰好 1 个角色名：追加「画面中仅该角色一人，不得出现其他人物，禁止分身」；
 * - 0 个角色名（纯环境场景）：返回 "" 不追加。
 * roster 为角色名册（只识别名册内名字，避免服饰/物件词误当角色）；仅按 scene 判断，不受 charHint 影响。
 */
export function sceneGuardClause(scene: string, roster: string[]): string {
  const names = roster.filter((n) => n && scene.includes(n));
  if (names.length >= 2) return `。画面中共 ${names.length} 人（${names.join("、")}），各自状态与动作按上述描述一一对应，不得出现名单之外的额外人物，禁止复制分身`;
  if (names.length === 1) return `。画面中仅 ${names[0]} 一人，不得出现任何其他人物，禁止分身`;
  return "";
}

/**
 * i2i（图生图）保持前缀（纯函数，可单测）：按官方 agnes-image-2.1-flash Prompting Guide 的 i2i 结构
 * `[Change Request] + [Elements to Preserve]`，显式告诉模型参考图要"保持"什么--否则幻觉大、理解差的
 * 模型会换人/变样貌/照搬参考图场景。前缀置顶（弱模型对句首注意力最强，保持人物身份是首要约束），
 * 后接原 T2I 提示词作为"按此重绘/生成"的 Change 部分。
 *
 * - portrait：旧立绘作容貌基准，保持面部/发型/身形/整体形象，背景改纯色，不照搬参考图背景
 * - avatar：立绘作容貌基准，保持面部/发型/神态，裁切为正面头像
 * - scene：参考图作画面主体样貌基准，保持人物形象，不照搬参考图场景与构图
 */
export function i2iPreservePrefix(target: "portrait" | "avatar" | "scene", name?: string): string {
  const nm = name ? `「${name}」` : "";
  if (target === "portrait") {
    return `以参考立绘为角色${nm}的容貌基准，严格保持面部五官、发型、身形与整体人物形象与参考图一致（容貌延续，不得改变样貌或换人）；参考图仅作人物样貌依据，背景须改为干净的纯色背景，不照搬参考图背景。按以下要求重绘全身立绘：\n`;
  }
  if (target === "avatar") {
    return `以参考立绘为容貌基准，严格保持面部五官、发型、神态与参考立绘一致（容貌延续，不得改变样貌或换人）；参考立绘仅作人物样貌依据，背景须改为干净的纯色背景。按以下要求呈现正面头像特写：\n`;
  }
  return `参考图仅作为画面主体的样貌参考（面部五官、发型、服饰、身形），画面中该角色须与参考图保持一致，不得改变样貌或换人；若画面描述出现多个角色，参考图人物在画面中只能出现一次，其余角色须按文字描述另行绘制，严禁复制或复用参考图人物形象（禁止分身）；每个角色只能出现一次；不得照搬参考图的场景与构图，按以下描述生成新画面：\n`;
}

// —— 分镜上下文：人物形象（外貌锚点词）+ 人物状态 + 场景素材（不注入媒体 prompt，仅供分镜 LLM 理解） ——
/** 组装分镜上下文：出场角色外貌/状态、时代地点基调、世界规则、本章计划、画风锚点（全部截断控量） */
export function planContext(w: WorldState, chapterIndex: number): string {
  const ch = w.chapters.find((c) => c.index === chapterIndex);
  const text = ch?.text ?? "";
  const summary = (w.chapterSummaries ?? []).find((s) => s.index === chapterIndex);
  // 出场角色：优先章摘要 appeared，其次角色名在正文匹配，再兜底取前 4 人
  const appearedNames = new Set(summary?.appeared ?? []);
  let cast = w.characters.filter((c) => appearedNames.has(c.name));
  if (!cast.length) {
    cast = w.characters
      .filter((c) => !c.exit || c.exit.chapter >= chapterIndex)
      .filter((c) => text.includes(c.name));
  }
  if (!cast.length) cast = w.characters.slice(0, 4);
  cast = cast.slice(0, 4);

  const lines: string[] = [];
  lines.push(`故事梗概：${(w.premise ?? "").slice(0, 80)}`);
  lines.push(`时代/地点/基调：${w.setting.time || "—"} / ${w.setting.place || "—"} / ${w.setting.tone || "—"}`);
  if (w.current) lines.push(`当前全局状态：${w.current}`);
  lines.push(`时代服饰造型（画面中所有人物必须按此装束与发型，不得出现其他年代服饰）：${eraDress(w)}，无现代元素；人物一律着素色常服或官署制服，不出现任何帝王权贵纹样服饰`);
  const rules = (w.setting.rules ?? []).slice(0, 3);
  if (rules.length) lines.push(`世界规则：${rules.join("；")}`);
  if (cast.length) {
    lines.push("本章出场角色（外貌锚点词与当前状态；同一角色的外貌描述在各画面中必须逐字一致）：");
    for (const c of cast) {
      const looks = c.traits.slice(0, 4).join("、") || "结合时代设定合理推演";
      const idDress = identityDress(c);
      // 只注入“处境”（剧情参考）；不注入 look 形象——历史教训：look 是本章之前的结算状态，
      // 与所选段落可能不同时点，注入后会被 LLM 当外貌锚点词串场（如“脸色惨白”出现在无此描写的段落）
      lines.push(`- ${c.name}（${c.role}）：性别 ${c.gender || "未知"}，年龄 ${c.age || "未知"}，身份 ${c.identity || "—"}${idDress ? `，身份服饰 ${idDress}` : ""}；外貌特征 ${looks}${c.status ? `；当前处境（仅剧情参考，禁止写入画面外貌/服饰/动作，除非所选段落明确交代）：${c.status}` : ""}`);
    }
  }
  const plan = (w.chapterPlans ?? []).find((p) => p.index === chapterIndex);
  if (plan) lines.push(`本章计划：${plan.goal}${plan.beats.length ? `；关键节拍：${plan.beats.slice(0, 3).join("；")}` : ""}`);
  lines.push(`全书画风锚点（scene 的风格段必须引用）：${styleAnchor(w)}`);
  return lines.join("\n");
}

/** 立绘条目适配为 ChapterMedia（供 mediaDataUri 读文件） */
function portraitAsMedia(c: Character): ChapterMedia | undefined {
  if (!c.portrait?.path) return undefined;
  return { id: c.portrait.mediaId, kind: "image", anchor: c.name, prompt: c.portrait.prompt, path: c.portrait.path, status: "ready" };
}

/** 角色参考图（插画图生图用）：优先全局立绘（视觉唯一基准），其次 ≤ 当前章按角色名匹配的 ready 插画。
 * subject（画面主体角色名）非空时：主体角色立绘绝对优先，避免多角色场景下参考图错配把主体带偏。 */
export function findCharacterRef(w: WorldState, chapterIndex: number, anchor: string, subject?: string): ChapterMedia | undefined {
  const names = w.characters.filter((c) => c.name && anchor.includes(c.name)).map((c) => c.name);
  if (subject) {
    const sc = w.characters.find((c) => c.name === subject);
    if (sc?.portrait?.path) return portraitAsMedia(sc);
  }
  if (!names.length) return undefined;
  const portrait = w.characters.filter((c) => names.includes(c.name)).map(portraitAsMedia).find(Boolean);
  if (portrait) return portrait;
  let best: ChapterMedia | undefined;
  let bestIdx = -1;
  for (const ch of w.chapters) {
    if (ch.index > chapterIndex) continue;
    for (const m of ch.media ?? []) {
      if (m.kind !== "image" || m.status !== "ready" || !m.path) continue;
      const hay = `${m.anchor} ${m.caption ?? ""} ${m.prompt ?? ""}`;
      if (!names.some((n) => hay.includes(n))) continue;
      if (ch.index >= bestIdx) { best = m; bestIdx = ch.index; }
    }
  }
  return best;
}

/** i2v 首帧查找：按 anchor 归一化匹配该章已就绪插画（视频以插画为首帧，人物/构图天然继承） */
export function findAnchorImage(w: WorldState, chapterIndex: number, anchor: string): ChapterMedia | undefined {
  const ch = w.chapters.find((x) => x.index === chapterIndex);
  const imgs = (ch?.media ?? []).filter((m) => m.kind === "image" && m.status === "ready" && m.path);
  const na = normAnchor(anchor);
  if (na.length < 4) return undefined;
  return imgs.find((m) => normAnchor(m.anchor) === na)
    ?? imgs.find((m) => normAnchor(m.anchor).includes(na) || na.includes(normAnchor(m.anchor)));
}

/** i2v 首帧级联查找：同段落锚点插画 → 场景主体角色全局立绘（人物样貌基准）→ 跨章（≤当前章）角色插画取最近一章，
 * 保证同一人物在不同章节的插画/视频中样貌一致，风格由首帧图 + 画风锚点双重把控；subject 优先主体立绘 */
export function findVideoFirstFrame(w: WorldState, chapterIndex: number, anchor: string, subject?: string): ChapterMedia | undefined {
  const byAnchor = findAnchorImage(w, chapterIndex, anchor);
  if (byAnchor) return byAnchor;
  if (subject) {
    const sc = w.characters.find((c) => c.name === subject);
    if (sc?.portrait?.path) return portraitAsMedia(sc);
  }
  const names = w.characters.filter((c) => c.name && anchor.includes(c.name)).map((c) => c.name);
  if (!names.length) return undefined;
  const portrait = w.characters.filter((c) => names.includes(c.name)).map(portraitAsMedia).find(Boolean);
  if (portrait) return portrait;
  let best: ChapterMedia | undefined;
  let bestIdx = -1;
  for (const ch of w.chapters) {
    if (ch.index > chapterIndex) continue;
    for (const m of ch.media ?? []) {
      if (m.kind !== "image" || m.status !== "ready" || !m.path) continue;
      const hay = `${m.anchor} ${m.caption ?? ""} ${m.prompt ?? ""}`;
      if (!names.some((n) => hay.includes(n))) continue;
      if (ch.index >= bestIdx) { best = m; bestIdx = ch.index; }
    }
  }
  return best;
}

/** 媒体文件 → Data URI（图生图/图生视频的 extra_body.image / image 入参） */
export function mediaDataUri(storyTitle: string, m: ChapterMedia): string | undefined {
  if (!m.path) return undefined;
  const buf = readImage(storyTitle, m.path);
  if (!buf) return undefined;
  const ext = m.path.slice(m.path.lastIndexOf(".") + 1).toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
}

/** 生成角色全局立绘：中文提示词 = 外貌特征（traits/可选 description）+ 时代服饰（eraDress）+ 全书画风锚点；
 * 参考图优先级：旧立绘自身（重生成容貌延续，noOldRef 时跳过）> 该角色章节插画。头像（c.image）仅供用户查看，AI 不读（头像会反向参考立绘）。
 * 硬约束：尺寸定死 1K 档 736x1312（ratio 9:16 竖版全身像）；背景统一纯色；禁帽子；性别特征鲜明。
 * 返回 { mediaId, path, prompt, looks }，由调用方落盘到 character.portrait；落盘为 JPEG（体积小巧）；looks 供前端重生成时预填 */
export async function generateCharacterPortrait(storyTitle: string, w: WorldState, c: Character, opts: { description?: string; noOldRef?: boolean } = {}): Promise<{ mediaId: string; path: string; prompt: string; looks: string }> {
  const desc = opts.description?.trim();
  const looks = desc || c.traits.slice(0, 4).join("、");
  const baseAttrs = `性别 ${c.gender || "未知"}，年龄 ${c.age || "未知"}，身份 ${c.identity || "—"}`;
  const idDress = identityDress(c);
  const base = `《${w.title}》角色「${c.name}」（${c.role}）的全身立绘：${baseAttrs}；外貌特征 ${looks || "结合角色姓名与身份推演"}，面容气质需呈现明确的性别特征（男女形象区分鲜明）；时代背景 ${w.setting.time || "—"}、地点 ${w.setting.place || "—"}，时代服饰：${eraDress(w)}，无现代元素${idDress ? `；身份服饰：${idDress}${c}` : ""}；不戴任何帽子；背景为干净的纯色背景（单一色调，无场景、无图案、无文字）；单人全身像，正面或略侧身，面向观者，神情姿态符合其身份与当前状态，竖版全身构图`;
  const t2iPrompt = ensureStyleSuffix(base, styleAnchor(w));
  // i2i 形态（参考图作容貌基准，保持人物形象）：官方 i2i 结构 [保持]+[改变]，避免弱模型换人/变样貌
  const i2iPrompt = i2iPreservePrefix("portrait", c.name) + t2iPrompt;
  // 参考图：默认旧立绘自身（容貌延续）；noOldRef 时跳过全部参考图按新提示词纯文生重画；不读头像（头像仅作展示）
  let ref: string | undefined;
  if (!opts.noOldRef && c.portrait?.path) ref = mediaDataUri(storyTitle, { id: c.portrait.mediaId, kind: "image", anchor: c.name, path: c.portrait.path, status: "ready" });
  if (!opts.noOldRef && !ref) {
    for (const ch of w.chapters) {
      const m = (ch.media ?? []).find((x) => x.kind === "image" && x.status === "ready" && x.path && `${x.anchor} ${x.caption ?? ""}`.includes(c.name));
      if (m) { ref = mediaDataUri(storyTitle, m); break; }
    }
  }
  let buf: Uint8Array;
  if (ref) {
    try {
      buf = await generateImage(i2iPrompt, "736x1312", { images: [ref] });
    } catch (e) {
      console.warn("[media] 立绘参考图生图失败，降级纯文生图:", (e as Error).message);
      buf = await generateImage(t2iPrompt, "736x1312");
    }
  } else {
    buf = await generateImage(t2iPrompt, "736x1312");
  }
  // 压缩为 JPEG：立绘体积尽可能小巧（定死 736x1312 竖版 9:16），失败时保留原图
  let compressed = buf;
  try {
    compressed = await compressToJpeg(buf, 736, 1312);
  } catch (e) {
    console.warn("[media] 立绘压缩失败，保留原图:", (e as Error).message);
  }
  const name = `portrait-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.jpg`;
  const path = saveImage(storyTitle, name, compressed);
  return { mediaId: mediaId(), path, prompt: t2iPrompt, looks: looks || "" };
}

/** 生成角色头像（仅供用户查看，AI 不读）：中文提示词 = 外貌特征 + 时代服饰（eraDress）+ 全书画风锚点 + 方形 1:1，压缩为小体积 JPEG；
 * refImage 非空时图生图（传立绘作参考，保证头像与立绘容貌一致），失败降级纯文生 */
export async function generateCharacterAvatar(storyTitle: string, w: WorldState, c: Character, opts: { refImage?: string } = {}): Promise<{ path: string; prompt: string }> {
  const looks = c.traits.slice(0, 4).join("、");
  const baseAttrs = `性别 ${c.gender || "未知"}，年龄 ${c.age || "未知"}，身份 ${c.identity || "—"}`;
  const idDress = identityDress(c);
  const t2iPrompt = `${c.name}（${c.role}）的方形头像：${baseAttrs}；外貌特征 ${looks || "结合角色姓名与身份推演"}，面容气质需呈现明确的性别特征（男女形象区分鲜明）；时代背景 ${w.setting.time || "—"}，时代服饰：${eraDress(w)}，无现代元素${idDress ? `；身份服饰：${idDress}${c}` : ""}；不戴任何帽子；背景为干净的纯色背景（单一色调，无场景、无图案、无文字）；正面头像特写，面向观者，神情姿态符合其身份，${styleAnchor(w)}，画面中不要出现文字，无水印`;
  const i2iPrompt = i2iPreservePrefix("avatar") + t2iPrompt;
  let buf: Uint8Array;
  if (opts.refImage) {
    try {
      buf = await generateImage(i2iPrompt, "768x768", { images: [opts.refImage] });
    } catch (e) {
      console.warn("[media] 头像参考图生图失败，降级纯文生:", (e as Error).message);
      buf = await generateImage(t2iPrompt, "768x768");
    }
  } else {
    buf = await generateImage(t2iPrompt, "768x768");
  }
  let compressed = buf;
  try {
    compressed = await compressToJpeg(buf, 384, 384, 80);
  } catch (e) {
    console.warn("[media] 头像压缩失败，保留原图:", (e as Error).message);
  }
  const name = `avatar-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.jpg`;
  return { path: saveImage(storyTitle, name, compressed), prompt: t2iPrompt };
}

// —— 分镜系统提示词：忠于正文 + 官方提示词结构（agnes-image-2.1-flash Prompting Guide）+ 分型策略 ——
// scene 结构对齐官方：[主体]+[场景/环境]+[风格]+[光照]+[构图]+[质量要求]；条款精简去重，降低思考负担
function planSystem(kind: "image" | "video"): string {
  const structure = kind === "image"
    ? "[主体]+[场景/环境]+[风格]+[光照]+[构图]+[质量要求]（生图模型官方推荐结构，逐项写全）"
    : "[主体]+[动作]+[场景]+[镜头运动]+[光线]+[风格]（写明镜头如何运动、哪些元素保持稳定）";
  const medium = kind === "image" ? "生图" : "生视频";
  return `你是小说的"分镜师"。给定一章正文与创作上下文，从中挑选最具画面感的关键段落，并为每个段落转写一句用于 AI ${medium}的电影化中文视觉提示词。

【anchor：逐字复制，不得改写】
- anchor 必须是正文某段落的连续原文片段（12~40 字）：直接从正文【复制】整句，一字不改（不改写、不换序、不合并、不增删）。
- 正文写“一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去”，anchor 就照抄原句；不得重排成“柳青霜用白布蘸去沈夜唇角溢出的黑血”这类改写句。
- 改写的 anchor 会与正文失配，整个场景将被丢弃，请严格复制。

【scene：转写而非摘抄，忠于正文】
- scene 是你综合理解情节后【转写】出的视觉描述，严禁直接摘抄或拼接正文原文。
- 画面元素（人物、人数、动作、物件、冲突）必须能在所选 anchor 段落本身的正文中溯源；紧邻上下文（前后各一段落）仅用于理解动作对象与氛围，严禁引入其人物、状态或动作（例：段落只写沈夜被锁于刑架，紧邻段落写魏无咎走出——scene 只能画沈夜一人被锁）。
- 人物数量以所选段落正文明确交代为准：段落只写一人 → scene 只画该一人，严禁加入任何其他人物；段落写多人 → scene 画同样人数并写明「画面共 N 人」，逐人写明状态/动作且归属不得混淆（例：「沈夜被铁链锁于刑架，魏无咎立于阴影中」——锁链与受刑状态仅属于沈夜）；正文未明确人数 → 单人特写/近景构图。
- 服饰只用上下文给出的【身份服饰/时代服饰造型】或正文明写描写；未给出身份服饰的角色着时代素色常服，严禁套用其他角色的服饰。
- subject：画面主体角色名（动作施动者或视觉焦点角色；必须来自上下文角色名册；纯环境场景可省略）。

【语义精度：动作链完整，主客归属正确】
- 每个动作写全【施动者—方式/工具—动作—受事宾语】；“用某物+动词+宾语”句式必须保留方式状语并写全宾语及位置来源。
- 去除类动作（蘸去/拭去/擦去/抹去/揩去/舐去）必须带明确受事宾语，不得以这类动词结尾：正文「柳青霜用白布蘸去」→ scene 写「柳青霜用白布蘸去沈夜唇角的黑血」。
- 主客体与正文逐字核对不得颠倒；每个出场角色标注性别并引用上下文外貌锚点词，性别不得错配。
- 名词具体化（具体人物/服饰/器物），禁止泛化的“一个人”。

【分型策略：type 判定，优先级 事件 > 人物 > 场景】
- 段落含明确动作情节（谁在做什么），一律判「事件」：人物（点名+外貌锚点词）+精确动作+具体场景三者俱全。
- 仅静态人物呈现（无动作情节）判「人物」：特写/半身构图，背景简写。
- 仅环境描写判「场景」：以环境为主体，刻画地点、时代风貌、光线与空间纵深。

【格式要求】
- scene 用中文，一句话写完，控制在 100 字内，遵循结构：${structure}。
- 出现角色时点名并引用外貌锚点词（同一角色在整句 scene 中只点名一次；多场景中同一角色的外貌描述逐字一致）；每个角色在画面中只能出现一次，严禁复制分身或凭空增加同面孔人物；不得把上下文的“当前状态/当前形象”当外貌锚点词写入，除非所选段落明确写到。
- scene 的风格段必须引用上下文给出的全书画风锚点；scene 结尾附“画面中不要出现文字，无水印”。
- caption：一句中文画面说明（谁、什么状态、在做什么/发生什么）。
- 挑选的段落应彼此不同、覆盖本章关键情景。
- 输出必须是合法 JSON（不要 markdown 围栏）：{"scenes":[{"anchor":"段落原文片段","scene":"转写后的中文视觉描述","caption":"中文画面说明","type":"人物/场景/事件","subject":"主体角色姓名或省略"}]}
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;
}


/**
 * 分镜场景归一化（纯函数，可单测）：校验 LLM 输出 → 过滤 anchor 失配 → 去重（含跨轮排除）→ subject 校验。
 * 不做数量补齐、不用模板凑数：每个场景必须是 LLM 真实转写；数量不足由 planScenes 循环调用 LLM 补充。
 */
export function normalizeScenePlans(
  raw: (ScenePlan & { type?: string })[],
  w: WorldState,
  chapterIndex: number,
  n: number,
  /** 已选用 anchor 集合（跨次已有媒体 + 跨轮已选；原文或归一化均可，内部归一化）；用于精确去重与段落级去重 */
  excludeAnchors: string[] = [],
): ScenePlan[] {
  const ch = w.chapters.find((c) => c.index === chapterIndex);
  if (!ch) return [];
  const nText = normAnchor(ch.text);
  const roster = new Set(w.characters.map((c) => c.name).filter(Boolean));
  const excluded = new Set(excludeAnchors.map(normAnchor));
  const seen = new Set<string>();
  const scenes: ScenePlan[] = [];
  const paras = ch.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const paraTexts = paras.map(normAnchor);
  // 段落级去重：同段落不同切法归一化串不同，会绕过上面的精确去重（实测「蘑菇血段」长短切片都被选中）；
  // 按 anchor 所在段落索引去重，excludeAnchors（跨次/跨轮已选段落）与本轮已采用段落都计入占用集合
  const paraIdxOf = (a: string): number => {
    const na = normAnchor(a);
    return na.length < 4 ? -1 : paraTexts.findIndex((pt) => pt.includes(na));
  };
  const excludedParaIdx = new Set<number>();
  for (const a of excludeAnchors) {
    const idx = paraIdxOf(a);
    if (idx >= 0) excludedParaIdx.add(idx);
  }
  const usedParaIdx = new Set<number>();
  for (const s of raw) {
    const anchor = String(s?.anchor ?? "").trim();
    const scene = String(s?.scene ?? "").trim();
    const na = normAnchor(anchor);
    if (!anchor || !scene || na.length < 4) continue;
    // anchor 归一化精确匹配优先；失配时字符袋模糊匹配（容忍 LLM 换序/轻改写），命中则回填正文原文片段
    let finalAnchor = anchor;
    if (!nText.includes(na)) {
      const matched = fuzzyMatchAnchor(ch.text, na);
      if (!matched) continue;
      finalAnchor = matched;
    }
    const nfa = normAnchor(finalAnchor);
    if (seen.has(nfa) || excluded.has(nfa)) continue;
    const anchorParaIdx = paraTexts.findIndex((pt) => pt.includes(nfa));
    // 段落级去重：同段落已被 excludeAnchors（跨次已有媒体/跨轮已选）或本轮选用 -> 丢弃
    // （防同段不同切法绕过精确去重，如「蘑菇血段」长短切片重复）
    if (anchorParaIdx >= 0 && (excludedParaIdx.has(anchorParaIdx) || usedParaIdx.has(anchorParaIdx))) {
      console.warn(`[media/plan] 段落重复拦截: scene="${scene.slice(0, 50)}" 所在段落#${anchorParaIdx} 已被选用，已丢弃`);
      continue;
    }
    seen.add(nfa);
    if (anchorParaIdx >= 0) usedParaIdx.add(anchorParaIdx);
    const t = String(s?.type ?? "").trim();
    const subj = String(s?.subject ?? "").trim();
    const extraChars = sceneCharAudit(w, chapterIndex, finalAnchor, scene);
    scenes.push({
      anchor: finalAnchor,
      scene,
      caption: String(s?.caption ?? "").trim() || finalAnchor.slice(0, 30),
      type: t === "人物" || t === "场景" || t === "事件" ? t : "事件",
      subject: subj && roster.has(subj) ? subj : undefined,
      extraChars: extraChars.length ? extraChars : undefined,
    });
    if (scenes.length >= n) break;
  }
  return scenes;
}

/**
 * 让 LLM 从章节正文挑选 count 个关键段落并转写视觉描述（循环分镜，失败自动重试 3 次，不做模板降级）：
 * - 每轮让 LLM 输出剩余数量的场景，并附已选段落防重复；不足 n 时自动追加一轮（选 2/3 张 ≈ 连续多次“生成一张”的分镜合并，更快）
 * - 失败语义：单次尝试失败（空内容/超时/JSON 错/无有效场景）自动重试，最多 3 次（800ms 指数退避）；3 次均失败才抛错；
 *   已有部分场景时直接返回已收集的 LLM 场景（部分成功不重试）
 */
export async function planScenes(
  w: WorldState,
  chapterIndex: number,
  kind: "image" | "video",
  count: number,
): Promise<ScenePlan[]> {
  const ch = w.chapters.find((c) => c.index === chapterIndex);
  if (!ch) throw new Error("章节不存在");
  const n = kind === "video" ? 1 : Math.max(1, Math.min(3, count));
  // 跨次去重：读取该章已有同 kind 媒体的 anchor 作为排除集，防 LLM 重复挑同一段落
  // （含同段不同切法，由 normalizeScenePlans 段落级去重兜底）
  const existingAnchors = (ch.media ?? []).filter((m) => m.kind === kind).map((m) => m.anchor);
  const t0 = Date.now(); // 分镜耗时统计
  let lastErr: Error | null = null;
  let emptyCount = 0; // 空内容/渠道繁忙类失败计数（诊断与文案用）
  for (let retry = 0; retry < 3; retry++) {
    try {
      const scenes = await planScenesOnce(w, ch, kind, n, existingAnchors);
      if (scenes.length) {
        console.log(`[media/plan] 分镜完成（${kind}）：${scenes.length}/${n} 个场景，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${retry ? `（第 ${retry + 1} 次尝试成功）` : ""}`);
        return scenes;
      }
      lastErr = new Error("分镜未产出有效场景（LLM 输出无法匹配正文）");
    } catch (e) {
      lastErr = e as Error;
      if (lastErr.message.includes("空内容") || lastErr.message.includes("繁忙")) emptyCount++;
    }
    console.warn(`[media/plan] 分镜失败（第 ${retry + 1}/3 次）：${lastErr.message}${retry < 2 ? `，${800 * (retry + 1)}ms 后自动重试` : "，3 次均失败"}${emptyCount ? `（空内容/繁忙 ${emptyCount} 次）` : ""}`);
    if (retry < 2) await Bun.sleep(800 * (retry + 1)); // 指数退避
  }
  // 3 次均失败：渠道类（空内容/繁忙）给出明确文案，其余透传原始错误
  if (emptyCount) throw new Error("分镜失败：AI 服务暂时无输出（免费渠道繁忙），已自动重试 3 次，请稍后重试");
  throw lastErr ?? new Error("分镜失败，请重试");
}

/** 单次分镜尝试：循环让 LLM 补充剩余场景；首轮 LLM 失败抛错（由外层重试），已有部分场景时返回已收集的 */
async function planScenesOnce(w: WorldState, ch: Chapter, kind: "image" | "video", n: number, existingAnchors: string[] = []): Promise<ScenePlan[]> {
  const chapterIndex = ch.index;
  const scenes: ScenePlan[] = [];
  // 跨次去重：初始含该章已有媒体 anchor（让 LLM 避开已选段落）+ 本轮已选；存原文（LLM 消息可读，normalizeScenePlans 内部归一化）
  const usedAnchors: string[] = [...existingAnchors];
  const maxAttempts = n + 2; // 防失控：最多比目标多 2 轮
  for (let attempt = 0; scenes.length < n && attempt < maxAttempts; attempt++) {
    const remaining = n - scenes.length;
    // 候选池：每轮让 LLM 至少输出 3 个候选（单张也一次交互挑多处），供 normalize 去重后择优
    // （防 LLM 只挑最显眼同一句：首选与已选用段落重复时，第 2/3 候选兑底，避免补轮/失败）
    const candidate = Math.max(3, remaining);
    const userMsg = [
      `小说《${w.title}》（${w.genre || "未知题材"}）。`,
      `[创作上下文]\n${planContext(w, chapterIndex)}`,
      `第 ${chapterIndex} 章《${ch.title}》正文：`,
      ch.text,
      usedAnchors.length
        ? `\n注意：以下段落已被选用，请改选其他段落，严禁重复（同一段落内的其他句子也视为重复，不得再选）：\n${usedAnchors.map((a) => `- ${a}`).join("\n")}`
        : "",
      `\n请从中挑选 ${candidate} 个最具画面感的关键段落（候选数多于最终采用数，系统会择优），各转写一句电影化中文视觉描述（画面元素必须忠于正文，不得虚构外推），并给出中文 caption 与画面类型（只输出 JSON）。anchor 必须逐字摘抄正文原文（12~40 字连续片段），不得改写语序或合并句子。要求：1) 候选之间互不重复（不同段落）；2) 按画面感从强到弱排列（最强排最前，系统会优先采用靠前的候选）；3) 不得选择上面列出的已选用段落（同一段落内其他句子也视为重复，不得再选）。`,
    ].join("\n");
    let out: { scenes?: (ScenePlan & { type?: string })[] };
    try {
      out = await chatJson<{ scenes?: (ScenePlan & { type?: string })[] }>(
        [
          { role: "system", content: planSystem(kind) },
          { role: "user", content: userMsg },
        ],
        // 思考型模型预算：若文本模型为思考型（如 agnes-2.5-flash），reasoning 与正文共享 max_tokens（默认思考实测 1000~8000+，波动大），
        // 预算不足会空输出（finish_reason=length, text=0）或 JSON 截断；60000 给思考与多场景正文留足余量；
        // 实测成功 13~50s，超时 150s（内部 1 次重试预算）
        {
          temperature: 0.5,
          maxTokens: 60000,
          timeoutMs: 150_000,
          retries: 2,
          schema: {
            type: "object",
            required: ["scenes"],
            properties: {
              scenes: {
                type: "array",
                items: {
                  type: "object", required: ["anchor", "scene"],
                  properties: {
                    anchor: { type: "string" }, scene: { type: "string" },
                    caption: { type: "string" }, type: { type: "string", enum: ["人物", "场景", "事件"] },
                    subject: { type: "string" }, extraChars: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      );
    } catch (e) {
      if (scenes.length) break; // 已有部分场景：停止补充，返回已收集的 LLM 场景
      throw e; // 首轮失败：交由外层自动重试
    }
    const batch = normalizeScenePlans(Array.isArray(out.scenes) ? out.scenes : [], w, chapterIndex, remaining, usedAnchors);
    if (!batch.length && Array.isArray(out.scenes) && out.scenes.length) {
      // 诊断：全失配时打印每个场景的过滤原因（定位“无法匹配正文”根因）
      const nText = normAnchor(ch.text);
      for (const s of out.scenes) {
        const a = String(s?.anchor ?? "").trim();
        const sc = String(s?.scene ?? "").trim();
        const na = normAnchor(a);
        const reason = !a ? "anchor为空" : !sc ? "scene为空" : na.length < 4 ? `anchor过短(${na.length}字)` : !nText.includes(na) ? "归一化后不在正文中" : "与已选段落重复";
        console.warn(`[media/plan] 场景失配诊断: anchor="${a.slice(0, 50)}" sceneLen=${sc.length} normLen=${na.length} → ${reason}`);
      }
    }
    for (const s of batch) {
      scenes.push(s);
      usedAnchors.push(s.anchor); // 存原文（LLM 消息可读 + normalizeScenePlans 内部归一化）
    }
    if (!batch.length) break; // 本轮无新场景（全失配/重复）：停止，避免空转烧额度
  }
  return scenes;
}

export function mediaId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 媒体 anchor 失配检测（确定性零 LLM）：复刻 ChapterView 的归一化匹配（anchor≥4字且被任一段落包含即有效）。
 * 失配置 orphan=true，重新命中清 orphan（可逆）；返回失配媒体数。正文变更后由变更钩子调用。
 */
export function markOrphanMedia(ch: Chapter): number {
  const paras = ch.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).map(normAnchor);
  let orphans = 0;
  for (const m of ch.media ?? []) {
    const na = normAnchor(m.anchor);
    const matched = na.length >= 4 && paras.some((np) => np.includes(na));
    if (matched) {
      if (m.orphan) delete m.orphan; // 可逆：正文恢复后清除标记
    } else {
      m.orphan = true;
      orphans++;
    }
  }
  return orphans;
}

export type SceneMediaOpts = {
  caption?: string;
  sceneType?: SceneType;
  /** 角色参考图 Data URI：非空走图生图（人物形象一致），失败自动降级纯文生图 */
  refImage?: string;
  /** 全书画风锚点：非空时强制拼接（用户改词重生成同样生效） */
  styleAnchor?: string;
  /** 画面主体角色硬性描述（性别/年龄/身份/外貌/当前形象/身份服饰）：生成时强制拼入提示词，不依赖 LLM 转写；不写入 m.prompt（保持提示词可编辑） */
  charHint?: string;
  /** 当前章角色名册（人数守卫子句用）：非空时按 scene 出现角色数自动追加「共 N 人/仅一人」消歧，只影响生成、不写入 m.prompt */
  roster?: string[];
};

/** 生成插画（新文件名，cache-bust）。返回就绪的 image 媒体；prompt 存最终生效提示词（不含 charHint，供用户编辑）。
 * 落盘压缩为 JPEG（896x560 q82）：PNG 可达 1-2MB，JPEG 通常 100-250KB，保存/读取/作参考图上传均更快 */
export async function generateSceneImage(storyTitle: string, scene: string, anchor: string, opts: SceneMediaOpts = {}): Promise<ChapterMedia> {
  const prompt = opts.styleAnchor ? ensureStyleSuffix(scene, opts.styleAnchor) : scene;
  // 人数守卫子句：仅作用于生成（不进 m.prompt），按 scene 出现角色数消歧多人/单人状态归属
  const guard = opts.roster ? sceneGuardClause(scene, opts.roster) : "";
  const fullPrompt = (opts.charHint ? `${opts.charHint}${prompt}` : prompt) + guard;
  // i2i 形态：参考图作画面主体样貌基准，保持人物形象，不照搬参考图场景（官方 i2i [保持]+[改变] 结构）
  const i2iPrompt = i2iPreservePrefix("scene") + fullPrompt;
  let buf: Uint8Array;
  if (opts.refImage) {
    try {
      buf = await generateImage(i2iPrompt, "896x560", { images: [opts.refImage] });
    } catch (e) {
      console.warn("[media] 参考图生图失败，降级纯文生图:", (e as Error).message);
      buf = await generateImage(fullPrompt, "896x560");
    }
  } else {
    buf = await generateImage(fullPrompt, "896x560");
  }
  let compressed = buf;
  try {
    compressed = await compressToJpeg(buf, 896, 560);
  } catch (e) {
    console.warn("[media] 插画压缩失败，保留原图:", (e as Error).message);
  }
  const name = `ill-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.jpg`;
  const path = saveImage(storyTitle, name, compressed);
  return { id: mediaId(), kind: "image", anchor, prompt, caption: opts.caption, sceneType: opts.sceneType, path, status: "ready" };
}

export type SceneVideoOpts = SceneMediaOpts & {
  /** i2v 首帧 Data URI（对应段落插画）；非空走图生视频，人物/构图继承首帧 */
  image?: string;
  /** 目标时长秒数（缺省随机 5~15s；严格钳制 5~15） */
  durationSec?: number;
};

/** 创建视频任务（异步）。返回 pending 的 video 媒体；prompt 存最终生效提示词（不含 charHint） */
export async function createSceneVideo(scene: string, anchor: string, opts: SceneVideoOpts = {}): Promise<ChapterMedia> {
  const prompt = opts.styleAnchor ? ensureStyleSuffix(scene, opts.styleAnchor) : scene;
  // 人数守卫子句：仅作用于生成（不进 m.prompt）
  const guard = opts.roster ? sceneGuardClause(scene, opts.roster) : "";
  const fullPrompt = (opts.charHint ? `${opts.charHint}${prompt}` : prompt) + guard;
  const durationSec = opts.durationSec ?? VIDEO_MIN_SECONDS + Math.floor(Math.random() * (VIDEO_MAX_SECONDS - VIDEO_MIN_SECONDS + 1));
  const task = await createVideoTask(fullPrompt, { image: opts.image, numFrames: durationToNumFrames(durationSec) });
  return { id: mediaId(), kind: "video", anchor, prompt, caption: opts.caption, sceneType: opts.sceneType, videoId: task.videoId, status: "pending" };
}
