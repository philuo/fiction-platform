// 主界面：启动页（立项）→ 创作游戏界面（日式报纸 HUD + 完整控制面板）
// 交互：立项一句话 / 指令输入 / 抽卡筛选 / 世界观·设定·角色·大纲编辑 / 章节段落编辑 / 推进
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpen, ChevronDown, Dices, History, MoreHorizontal, PenLine, Play, Search, Sparkles, Users, Video, Wand2, X } from "../components/icons";
import type { Card, Chapter, LoreEntry, ReviewResult, WorldPatch, WorldState } from "../api/world";
import { Masthead } from "../components/Masthead";
import { StatusPanel } from "../components/StatusPanel";
import { ChapterView } from "../components/ChapterView";
import { ReviewPanel, scrollToCitation } from "../components/ReviewPanel";
import { GachaModal } from "../components/GachaModal";
import { SettingsModal } from "../components/SettingsModal";
import { RelationshipModal } from "../components/RelationshipModal";
import { LeftPanel } from "../components/LeftPanel";

export type HomeProps = {
  url?: string;
  initialData?: { world?: WorldState; serverTime?: string; ssr?: boolean };
};

type Phase = "landing" | "playing";

type StoryMeta = { slug: string; title: string; genre: string; chapters: number; updatedAt: string; cover?: string };

// 流派模板：点选一键填充灵感与题材（M8 增强）
const GENRE_TEMPLATES: { name: string; genre: string; idea: string }[] = [
  { name: "古风悬疑", genre: "古风悬疑", idea: "明朝末年，一个小捕快能梦见未来的凶案现场，但梦里总是看不清凶手的脸。" },
  { name: "种田", genre: "种田", idea: "荒年流民少女带着前世农学知识，靠一亩薄田在乱世里养活了整个村子，却被县衙盯上了她的粮仓。" },
  { name: "修仙", genre: "修仙", idea: "宗门杂役弟子捡到一枚会说话的剑丸，剑丸说他是上古剑仙转世，但前世欠下的因果债，正一笔笔找上门来。" },
  { name: "克苏鲁", genre: "克苏鲁", idea: "海边小镇的灯塔看守人发现一条规律：每逢大雾，海底会浮出不属于这个时代的船，而船上的人全都认识他。" },
  { name: "恐怖", genre: "恐怖", idea: "老屋的墙上每晚都会多出一行字，字迹属于三十年前失踪的房主，而最后一行的日期，是明天。" },
  { name: "穿越", genre: "穿越", idea: "现代法医穿越到古代刑狱司，用解剖学破获连环命案，却发现凶手的作案手法来自未来。" },
  { name: "历史权谋", genre: "历史权谋", idea: "寒门书生意外救下微服私访的太子，从此卷入九子夺嫡，每走一步都踩在刀尖上。" },
  { name: "悬疑推理", genre: "悬疑推理", idea: "刑侦专家调任小城后，发现这里的每起命案都完美复刻他十年前破获的悬案，而真凶就在警队内部。" },
  { name: "言情", genre: "言情", idea: "女心理师与男刑警在双胞胎失踪案里相遇，她的职业本能告诉她他在说谎，他的直觉告诉她她就是突破口。" },
  { name: "宫斗", genre: "宫斗", idea: "打入冷宫的废妃靠着预知梦重新得宠，却发现自己每走一步都在为皇后铺路。" },
  { name: "系统流", genre: "系统流", idea: "咸鱼上班族意外绑定「签到系统」，在菜市场签到得到武功秘籍，在公司门口签到得到藏宝图。" },
  { name: "无限流", genre: "无限流", idea: "深夜便利店员工被拉入「无限游戏」，第一个副本是《消失的306宿舍》，而他的室友早在十年前就毕业了。" },
  { name: "星际", genre: "星际", idea: "垃圾星拾荒者捡到一艘坠毁的旧战舰，舰载 AI 开口第一句话是：将军，您失忆的第七年，帝国已经易主了。" },
  { name: "体育竞技", genre: "体育竞技", idea: "退役的乒乓球天才在夜市摆摊，靠一手削球吊打全城球馆，直到国家队教练找上门。" },
  { name: "美食", genre: "美食", idea: "祖传菜馆倒闭后，落魄厨师用一碗蛋炒饭救活了整条老街，也引来了那个说要收购整条街的神秘食客。" },
  { name: "娱乐圈", genre: "娱乐圈", idea: "过气歌手在直播平台翻红，一首歌把十年前的黑料唱上热搜，经纪公司连夜报警。" },
  { name: "盗墓", genre: "盗墓", idea: "考古系学生收到爷爷的遗物古卷，上面画着一座不存在于任何地图上的古墓，而爷爷的死因写着：自然死亡。" },
  { name: "科幻", genre: "科幻", idea: "近未来，人类首次发现记忆可以被转录到云端，却有人在别人的记忆里看到了自己的谋杀。" },
  { name: "武侠", genre: "武侠", idea: "一个不会武功的账房先生，凭一本错漏百出的武功秘籍，卷入江湖第一门派的灭门谜案。" },
  { name: "都市怪谈", genre: "都市怪谈", idea: "深夜便利店店员发现，每个来买关东煮的客人，都恰好是三天后新闻里的失踪者。" },
  { name: "末世", genre: "末世", idea: "丧尸末世第七年，囤积的物资早已耗尽，只有她在阳台种的那盆变异土豆还在结出新果。" },
  { name: "奇幻", genre: "奇幻", idea: "魔法学院的图书管理员能听见书籍的耳语，某天所有书同时沉默了，唯独一本空书在低语他的名字。" },
];

const Home: React.FC<HomeProps> = (props) => {
  const [phase, setPhase] = useState<Phase>(props.initialData?.world ? "playing" : "landing");
  const [world, setWorld] = useState<WorldState | null>(props.initialData?.world ?? null);
  const [busy, setBusy] = useState(false);
  const [busyPhase, setBusyPhase] = useState("");
  const [activeIdx, setActiveIdx] = useState(-1); // -1 = 最新章节
  const [showGacha, setShowGacha] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showRelations, setShowRelations] = useState(false);
  const [toast, setToast] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    setToastVisible(true);
    toastTimer.current = setTimeout(() => setToastVisible(false), 4500);
  }
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  const [idea, setIdea] = useState("");
  const [genre, setGenre] = useState("");
  const [cmd, setCmd] = useState(""); // 注入下一节的指令
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [stories, setStories] = useState<StoryMeta[]>([]);
  const [showNewStory, setShowNewStory] = useState(false);

  // 加载小说列表
  async function fetchStories() {
    try {
      const res = await fetch("/api/novel/list");
      const data = (await res.json()) as { stories?: StoryMeta[] };
      if (data.stories) setStories(data.stories);
    } catch { /* ignore */ }
  }
  // 初始加载列表
  useEffect(() => { fetchStories(); }, []);

  // 打开已有小说
  async function openStory(title: string) {
    setBusy(true);
    setBusyPhase("加载中…");
    try {
      const res = await fetch("/api/novel/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = (await res.json()) as { world?: WorldState; error?: string };
      if (data.error || !data.world) throw new Error(data.error ?? "加载失败");
      setWorld(data.world);
      setPhase("playing");
      setActiveIdx(-1);
      showToast(`《${data.world.title}》已加载`);
    } catch (e) {
      showToast("加载失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  // 返回小说列表
  function backToList() {
    setPhase("landing");
    setWorld(null);
    setActiveIdx(-1);
    setEditing(false);
    fetchStories();
  }

  const lastChapter = useMemo(() => {
    return world && world.chapters.length ? world.chapters[world.chapters.length - 1] : null;
  }, [world]);
  const shownChapter = useMemo(() => {
    if (!world) return null;
    if (activeIdx === -1) return lastChapter;
    return world.chapters.find((c) => c.index === activeIdx) ?? null;
  }, [world, activeIdx, lastChapter]);
  const shownReview = shownChapter?.review ?? null;

  async function startStory() {
    if (!idea.trim()) return;
    setBusy(true);
    setBusyPhase("立项中…");
    try {
      const res = await fetch("/api/novel/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea: idea.trim(), genre: genre.trim() || undefined }),
      });
      const data = (await res.json()) as { world?: WorldState; error?: string };
      if (data.error || !data.world) throw new Error(data.error ?? "立项失败");
      setWorld(data.world);
      setPhase("playing");
      showToast(`《${data.world.title}》立项完成，导演与审查者已就位。`);
    } catch (e) {
      showToast("立项失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  async function refreshWorld() {
    if (!world) return;
    const res = await fetch("/api/novel/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: world.title }),
    });
    const data = (await res.json()) as { world?: WorldState };
    if (data.world) setWorld(data.world);
  }

  async function advance() {
    if (!world || busy) return;
    setBusy(true);
    setBusyPhase("导演写作中…");
    try {
      const res = await fetch("/api/novel/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, instruction: cmd.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("无响应流");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let result: { chapter: Chapter; review: ReviewResult; rounds: number } | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          let ev: {
            phase?: string;
            round?: number;
            error?: string;
            result?: { chapter: Chapter; review: ReviewResult; rounds: number };
          };
          try {
            ev = JSON.parse(t.slice(5).trim());
          } catch {
            continue;
          }
          if (ev.error) throw new Error(ev.error);
          if (ev.phase === "writing") setBusyPhase(`导演写作中（第 ${ev.round} 稿）…`);
          if (ev.phase === "reviewing") setBusyPhase(`审查者对抗审查中（第 ${ev.round} 稿）…`);
          if (ev.phase === "result" && ev.result) result = ev.result;
        }
      }
      setBusyPhase("存档中…");
      await refreshWorld();
      setActiveIdx(-1);
      setCmd("");
      const r = result?.review;
      showToast(
        r?.verdict === "pass"
          ? `本章通过（${result?.rounds ?? 1} 稿通过）。审查者已放行，伏笔账已更新。`
          : `本章最终仍需修改（${result?.rounds ?? 1} 稿）。可在「审查报告」中查看意见。`,
      );
      if (r?.verdict === "pass") launchConfetti(); // 章节完成彩蛋
    } catch (e) {
      showToast("回合失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  // —— 控制面板保存 ——
  async function saveWorld(patch: WorldPatch): Promise<boolean> {
    if (!world) return false;
    try {
      const res = await fetch("/api/novel/world", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, ...patch }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "保存失败");
      setWorld(data.world);
      showToast("设定已保存，将影响后续写作。");
      return true;
    } catch (e) {
      showToast("保存失败: " + (e as Error).message);
      return false;
    }
  }

  async function generateOutline(hint?: string) {
    if (!world || outlineBusy) return;
    setOutlineBusy(true);
    try {
      const res = await fetch("/api/novel/outline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, hint }),
      });
      const data = (await res.json()) as { ok?: boolean; outline?: string[]; error?: string };
      if (!data.ok) throw new Error(data.error ?? "生成失败");
      await refreshWorld();
      showToast(`大纲已生成（${data.outline?.length ?? 0} 个要点），写作将按大纲推进。`);
    } catch (e) {
      showToast("大纲生成失败: " + (e as Error).message);
    } finally {
      setOutlineBusy(false);
    }
  }

  function startEdit() {
    const c = shownChapter;
    if (!c) return;
    setDraft(c.text);
    setEditing(true);
  }

  async function saveEdit() {
    const c = shownChapter;
    if (!world || !c) return;
    if (!draft.trim()) {
      showToast("章节内容不能为空");
      return;
    }
    setBusy(true);
    setBusyPhase("保存并审查中…");
    try {
      const res = await fetch("/api/novel/chapter/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, index: c.index, text: draft }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; review?: ReviewResult; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "保存失败");
      setWorld(data.world);
      setEditing(false);
      showToast(
        `第 ${c.index} 节已保存` +
          (data.review ? (data.review.verdict === "pass" ? "并通过审查" : "，审查建议修改（仅供参考，不自动重写）") : ""),
      );
    } catch (e) {
      showToast("保存失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  async function regenerate() {
    const c = shownChapter;
    if (!world || !c || busy) return;
    setBusy(true);
    setBusyPhase("AI 重写中…");
    try {
      const res = await fetch("/api/novel/chapter/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, index: c.index, instruction: cmd.trim() || undefined }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; review?: ReviewResult; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "重写失败");
      setWorld(data.world);
      setEditing(false);
      showToast(
        `第 ${c.index} 节已由 AI 重写` +
          (data.review ? (data.review.verdict === "pass" ? "并通过对抗审查" : "（审查建议修改，可在审查报告中查看）") : ""),
      );
    } catch (e) {
      showToast("重写失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  async function reReview() {
    const c = shownChapter;
    if (!world || !c || busy) return;
    setBusy(true);
    setBusyPhase("审查中…");
    try {
      const res = await fetch("/api/novel/chapter/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, index: c.index }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; review?: ReviewResult; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "审查失败");
      setWorld(data.world);
      showToast(
        data.review
          ? data.review.verdict === "pass"
            ? `第 ${c.index} 节审查通过`
            : `第 ${c.index} 节审查建议修改（${data.review.findings.length} 条意见）`
          : "审查完成",
      );
    } catch (e) {
      showToast("审查失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  async function imageAction(kind: "cover" | "character" | "chapter", args?: Record<string, unknown>): Promise<{ path?: string } | null> {
    if (!world || busy) return null;
    // 统一防连点：生成期间全局 busy（loading 遮罩 + 控制条禁用），所有生成入口自动失效
    const imgCount = kind === "chapter" ? Math.max(1, Math.min(3, Number(args?.count) || 1)) : 1;
    setBusy(true);
    setBusyPhase(
      kind === "cover" ? "AI 生成封面中…"
      : kind === "character" ? "AI 生成头像中…"
      : imgCount > 1 ? `AI 生成插画中（${imgCount} 张）…` : "AI 生成插画中…",
    );
    try {
      const isUpload = kind === "cover" && typeof args?.dataUrl === "string";
      const res = await fetch(isUpload ? "/api/novel/cover/upload" : "/api/novel/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isUpload ? { title: world.title, dataUrl: args!.dataUrl } : { title: world.title, kind, ...args }),
      });
      const data = (await res.json()) as { ok?: boolean; path?: string; error?: string };
      if (!data.ok) throw new Error(data.error ?? "失败");
      await refreshWorld();
      showToast(
        kind === "cover" ? (isUpload ? "封面已上传" : "封面已生成")
        : kind === "character" ? "头像已生成"
        : imgCount > 1 ? `插画已生成（${imgCount} 张）` : "插画已生成",
      );
      return data;
    } catch (e) {
      showToast("图像操作失败: " + (e as Error).message);
      return null;
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  // 段落锚定媒体生成（plan → 确认选中段落 → generate）
  type ScenePlan = { anchor: string; scene: string };
  type MediaPlan = { kind: "image" | "video"; chapterIndex: number; scenes: ScenePlan[] };
  const [mediaPlan, setMediaPlan] = useState<MediaPlan | null>(null);
  type MediaGen = { chapterIndex: number; mediaId: string; progress: number };
  const [mediaGen, setMediaGen] = useState<MediaGen | null>(null);
  const mediaTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  function stopMediaPolling() {
    if (mediaTimer.current) { clearInterval(mediaTimer.current); mediaTimer.current = undefined; }
  }
  useEffect(() => () => stopMediaPolling(), []);

  /** 分镜：LLM 挑选关键场景 → 弹出确认窗（不直接生成） */
  async function planMedia(kind: "image" | "video", count: number) {
    if (!world || !shownChapter || busy || mediaGen) return;
    const chapterIndex = shownChapter.index;
    setBusy(true);
    setBusyPhase("AI 分镜中（挑选关键场景）…");
    try {
      const res = await fetch("/api/novel/media/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, chapterIndex, kind, count }),
      });
      const data = (await res.json()) as { ok?: boolean; scenes?: ScenePlan[]; error?: string };
      if (!data.ok || !data.scenes?.length) throw new Error(data.error ?? "场景规划失败");
      setMediaPlan({ kind, chapterIndex, scenes: data.scenes });
    } catch (e) {
      showToast("场景规划失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  /** 确认生成：image 同步（全局 busy）；video 异步任务 + 轮询（内联进度，不锁全局） */
  async function confirmMediaGen() {
    if (!world || !mediaPlan) return;
    const plan = mediaPlan;
    setMediaPlan(null);
    if (plan.kind === "image") {
      setBusy(true);
      setBusyPhase(plan.scenes.length > 1 ? `AI 生成插画中（${plan.scenes.length} 张）…` : "AI 生成插画中…");
      try {
        const res = await fetch("/api/novel/media/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: world.title, chapterIndex: plan.chapterIndex, kind: "image", scenes: plan.scenes }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!data.ok) throw new Error(data.error ?? "生成失败");
        await refreshWorld();
        showToast(plan.scenes.length > 1 ? `插画已生成（${plan.scenes.length} 张）` : "插画已生成");
      } catch (e) {
        showToast("插画生成失败: " + (e as Error).message);
      } finally {
        setBusy(false);
        setBusyPhase("");
      }
      return;
    }
    // video
    try {
      const res = await fetch("/api/novel/media/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, chapterIndex: plan.chapterIndex, kind: "video", scenes: plan.scenes }),
      });
      const data = (await res.json()) as { ok?: boolean; mediaId?: string; mode?: string; error?: string };
      if (!data.ok || !data.mediaId) throw new Error(data.error ?? "创建视频任务失败");
      const mediaId = data.mediaId;
      setMediaGen({ chapterIndex: plan.chapterIndex, mediaId, progress: 0 });
      showToast(data.mode === "i2v" ? "图生视频任务已创建，生成中…" : "视频任务已创建，生成中…");
      stopMediaPolling();
      mediaTimer.current = setInterval(async () => {
        try {
          const r = await fetch("/api/novel/media/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: world.title, chapterIndex: plan.chapterIndex, mediaId }),
          });
          const st = (await r.json()) as { ok?: boolean; status?: string; progress?: number; error?: string };
          if (!st.ok) throw new Error(st.error ?? "查询视频状态失败");
          if (st.status === "ready") {
            stopMediaPolling();
            setMediaGen(null);
            await refreshWorld();
            showToast("关键情节视频已生成");
          } else if (st.status === "failed") {
            stopMediaPolling();
            setMediaGen(null);
            showToast("视频生成失败: " + (st.error ?? ""));
          } else {
            setMediaGen((prev) => (prev ? { ...prev, progress: typeof st.progress === "number" ? st.progress : prev.progress } : prev));
          }
        } catch (e) {
          stopMediaPolling();
          setMediaGen(null);
          showToast("视频生成失败: " + (e as Error).message);
        }
      }, 5000);
    } catch (e) {
      setMediaGen(null);
      showToast("视频任务创建失败: " + (e as Error).message);
    }
  }

  const [showVersions, setShowVersions] = useState(false);
  const [rollbackMsg, setRollbackMsg] = useState("");
  const [showCurrentReview, setShowCurrentReview] = useState(false); // 版本弹窗内「当前版本」审查展开（只读）

  // 审查模式：reviewMode 控制正文波浪线/角标（与抽屉开关独立，需手动退出）；reviewOpen 控制抽屉开合
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [activeReview, setActiveReview] = useState<ReviewResult | null>(null); // 抽屉展示的审查（与点击来源一致）
  const [activeFindingIdx, setActiveFindingIdx] = useState<number | null>(null);
  const [citationTarget, setCitationTarget] = useState<{ evidence: string; idx: number } | null>(null);

  /** 打开审查面板（展示当前章节审查，不定位） */
  function openReviewPanel() {
    setActiveFindingIdx(null);
    setCitationTarget(null);
    setActiveReview(shownChapter?.review ?? null);
    setReviewMode(true); // 进入审查模式（正文渲染波浪线/角标）
    setReviewOpen(true);
  }

  /** 手动退出审查模式：关闭抽屉 + 清除正文标记 */
  function exitReviewMode() {
    setReviewMode(false);
    setReviewOpen(false);
    setActiveFindingIdx(null);
    setCitationTarget(null);
    setActiveReview(null);
  }

  /** 点击原文引用（审查面板 / 版本历史弹窗统一入口）：关闭版本弹窗 → 进入审查模式 → 定位 */
  function handleCiteClick(evidence: string, findingIdx: number, review: ReviewResult) {
    setShowVersions(false);
    setActiveReview(review); // 抽屉展示点击来源的审查（历史版本审查时内容与来源一致）
    setReviewMode(true);
    setReviewOpen(true);
    setActiveFindingIdx(findingIdx);
    setCitationTarget({ evidence, idx: findingIdx });
  }

  /** 点击正文波浪线文本（审查模式中）：打开抽屉并定位到对应列表项 */
  function handleMarkClick(findingIdx: number) {
    setActiveReview(shownChapter?.review ?? null);
    setReviewOpen(true); // 审查模式已开启，仅打开抽屉
    setActiveFindingIdx(findingIdx);
    setCitationTarget(null); // 正文已在当前位置，无需滚动
  }

  // 延迟滚动：等待版本弹窗关闭、审查面板挂载、正文重新渲染后定位；定位失败时提示
  useEffect(() => {
    if (!citationTarget || !reviewOpen) return;
    const t = setTimeout(() => {
      const found = scrollToCitation(citationTarget.evidence, citationTarget.idx);
      if (!found) showToast("未在正文中找到该引用的原文（审查引用可能已随章节改写失效）。");
    }, 150);
    return () => clearTimeout(t);
  }, [citationTarget, reviewOpen]);

  // 二次确认对话框
  const [confirmMsg, setConfirmMsg] = useState("");
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);
  function askConfirm(msg: string, action: () => void) {
    setConfirmMsg(msg);
    setConfirmAction(() => action);
  }
  function doConfirm() {
    if (confirmAction) confirmAction();
    setConfirmMsg("");
    setConfirmAction(null);
  }
  function cancelConfirm() {
    setConfirmMsg("");
    setConfirmAction(null);
  }

  async function rollback(versionIndex: number) {
    const c = shownChapter;
    if (!world || !c) return;
    try {
      const res = await fetch("/api/novel/chapter/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, index: c.index, versionIndex }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "回滚失败");
      setWorld(data.world);
      setShowVersions(false);
      showToast(`已回滚到第 ${c.index} 节的版本 ${versionIndex + 1}`);
    } catch (e) {
      setRollbackMsg("回滚失败: " + (e as Error).message);
    }
  }

  async function saveLore(action: "auto" | "save", entries?: LoreEntry[]): Promise<LoreEntry[] | null> {
    if (!world) return null;
    try {
      const res = await fetch("/api/novel/lore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, action, entries }),
      });
      const data = (await res.json()) as { ok?: boolean; entries?: LoreEntry[]; error?: string };
      if (!data.ok || !data.entries) throw new Error(data.error ?? "失败");
      await refreshWorld();
      showToast(action === "auto" ? `世界书已自动生成 ${data.entries.length} 条设定条目` : "世界书已保存");
      return data.entries;
    } catch (e) {
      showToast("世界书操作失败: " + (e as Error).message);
      return null;
    }
  }

  async function onGachaApplied(instructions: string[], applied: Card[]) {
    await refreshWorld();
    showToast(
      `抽中 ${applied.length} 张卡：${applied.map((c) => `${c.rarity}·${c.title}`).join("、")}。` +
        (instructions.length ? " 指令已注入下一节。" : ""),
    );
  }

  // 浮动下拉菜单位置（body 层级渲染，仅章节「更多」菜单）
  const [chapterMenu, setChapterMenu] = useState<{ x: number; y: number } | null>(null);

  function toggleChapterMenu(e: React.MouseEvent) {
    if (chapterMenu) { setChapterMenu(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setChapterMenu({ x: rect.right, y: rect.bottom + 6 });
  }

  async function exportStory(format?: "epub") {
    if (!world) return;
    window.location.href = `/api/novel/export?title=${encodeURIComponent(world.title)}${format ? `&format=${format}` : ""}`;
  }

  const statusText =
    busyPhase ||
    (world?.chapters.length ? `第 ${world!.nextChapter} 节待写作` : "待机");

  // 章节完成礼花彩蛋（纯 CSS 粒子，无外部依赖）
  function launchConfetti() {
    const colors = ["#b03a2e", "#a67c2e", "#4d7a4d", "#4a6fa5", "#c9a86a", "#8a6d3b"];
    for (let i = 0; i < 42; i++) {
      const el = document.createElement("div");
      el.className = "confetti";
      el.style.left = `${Math.random() * 100}vw`;
      el.style.background = colors[Math.floor(Math.random() * colors.length)];
      el.style.animationDuration = `${1.6 + Math.random() * 1.6}s`;
      el.style.animationDelay = `${Math.random() * 0.6}s`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4200);
    }
  }

  // 弹窗打开时锁定 body 滚动 + Escape 关闭（仅客户端）
  useEffect(() => {
    if (typeof document === "undefined") return;
    const anyOpen = showGacha || showSettings || showVersions || showRelations || showNewStory || reviewOpen || !!confirmMsg;
    document.body.style.overflow = anyOpen ? "hidden" : "";
  }, [showGacha, showSettings, showVersions, showRelations, showNewStory, reviewOpen, confirmMsg]);

  // 全局键盘 / 点击外部 / 滚动关闭浮动菜单
  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (chapterMenu) setChapterMenu(null);
        else if (confirmMsg) cancelConfirm();
        else if (showNewStory) setShowNewStory(false);
        else if (showGacha) setShowGacha(false);
        else if (showSettings) setShowSettings(false);
        else if (showRelations) setShowRelations(false);
        else if (reviewOpen) setReviewOpen(false);
        else if (showVersions) setShowVersions(false);
      }
    };
    const clickOutsideHandler = (e: MouseEvent) => {
      if (!chapterMenu) return;
      const target = e.target as HTMLElement;
      if (!target.closest(".float-dropdown") && !target.closest("[data-menu-trigger]")) {
        setChapterMenu(null);
      }
    };
    const scrollHandler = () => { if (chapterMenu) setChapterMenu(null); };
    document.addEventListener("keydown", keyHandler);
    document.addEventListener("mousedown", clickOutsideHandler);
    document.addEventListener("scroll", scrollHandler, true);
    return () => {
      document.removeEventListener("keydown", keyHandler);
      document.removeEventListener("mousedown", clickOutsideHandler);
      document.removeEventListener("scroll", scrollHandler, true);
      document.body.style.overflow = "";
    };
  }, [chapterMenu, confirmMsg, showNewStory, showGacha, showSettings, showRelations, showVersions, reviewOpen]);

  // 流派标签事件委托（避免 hydration 不匹配）
  const genreTagsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = genreTagsRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest("[data-gi]") as HTMLElement | null;
      if (!btn) return;
      const idx = Number(btn.dataset.gi);
      const t = GENRE_TEMPLATES[idx];
      if (t) { setIdea(t.idea); setGenre(t.genre); }
    };
    const syncActive = () => {
      const btns = el.querySelectorAll("[data-gi]");
      btns.forEach((btn) => {
        const idx = Number((btn as HTMLElement).dataset.gi);
        btn.classList.toggle("active", GENRE_TEMPLATES[idx]?.genre === genre);
      });
    };
    el.addEventListener("click", onClick);
    syncActive(); // 挂载时同步一次（客户端 only）
    return () => el.removeEventListener("click", onClick);
  }, [genre]);

  return (
    <>
      {phase === "landing" && (
        <div className="landing landing-list">
          <header className="landing-header">
            <h1>AI 小说</h1>
            <div className="sub">游戏化创作引擎</div>
          </header>

          {/* 小说列表 */}
          <div className="story-list-section">
            <div className="story-list-header">
              <span className="story-list-label">我的作品</span>
              <button className="btn-new-story" onClick={() => setShowNewStory(true)}>+ 新建</button>
            </div>

            {stories.length > 0 ? (
              <div className="story-list">
                {stories.map((s) => (
                  <div className="story-card" onClick={() => openStory(s.title)} key={s.slug}>
                    {s.cover ? (
                      <img className="story-card-cover" src={`/api/novel/asset?title=${encodeURIComponent(s.title)}&path=${encodeURIComponent(s.cover)}`} alt={s.title} />
                    ) : (
                      <div className="story-card-cover story-card-cover-placeholder">{s.title.slice(0, 1)}</div>
                    )}
                    <div className="story-card-info">
                      <div className="story-card-title">《{s.title}》</div>
                      <div className="story-card-meta">
                        {s.genre && <span className="story-card-genre">{s.genre}</span>}
                        <span>{s.chapters} 节</span>
                        {s.updatedAt && <span>{new Date(s.updatedAt).toLocaleDateString("zh-CN")}</span>}
                      </div>
                    </div>
                    <span className="story-card-arrow">→</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="story-empty">
                <div className="story-empty-icon"><BookOpen size={40} /></div>
                <div className="story-empty-title">还没有作品</div>
                <div className="story-empty-desc">点击「新建」开始你的第一部小说创作</div>
                <button className="btn btn-primary" onClick={() => setShowNewStory(true)}>开始创作</button>
              </div>
            )}
          </div>

          {toast && (
            <div className={`toast-toast ${toastVisible ? "toast-in" : "toast-out"}`}>{toast}</div>
          )}
        </div>
      )}

      {/* 新建小说弹窗 */}
      {showNewStory && (
        <div className="modal-mask" onClick={() => setShowNewStory(false)}>
          <div className="modal modal-new-story" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}><Sparkles size={14} /> 新建小说</b>
              <button className="modal-close" onClick={() => setShowNewStory(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <label>灵感（一句话）</label>
              <textarea
                placeholder="例如：明朝末年，一个小捕快能梦见未来的凶案现场，但梦里总是看不清凶手的脸。"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { startStory(); setShowNewStory(false); } }}
              />
              <div className="idea-hint">
                <span>{idea.length} 字</span>
                <span>Ctrl+Enter 快速立项</span>
              </div>
              <label>或选择流派模板（点击即填充）</label>
              <div className="genre-tags" ref={genreTagsRef}>
                {GENRE_TEMPLATES.map((t, i) => (
                  <button className="genre-tag" data-gi={i} type="button" key={i}>
                    {t.name}
                  </button>
                ))}
              </div>
              <label>题材（可选）</label>
              <input
                placeholder="古风悬疑 / 科幻 / 武侠 / 都市怪谈…"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
              />
              <div style={{ textAlign: "center", marginTop: "1.4rem" }}>
                <button className="btn btn-primary" onClick={() => { startStory(); setShowNewStory(false); }} disabled={busy || !idea.trim()}>
                  {busy ? busyPhase : "开始写作"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {phase === "playing" && world && (
        <div className="game-shell">
          <Masthead
            world={world}
            status={statusText}
            serverTime={props.initialData?.serverTime}
            onBackToList={backToList}
            onOpenSettings={() => setShowSettings(true)}
          />

          <div className="game-grid">
            {/* 左栏：目录 / 脉络（只读速览，设定统一在设置面板操作） */}
            <LeftPanel
              world={world}
              activeChapter={activeIdx}
              onSelectChapter={(i) => {
                setActiveIdx(i);
                setEditing(false);
                // 审查模式需手动退出：切换章节时保持打开，内容同步到新章节
                if (reviewOpen) {
                  const nc = world.chapters.find((c) => c.index === i);
                  setActiveReview(nc?.review ?? null);
                  setActiveFindingIdx(null);
                  setCitationTarget(null);
                }
              }}
            />

            {/* 中央：正文 / 章节编辑器 */}
            <div className="game-col game-col-center">
              <div className="center-header">
                {shownChapter && !editing && (
                  <div className="chapter-actions">
                    {(shownReview || reviewMode) && (
                      reviewMode ? (
                        <button className="btn-save" onClick={exitReviewMode}><X size={13} /> 退出审查</button>
                      ) : (
                        <button className="btn-save" onClick={openReviewPanel}><Search size={13} /> 审查报告</button>
                      )
                    )}
                    <button className="btn-save" onClick={startEdit}><PenLine size={13} /> 编辑</button>
                    <button className="btn-save" onClick={() => askConfirm("确定要 AI 重写本节？当前内容将被覆盖（可在版本历史中回滚）。", regenerate)} disabled={busy}><Sparkles size={13} /> 重写</button>
                    <button className="btn-save" data-menu-trigger onClick={toggleChapterMenu}><MoreHorizontal size={13} /> 更多 <ChevronDown size={11} className="chevron" /></button>
                  </div>
                )}
                {editing && (
                  <div className="editor-tools">
                    <button className="btn" onClick={() => setEditing(false)}>取消</button>
                    <button className="btn btn-primary" onClick={saveEdit} disabled={busy}>
                      {busy ? "保存中…" : "保存修改"}
                    </button>
                  </div>
                )}
              </div>
              <div className="center-scroll">
                {editing && (
                  <div className="editor-box">
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
                  </div>
                )}
                {/* 编辑模式时隐藏正文渲染，仅显示编辑器 */}
                {!editing && (
                  <>
                    <ChapterView chapter={shownChapter} storyTitle={world.title} writing={busyPhase.includes("写作")} review={shownReview} reviewMode={reviewMode} activeFindingIdx={activeFindingIdx} onMarkClick={handleMarkClick} />
                    {/* 视频生成内联进度条（仅当前章节正在生成时显示，不锁全局；完成后媒体在 ChapterView 对应段落前渲染） */}
                    {mediaGen && mediaGen.chapterIndex === shownChapter?.index && (
                      <div style={{ marginTop: "0.8rem", border: "1px dashed var(--line-strong)", padding: "0.7rem 0.9rem", background: "var(--paper-dark)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem", color: "var(--ink-soft)", marginBottom: "0.5rem" }}>
                          <Video size={14} />
                          <span>关键情节视频生成中…{mediaGen.progress >= 0 ? ` ${mediaGen.progress}%` : "（排队/限流中）"}</span>
                        </div>
                        <div style={{ height: "6px", background: "var(--paper)", border: "1px solid var(--line)", borderRadius: "3px", overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${Math.max(0, mediaGen.progress)}%`, background: "var(--seal)", transition: "width 0.4s ease" }} />
                        </div>
                      </div>
                    )}
                    {/* 审查报告已移入独立审查面板（右上角「审查报告」按钮 / 版本历史弹窗入口） */}
                  </>
                )}
              </div>
            </div>

            {/* 右栏：进度 + 状态面板 */}
            <StatusPanel world={world} busyPhase={busyPhase} onWorldUpdate={(nw) => setWorld(nw)} />
          </div>

          {toast && (
            <div className={`toast-toast ${toastVisible ? "toast-in" : "toast-out"}`}>{toast}</div>
          )}

          {/* 底部控制条：角色入口（最左）+ 状态 + 指令输入 + 抽卡 + 推进 */}
          <nav className="control-bar">
            <button className="bar-icon-btn" title="角色与关系" onClick={() => setShowRelations(true)} disabled={busy}>
              <Users size={17} />
            </button>
            <span className="bar-status">
              <span className={`status-light ${busy ? "busy" : "ok"}`} />
              <span className="bar-status-text">{statusText}</span>
            </span>
            <input
              className="cmd-input"
              placeholder="指令：让主角…（Enter 推进）"
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !busy) advance(); }}
            />
            <button className="btn btn-ghost" onClick={() => setShowGacha(true)} disabled={busy}>
              <Dices size={15} /> 抽卡
            </button>
            <button className="btn btn-primary" onClick={advance} disabled={busy}>
              {busy ? "进行中…" : (<><Play size={15} /> 推进剧情</>)}
            </button>
          </nav>
        </div>
      )}

      {showGacha && world && (
        <GachaModal world={world} onClose={() => setShowGacha(false)} onApplied={onGachaApplied} />
      )}

      {showSettings && world && (
        <SettingsModal
          world={world}
          onClose={() => setShowSettings(false)}
          onSave={(patch) => saveWorld(patch)}
          onImage={imageAction}
          onLore={saveLore}
          onGenerateOutline={generateOutline}
          outlineBusy={outlineBusy}
          onExport={exportStory}
        />
      )}

      {showRelations && world && (
        <RelationshipModal
          world={world}
          onClose={() => setShowRelations(false)}
          onSaveRelations={(chars) => saveWorld({ characters: chars })}
        />
      )}

      {showVersions && world && shownChapter && (
        <div className="modal-mask" onClick={() => setShowVersions(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "820px" }}>
            <div className="modal-head">
              <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>版本历史 · 第 {shownChapter.index} 节</b>
              <button className="modal-close" onClick={() => setShowVersions(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
            {/* 当前版本（最新） */}
            <div className="version-item" style={{ borderColor: "var(--seal)", background: "rgba(176,58,46,0.03)" }}>
              <div className="version-meta">
                <b style={{ color: "var(--seal)" }}>★ 当前版本</b>
                <span>{shownChapter.text.length} 字</span>
                {shownChapter.review && (
                  <span className={`version-review-badge ${shownChapter.review.verdict === "pass" ? "pass" : "revise"}`}>
                    {shownChapter.review.verdict === "pass" ? "✓ 审查通过" : "✗ 需修改"}
                  </span>
                )}
              </div>
              <div className="version-preview">{shownChapter.text.slice(0, 200)}…</div>
              <div className="version-actions">
                {shownChapter.review && (
                  <button className="btn-save" onClick={() => setShowCurrentReview(!showCurrentReview)}>
                    {showCurrentReview ? "隐藏审查" : "查看审查"}
                  </button>
                )}
              </div>
              {showCurrentReview && shownChapter.review && (
                <div style={{ marginTop: "0.5rem", paddingTop: "0.4rem", borderTop: "1px dashed var(--line)" }}>
                  <ReviewPanel review={shownChapter.review} writingRounds={shownChapter.review.round ?? 1} foreshadowing={world.foreshadowing} characters={world.characters} readOnly />
                </div>
              )}
            </div>
            <hr style={{ border: "none", borderTop: "1px dashed var(--line)", margin: "0.8rem 0" }} />
            {[...(shownChapter.versions ?? [])].reverse().map((v, i) => {
              const realIdx = (shownChapter.versions?.length ?? 1) - 1 - i;
              return (
                <VersionItem
                  key={`${v.at}-${i}`}
                  v={v}
                  realIdx={realIdx}
                  world={world}
                  onRollback={(vi) => askConfirm(`确定回滚到版本 ${vi + 1}？当前内容将被替换。`, () => rollback(vi))}
                />
              );
            })}
            {(shownChapter.versions?.length ?? 0) === 0 && (
              <div style={{ fontSize: "0.8rem", color: "var(--ink-soft)" }}>（暂无历史版本，编辑或 AI 重写后自动记录）</div>
            )}
            {rollbackMsg && <div className="form-msg">{rollbackMsg}</div>}
            </div>
          </div>
        </div>
      )}

      {/* 审查面板（独立抽屉 · 审查模式：正文引用角标 + 激活项高亮） */}
      {reviewOpen && world && shownChapter && (
        <>
          <div className="review-drawer-mask" onClick={() => setReviewOpen(false)} />
          <div className="review-drawer">
            <div className="review-drawer-head">
              <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>审查报告 · 第 {shownChapter.index} 节</b>
              <button className="modal-close" onClick={() => setReviewOpen(false)}><X size={16} /></button>
            </div>
            <div className="review-drawer-body">
              {activeReview ? (
                <ReviewPanel
                  review={activeReview}
                  writingRounds={activeReview.round ?? 1}
                  foreshadowing={world.foreshadowing}
                  characters={world.characters}
                  activeIdx={activeFindingIdx}
                  onCiteClick={handleCiteClick}
                />
              ) : (
                <div style={{ fontFamily: "var(--sans)", fontSize: "0.8rem", color: "var(--ink-soft)", textAlign: "center", padding: "2rem 0" }}>
                  当前版本暂无审查记录。
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* 二次确认对话框 */}
      {confirmMsg && (
        <div className="modal-mask" onClick={cancelConfirm}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-body" style={{ textAlign: "center", padding: "2rem 1.5rem" }}>
              <div style={{ fontSize: "1.6rem", marginBottom: "0.8rem" }}><AlertTriangle size={28} color="var(--seal)" /></div>
              <p style={{ fontSize: "0.9rem", lineHeight: "1.7", marginBottom: "1.2rem" }}>{confirmMsg}</p>
              <div style={{ display: "flex", gap: "0.8rem", justifyContent: "center" }}>
                <button className="btn" onClick={cancelConfirm}>取消</button>
                <button className="btn btn-primary" onClick={doConfirm}>确认执行</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 媒体生成确认：告知 LLM 选中的关键段落（场景），确认后生成并锚定到对应段落前方 */}
      {mediaPlan && (
        <div className="modal-mask" onClick={() => setMediaPlan(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "560px" }}>
            <div className="modal-head">
              <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>
                {mediaPlan.kind === "video" ? "生成关键情节视频" : `生成插画（${mediaPlan.scenes.length} 张）`}
              </b>
              <button className="modal-close" onClick={() => setMediaPlan(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: "0.8rem", color: "var(--ink-soft)", marginBottom: "0.7rem" }}>
                AI 已为本节挑选以下关键场景，媒体将插入到对应段落前方：
              </p>
              <div className="media-plan-list">
                {mediaPlan.scenes.map((s, i) => (
                  <div className="media-plan-item" key={i}>
                    <div className="media-plan-anchor">▍{s.anchor.length > 60 ? s.anchor.slice(0, 60) + "…" : s.anchor}</div>
                    <div className="media-plan-scene">{s.scene}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: "0.8rem", justifyContent: "flex-end", marginTop: "1rem" }}>
                <button className="btn" onClick={() => setMediaPlan(null)}>取消</button>
                <button className="btn btn-primary" onClick={() => void confirmMediaGen()}>确认生成</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 全局 Loading 遮罩 */}
      {busy && (
        <div className="loading-overlay">
          <div className="loading-spinner" />
          <div className="loading-text">{busyPhase || "处理中…"}</div>
        </div>
      )}

      {/* 浮动下拉菜单（body 层级，不受父容器 overflow/z-index 影响） */}
      {chapterMenu && (
        <div
          className="float-dropdown float-dropdown-light"
          style={{
            position: "fixed",
            right: `${typeof window !== "undefined" ? window.innerWidth - chapterMenu.x : 0}px`,
            top: `${chapterMenu.y}px`,
            zIndex: 9999,
          }}
        >
          <button onClick={() => { setShowVersions(true); setChapterMenu(null); }}><History size={14} /> 版本历史</button>
          {/* 生成插画（1~3 张）：LLM 挑选关键场景 → 确认选中段落 → 段落锚定生成 */}
          <div className="menu-imgen">
            <span className="menu-imgen-label"><Wand2 size={14} /> 生成插画</span>
            <span className="menu-imgen-counts">
              {[1, 2, 3].map((n) => (
                <button key={n} className="menu-imgen-num" disabled={busy || !!mediaGen} onClick={() => { setChapterMenu(null); void planMedia("image", n); }}>{n}张</button>
              ))}
            </span>
          </div>
          <button onClick={() => { void planMedia("video", 1); setChapterMenu(null); }} disabled={busy || !!mediaGen}><Video size={14} /> 生成视频</button>
          <button onClick={() => { reReview(); setChapterMenu(null); }} disabled={busy}><Search size={14} /> 重新审查</button>
        </div>
      )}
    </>
  );
};

// —— 版本历史条目（独立组件：内部有自己的展开/审查状态） ——
const VersionItem: React.FC<{
  v: NonNullable<Chapter["versions"]>[number];
  realIdx: number;
  world: WorldState;
  onRollback: (versionIndex: number) => void;
}> = (p) => {
  const [expandedV, setExpandedV] = useState(false);
  const [showReviewV, setShowReviewV] = useState(false);
  return (
    <div className="version-item">
      <div className="version-meta">
        <span>{new Date(p.v.at).toLocaleString("zh-CN")}</span>
        <span>· {p.v.reason ?? "自动保存"}</span>
        <span>· {p.v.text.length} 字</span>
        {p.v.review && (
          <span className={`version-review-badge ${p.v.review.verdict === "pass" ? "pass" : "revise"}`}>
            {p.v.review.verdict === "pass" ? "✓ 通过" : "✗ 需修改"}
          </span>
        )}
      </div>
      <div className={`version-preview ${expandedV ? "expanded" : ""}`} onClick={() => setExpandedV(!expandedV)}>
        {p.v.text}
      </div>
      <div className="version-actions">
        <button className="btn-save" onClick={() => setExpandedV(!expandedV)}>
          {expandedV ? "收起" : "展开全文"}
        </button>
        {p.v.review && (
          <button className="btn-save" onClick={() => setShowReviewV(!showReviewV)}>
            {showReviewV ? "隐藏审查" : "查看审查"}
          </button>
        )}
        <button className="btn-save btn-danger-sm" onClick={() => p.onRollback(p.realIdx)}>
          回滚到此版本
        </button>
      </div>
      {showReviewV && p.v.review && (
        <div style={{ marginTop: "0.5rem", paddingTop: "0.4rem", borderTop: "1px dashed var(--line)" }}>
          <ReviewPanel review={p.v.review} writingRounds={p.v.review.round ?? 1} characters={p.world.characters} readOnly />
        </div>
      )}
    </div>
  );
};

export default Home;
