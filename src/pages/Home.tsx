// 主界面：启动页（立项）→ 创作游戏界面（日式报纸 HUD + 完整控制面板）
// 交互：立项一句话 / 指令输入 / 抽卡筛选 / 世界观·设定·角色·大纲编辑 / 章节段落编辑 / 推进
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookMarked, BookOpen, ChevronDown, Dices, History, List, MoreHorizontal, PenLine, Play, RefreshCw, Search, Sparkles, Users, Video, Wand2, X } from "../components/icons";
import type { Card, Chapter, ChapterMedia, Character, LoreEntry, ReviewResult, WorldPatch, WorldState } from "../api/world";
import { Masthead } from "../components/Masthead";
import { StatusPanel } from "../components/StatusPanel";
import { ChapterView } from "../components/ChapterView";
import { ReviewPanel, scrollToCitation } from "../components/ReviewPanel";
import { GachaModal } from "../components/GachaModal";
import { SettingsModal } from "../components/SettingsModal";
import { RelationshipModal } from "../components/RelationshipModal";
import { LeftPanel } from "../components/LeftPanel";
import { InterveneModal, type ImpactReportView } from "../components/InterveneModal";
import { IntegrityModal, type IntegrityReportView } from "../components/IntegrityModal";
import { EvalModal } from "../components/EvalModal";
import { PortraitModal } from "../components/PortraitModal";
import { AutoRunPanel, type AutoSessionView, type PendingChapterView } from "../components/AutoRunPanel";
import { MemoryAuditModal } from "../components/MemoryAuditModal";
import { BrainIndicator } from "../components/BrainIndicator";
import { TaskCenterModal } from "../components/TaskCenterModal";
import { ForeshadowModal } from "../components/ForeshadowModal";
import { lensCn, severityCn } from "../terms";

export type HomeProps = {
  url?: string;
  initialData?: { world?: WorldState; serverTime?: string; ssr?: boolean; chapter?: number };
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

/** 读取 URL 中的 chapter 参数（刷新恢复用；无效/缺失返回 undefined） */
function readUrlChapter(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = new URL(window.location.href).searchParams.get("chapter");
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 解析初始选中章节：URL chapter 有效则恢复；否则默认第一章（非最新章节） */
function resolveInitialChapter(w: WorldState, urlChapter?: number): number {
  if (urlChapter != null && Number.isInteger(urlChapter) && w.chapters.some((c) => c.index === urlChapter)) {
    return urlChapter;
  }
  const first = w.chapters[0];
  return first ? first.index : -1;
}

const Home: React.FC<HomeProps> = (props) => {
  const [phase, setPhase] = useState<Phase>(props.initialData?.world ? "playing" : "landing");
  const [world, setWorld] = useState<WorldState | null>(props.initialData?.world ?? null);
  const [busy, setBusy] = useState(false);
  const [busyPhase, setBusyPhase] = useState("");
  // 初始选中章节：SSR 预载时按 URL chapter 恢复；否则默认第一章（章节不存在/无记录时不回退最新章节）
  const [activeIdx, setActiveIdx] = useState(() =>
    props.initialData?.world ? resolveInitialChapter(props.initialData.world, props.initialData?.chapter) : -1,
  ); // -1 = 无章节
  const [showGacha, setShowGacha] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMemoryAudit, setShowMemoryAudit] = useState(false); // 中枢弹窗一：分层记忆·台账·操作日志
  const [showTaskCenter, setShowTaskCenter] = useState(false); // 任务中心（弹窗二）：连载/推进任务进度与控制
  const [pendingCommitIdx, setPendingCommitIdx] = useState<number | null>(null); // 推进剧情待人工确认入册的章节号（commitPolicy=confirm）
  const [showForeshadow, setShowForeshadow] = useState(false); // 伏笔账编辑弹窗（底部控制条角色与关系旁）
  /** 角色与关系弹窗（底部按钮=可编辑模式；脉络/审查面板角色点击=只读模式，顶层共享同一实例渲染，避免弹窗被困在区域内部） */
  const [relModal, setRelModal] = useState<{ editable: boolean; charId: string | null } | null>(null);
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
  const [cmd, setCmd] = useState(""); // 注入下一章的指令
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [stories, setStories] = useState<StoryMeta[]>([]);
  const [showNewStory, setShowNewStory] = useState(false);
  // P3.5 干预治理：L2 回溯变更的影响报告待三选一
  const [intervene, setIntervene] = useState<{ patch: WorldPatch & Record<string, unknown>; report: ImpactReportView; changeDesc: string } | null>(null);
  // P4 自动连载 + 流式预览 + 评估
  const [autoRunning, setAutoRunning] = useState(false);
  const [liveDraft, setLiveDraft] = useState("");
  const [showEval, setShowEval] = useState(false);
  // P4.5 自动连载 git 式：会话状态 / 暂存区 / 控制台 / 启动确认
  const [autoSession, setAutoSession] = useState<AutoSessionView | null>(null);
  const [autoPending, setAutoPending] = useState<PendingChapterView | null>(null);
  const [showAutoPanel, setShowAutoPanel] = useState(false);
  const [showAutoStart, setShowAutoStart] = useState(false);
  const [autoChapters, setAutoChapters] = useState(5);
  const autoPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoCheckedRef = useRef<string | null>(null);

  // —— 运行锁（用户决策）：连载/推进运行中（含暂停态）全面禁止一切编辑类操作（AI 与手工均不可）——
  // 必须取消任务回到空闲状态才可手动操作，避免与正在写入的账本/正文产生冲突
  const taskActive = busy || autoRunning || autoSession?.status === "running" || autoSession?.status === "paused";
  function requireIdle(): boolean {
    if (!taskActive) return true;
    showToast("任务运行中（连载/推进），一切编辑类操作已禁止——请先取消任务回到空闲状态。");
    return false;
  }

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

  /** 路由状态持久化：URL 同步 ?title=<书名>&chapter=<章节index>，刷新时 SSR 凭此直接恢复阅读位置（返回列表则清除） */
  function setStoryUrl(title?: string, chapter?: number) {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (title) u.searchParams.set("title", title);
    else u.searchParams.delete("title");
    if (chapter != null && chapter > 0) u.searchParams.set("chapter", String(chapter));
    else u.searchParams.delete("chapter");
    window.history.replaceState(null, "", u.pathname + u.search);
  }

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
      // 恢复上次选中章节（URL chapter）；无记录/章节缺失 → 第一章
      const initIdx = resolveInitialChapter(data.world, readUrlChapter());
      setActiveIdx(initIdx);
      setStoryUrl(data.world.title, initIdx > 0 ? initIdx : undefined);
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
    setStoryUrl();
    fetchStories();
  }

  const lastChapter = useMemo(() => {
    return world && world.chapters.length ? world.chapters[world.chapters.length - 1] : null;
  }, [world]);
  // P3.5：待确认的新角色提案（抽卡角色卡 / writer 记账新发现）
  const pendingProposals = useMemo(() => {
    return (world?.characterProposals ?? []).filter((p) => p.status === "pending");
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
      setStoryUrl(data.world.title);
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
    setLiveDraft("");
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
          if (ev.phase === "delta" && typeof (ev as { delta?: string }).delta === "string") setLiveDraft((d) => d + (ev as { delta: string }).delta);
          if (ev.phase === "writing") { setBusyPhase(`导演写作中（第 ${ev.round} 稿）…`); setLiveDraft(""); }
          if (ev.phase === "reviewing") setBusyPhase(`审查者对抗审查中（第 ${ev.round} 稿）…`);
          if (ev.phase === "patching") setBusyPhase("定向修补段落中…");
          if (ev.phase === "settling") setBusyPhase("本章结算中（伏笔/状态/摘要）…");
          if (ev.phase === "interrupted") {
            showToast("写作已被干预打断，草稿未存档（零污染）。请处理干预后继续。");
            await refreshWorld();
            return;
          }
          if (ev.phase === "result" && ev.result) result = ev.result;
          if (ev.phase === "pending-commit") {
            // commitPolicy=confirm：审查通过已暂存，等人工确认入册
            setPendingCommitIdx((ev as { chapterIndex?: number }).chapterIndex ?? null);
            setLiveDraft("");
            await refreshWorld();
            showToast("本章审查通过，已暂存待你确认入册（可在任务中心确认或放弃）。");
            setShowTaskCenter(true);
            return; // 不走常规入册收尾
          }
        }
      }
      setBusyPhase("存档中…");
      setLiveDraft("");
      await refreshWorld();
      setActiveIdx(-1);
      // 路由记录最新章节：刷新后回到写到的章节
      setStoryUrl(world.title, result?.chapter?.index);
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

  // 用户主动暂停连载：章边界停下，保持 paused 会话可恢复
  async function pauseAutoRun() {
    if (!world) return;
    try {
      await fetch("/api/novel/auto/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title }),
      });
      showToast("已发送暂停指令，将在本章结束后停下（可随时恢复）。");
    } catch {
      showToast("暂停指令发送失败");
    }
  }

  // 恢复连载：复用 auto/start 的 paused 续跑路径（原目标与已写章数）
  async function resumeAutoRun() {
    if (!world) return;
    try {
      const res = await fetch("/api/novel/auto/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title }),
      });
      if (res.status === 409) throw new Error("连载已在运行中");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast("连载已恢复（断点续跑）。");
      await refreshWorld();
      await fetchAutoStatus();
    } catch (e) {
      showToast("恢复失败: " + (e as Error).message);
    }
  }

  // 取消任务（用户决策）：立即打断 + 停止 + 清理会话与暂存区，回到空闲状态后才可手动操作
  async function removeAutoTask() {
    if (!world) return;
    try {
      // ① 立即打断当前章（阶段边界丢弃草稿，零污染）
      await fetch("/api/novel/intervene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, action: "interrupt", kind: "user-stop", detail: "用户取消连载任务" }),
      });
      // ② 停止连载（章边界停下）
      await fetch("/api/novel/auto/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title }),
      });
      // ③ 清理会话与暂存区，回空闲
      await fetch("/api/novel/auto/clear-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title }),
      });
      setAutoRunning(false);
      setBusy(false);
      setBusyPhase("");
      setAutoSession(null);
      setAutoPending(null);
      setLiveDraft("");
      showToast("连载任务已取消，回到空闲状态，现在可以手动操作了。");
    } catch {
      showToast("取消任务失败");
    }
  }

  // 确认入册（commitPolicy=confirm）：消费暂存区待确认草稿 → 完整 commit 记账
  async function confirmPendingCommit() {
    if (!world) return;
    try {
      const res = await fetch("/api/novel/chapter/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; chapter?: Chapter; error?: string };
      if (!data.ok) throw new Error(data.error ?? "确认入册失败");
      if (data.world) setWorld(data.world);
      setPendingCommitIdx(null);
      if (data.chapter) setStoryUrl(world.title, data.chapter.index);
      showToast(`第 ${data.chapter?.index ?? "?"} 章已确认入册，伏笔账已更新。`);
      launchConfetti();
    } catch (e) {
      showToast("确认入册失败: " + (e as Error).message);
    }
  }

  // 放弃待确认草稿：清暂存区（章节号保留，可重新推进）
  async function rejectPendingCommit() {
    if (!world) return;
    try {
      const res = await fetch("/api/novel/chapter/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "放弃失败");
      setPendingCommitIdx(null);
      await refreshWorld();
      showToast("已放弃待确认草稿（未入册，可重新推进剧情）。");
    } catch (e) {
      showToast("放弃失败: " + (e as Error).message);
    }
  }

  // 取消推进：干预打断（阶段边界丢弃草稿，零污染）
  async function cancelAdvance() {
    if (!world) return;
    try {
      await fetch("/api/novel/intervene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, action: "interrupt", kind: "user-stop", detail: "用户取消推进" }),
      });
      showToast("已请求取消推进，当前草稿将在阶段边界丢弃（零污染）。");
    } catch {
      showToast("取消指令发送失败");
    }
  }

  // —— 控制面板保存（P3.5：L2 回溯变更会被服务端拦截，返回影响报告交三选一） ——
  async function saveWorld(patch: WorldPatch & Record<string, unknown>, strategy?: "merge" | "rewrite" | "abort"): Promise<boolean> {
    if (!world) return false;
    if (!requireIdle()) return false; // 运行锁：任务运行中禁止一切设定/角色/大纲编辑（含干预策略）
    try {
      const res = await fetch("/api/novel/world", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, ...patch, ...(strategy ? { strategy } : {}) }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; error?: string; needIntervention?: boolean; report?: ImpactReportView; change?: { detail?: string }; aborted?: boolean };
      if (data.needIntervention && data.report) {
        // L2：弹出干预面板，暂存 patch 等待三选一
        setIntervene({ patch, report: data.report, changeDesc: data.change?.detail ?? "角色/设定修改" });
        showToast("该修改涉及已写内容，请先选择处置方式");
        return false;
      }
      if (data.aborted) {
        setIntervene(null);
        showToast("已放弃本次变更");
        return false;
      }
      if (!data.ok || !data.world) throw new Error(data.error ?? "保存失败");
      setWorld(data.world);
      setIntervene(null);
      showToast(strategy === "merge" ? "设定已保存，弥合任务已注入后续章纲。" : strategy === "rewrite" ? "设定已保存，受影响章节已入重写队列。" : "设定已保存，将影响后续写作。");
      return true;
    } catch (e) {
      showToast("保存失败: " + (e as Error).message);
      return false;
    }
  }

  // 干预三选一（用户决策①：每次弹影响报告）
  async function chooseIntervention(strategy: "merge" | "rewrite" | "abort") {
    if (!intervene) return;
    setBusy(true);
    setBusyPhase("执行干预策略中…");
    try {
      await saveWorld(intervene.patch, strategy);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  // 新角色提案：确认入册 / 拒绝（抽卡角色卡与 writer 新角色统一入口）
  async function proposalAction(proposalId: string, action: "confirm" | "reject") {
    if (!world) return;
    if (!requireIdle()) return; // 运行锁：角色入册属编辑类操作
    try {
      const res = await fetch("/api/novel/proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, proposalId, action }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "操作失败");
      setWorld(data.world);
      showToast(action === "confirm" ? "新角色已入册，可在后续章节登场。" : "提案已拒绝。");
    } catch (e) {
      showToast("提案处理失败: " + (e as Error).message);
    }
  }

  async function generateOutline(hint?: string): Promise<string[] | null> {
    if (!world || outlineBusy) return null;
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
      return data.outline ?? null;
    } catch (e) {
      showToast("大纲生成失败: " + (e as Error).message);
      return null;
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
    if (!requireIdle()) return; // 运行锁：内容修订禁止
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
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; review?: ReviewResult; report?: IntegrityReportView; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "保存失败");
      setWorld(data.world);
      setEditing(false);
      showChangeReport(data.report, c.index);
      showToast(
        `第 ${c.index} 章已保存` +
          (data.review ? (data.review.verdict === "pass" ? "并通过审查" : "，审查建议修改（仅供参考，不自动重写）") : ""),
      );
    } catch (e) {
      showToast("保存失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  /** 账本重结算：以现存正文重新记账（角色状态/伏笔/时间线/当前状态），不动正文、不重写，并补写 delta 快照（修复删除章节后状态残留） */
  async function resettleChapter() {
    const c = shownChapter;
    if (!world || !c || busy) return;
    if (!requireIdle()) return; // 运行锁：重算账本禁止
    setBusy(true);
    setBusyPhase("重算本章账本中…");
    try {
      const res = await fetch("/api/novel/chapter/resettle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, index: c.index }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        world?: WorldState;
        report?: { newForeshadows?: number; resolvedForeshadows?: number; newProposals?: number; characterUpdates?: unknown[]; relationUpdates?: number; addedSettingRules?: number; worldCurrent?: unknown };
        error?: string;
      };
      if (!data.ok || !data.world) throw new Error(data.error ?? "重结算失败");
      setWorld(data.world);
      showToast(
        `第 ${c.index} 章账本已按正文重算` +
          (data.report
            ? `（角色 ${data.report.characterUpdates?.length ?? 0} 名、关系 ${data.report.relationUpdates ?? 0} 组、伏笔 +${data.report.newForeshadows ?? 0}/回收 ${data.report.resolvedForeshadows ?? 0}、规则 +${data.report.addedSettingRules ?? 0}、时间线/当前状态已同步）`
            : ""),
      );
    } catch (e) {
      showToast("重算账本失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  async function regenerate() {
    const c = shownChapter;
    if (!world || !c || busy) return;
    if (!requireIdle()) return; // 运行锁：AI 修复/重写禁止
    setBusy(true);
    setBusyPhase("AI 重写中…");
    try {
      // 需修改章节：默认按审查意见定向修复（无需用户输入指令）
      const findingsText = (c.review?.findings ?? [])
        .map((f) => `[${lensCn(f.lens)}/${severityCn(f.severity)}] ${f.issue}（原文：${f.evidence}）建议：${f.suggestion}`)
        .join("\n");
      const autoFix = c.review?.verdict === "revise" && findingsText ? `按以下审查意见修复本章：\n${findingsText}` : undefined;
      const res = await fetch("/api/novel/chapter/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, index: c.index, instruction: cmd.trim() || autoFix || undefined }),
        // 纯 POST 无进度推送，最坏场景（重试+重写轮+续写）可达 10+ 分钟：15 分钟超时兜底，防请求永久挂起
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; review?: ReviewResult; report?: IntegrityReportView; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "重写失败");
      setWorld(data.world);
      setEditing(false);
      showChangeReport(data.report, c.index);
      showToast(
        `第 ${c.index} 章已由 AI 重写` +
          (data.review ? (data.review.verdict === "pass" ? "并通过对抗审查" : "（审查建议修改，可在审查报告中查看）") : ""),
      );
    } catch (e) {
      const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
      showToast(
        isTimeout
          ? "重写请求超时（15 分钟），服务端可能仍在处理：请稍后刷新页面查看章节是否已更新，若未更新请重试"
          : "重写失败: " + (e as Error).message,
      );
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  async function reReview() {
    const c = shownChapter;
    if (!world || !c || busy) return;
    if (!requireIdle()) return; // 运行锁：重新审查禁止
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
            ? `第 ${c.index} 章审查通过`
            : `第 ${c.index} 章审查建议修改（${data.review.findings.length} 条意见）`
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

  // 段落锚定媒体生成（plan → 确认选中段落 → generate；异步任务 + 轮询，不阻塞页面，刷新可恢复）
  type ScenePlan = { anchor: string; scene: string; caption?: string; type?: string; subject?: string; extraChars?: string[] };
  type MediaPlan = { kind: "image" | "video"; chapterIndex: number; scenes: ScenePlan[] };
  const [mediaPlan, setMediaPlan] = useState<MediaPlan | null>(null);
  type MediaGen = { chapterIndex: number; mediaIds: string[]; progress: number };
  const [mediaGen, setMediaGen] = useState<MediaGen | null>(null);
  // 改词重生成：编辑弹窗状态（预填 prompt，风格后缀服务端自动保留）
  const [regenMedia, setRegenMedia] = useState<{ chapterIndex: number; media: ChapterMedia; prompt: string } | null>(null);
  // 角色全局立绘：大图预览 + 生成/重新生成（点击角色列表中的立绘或角色项触发）
  const [portraitView, setPortraitView] = useState<Character | null>(null);
  const [portraitBusy, setPortraitBusy] = useState(false);
  /** 只读角色弹窗内打开的立绘仅可查看（隐藏生成入口），独立记录避免弹窗关闭后状态翻转 */
  const [portraitReadOnly, setPortraitReadOnly] = useState(false);
  function openPortrait(c: Character, readOnly = false) {
    setPortraitView(c);
    setPortraitReadOnly(readOnly);
  }
  // 一致性治理：巡检/变更报告弹窗 与 删章两阶段预览
  const [integrityView, setIntegrityView] = useState<{ title: string; desc?: string; tip?: string; report: IntegrityReportView; repairable?: boolean } | null>(null);
  const [deletePreview, setDeletePreview] = useState<{ index: number; chapterTitle: string; report: IntegrityReportView } | null>(null);
  const mediaTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  function stopMediaPolling() {
    if (mediaTimer.current) { clearInterval(mediaTimer.current); mediaTimer.current = undefined; }
  }
  useEffect(() => () => stopMediaPolling(), []);

  // 刷新/重新进入恢复轮询：world 中存在 pending 媒体（插画/视频异步任务）且当前无轮询时自动续接，保证刷新页面不影响生成结果
  useEffect(() => {
    if (!world || mediaTimer.current) return;
    for (const ch of world.chapters) {
      const pend = (ch.media ?? []).filter((m) => m.status === "pending" && (m.kind === "image" || m.videoId));
      if (pend.length) {
        startMediaPolling(ch.index, pend.map((m) => m.id));
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  /** 生成/重新生成角色全局立绘：生成立绘后刷新 world（插画/视频的样貌唯一基准）；description 为可选外貌描述 */
  async function generatePortrait(description?: string) {
    if (!world || !portraitView || portraitBusy) return;
    setPortraitBusy(true);
    try {
      const res = await fetch("/api/novel/character/portrait", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, characterId: portraitView.id, description }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "生成立绘失败");
      await refreshWorld();
      showToast("角色全局立绘已生成");
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setPortraitBusy(false);
    }
  }
  
  /** 媒体任务轮询（插画/视频通用，支持多张并发）：每 5s 查各 mediaId 的 status，全部收尾（ready/failed）后结束；
   * confirmMediaGen、regenerateMedia 与刷新恢复共用 */
  function startMediaPolling(chapterIndex: number, mediaIds: string[]) {
    if (!world || !mediaIds.length) return;
    const storyTitle = world.title;
    const ids = [...mediaIds];
    setMediaGen({ chapterIndex, mediaIds: ids, progress: 0 });
    stopMediaPolling();
    const finished = new Set<string>();
    const failed: string[] = [];
    mediaTimer.current = setInterval(async () => {
      try {
        const pending: string[] = [];
        for (const id of ids) {
          if (finished.has(id)) continue;
          const r = await fetch("/api/novel/media/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: storyTitle, chapterIndex, mediaId: id }),
          });
          const st = (await r.json()) as { ok?: boolean; status?: string; progress?: number; error?: string };
          if (!st.ok) throw new Error(st.error ?? "查询媒体状态失败");
          if (st.status === "ready") {
            finished.add(id);
          } else if (st.status === "failed") {
            finished.add(id);
            failed.push(st.error ?? "生成失败");
          } else {
            pending.push(id);
          }
        }
        if (finished.size === ids.length) {
          // 全部收尾
          stopMediaPolling();
          setMediaGen(null);
          await refreshWorld();
          const okCount = ids.length - failed.length;
          if (failed.length) {
            showToast(`${okCount}/${ids.length} 个媒体已生成，${failed.length} 个失败：${failed[0]}`);
          } else {
            showToast(ids.length > 1 ? `${ids.length} 个媒体已生成` : "媒体已生成");
          }
        } else {
          setMediaGen((prev) => (prev ? { ...prev, progress: pending.length ? Math.max(prev.progress, 0) : prev.progress } : prev));
        }
      } catch (e) {
        // 网络抖动：保留轮询重试，不终止；连续失败由服务端超时兜底
        console.warn("[media] 轮询失败，稍后重试:", (e as Error).message);
      }
    }, 5000);
  }

  /** 分镜：LLM 挑选关键场景 → 弹出确认窗（不直接生成）；240s 超时保护（服务端单次最长 90s，内部重试 + 外层重试共 3 次预算） */
  async function planMedia(kind: "image" | "video", count: number) {
    if (!world || !shownChapter || busy || mediaGen) return;
    const chapterIndex = shownChapter.index;
    setBusy(true);
    setBusyPhase("AI 分镜中（挑选关键场景）…");
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 240_000); // 服务端单次分镜最长约 90s，失败自动重试（预留重试预算）
      const res = await fetch("/api/novel/media/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, chapterIndex, kind, count }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const data = (await res.json()) as { ok?: boolean; scenes?: ScenePlan[]; error?: string };
      if (!data.ok || !data.scenes?.length) throw new Error(data.error ?? "场景规划失败");
      setMediaPlan({ kind, chapterIndex, scenes: data.scenes });
    } catch (e) {
      showToast("场景规划失败: " + ((e as Error).name === "AbortError" ? "分镜超时（超过 4 分钟，已自动重试），请稍后重试" : (e as Error).message));
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  /** 分镜场景编辑：确认弹窗中的画面说明/提示词允许用户修改后再生成 */
  function updateMediaPlanScene(i: number, patch: Partial<ScenePlan>) {
    setMediaPlan((p) => (p ? { ...p, scenes: p.scenes.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : p));
  }

  /** 确认生成：image/video 均异步提交任务 + 轮询（内联进度，不锁全局，刷新页面可恢复） */
  async function confirmMediaGen() {
    if (!world || !mediaPlan) return;
    const plan = mediaPlan;
    setMediaPlan(null);
    try {
      const res = await fetch("/api/novel/media/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, chapterIndex: plan.chapterIndex, kind: plan.kind, scenes: plan.scenes }),
      });
      const data = (await res.json()) as { ok?: boolean; mediaId?: string; mediaIds?: string[]; error?: string };
      if (!data.ok) throw new Error(data.error ?? "创建生成任务失败");
      if (plan.kind === "image") {
        const ids = data.mediaIds ?? [];
        if (!ids.length) throw new Error("服务端未返回生成任务");
        showToast(ids.length > 1 ? `插画生成任务已提交（${ids.length} 张），完成后自动显示` : "插画生成任务已提交，完成后自动显示");
        startMediaPolling(plan.chapterIndex, ids);
      } else {
        if (!data.mediaId) throw new Error("创建视频任务失败");
        showToast("视频任务已创建，生成中…");
        startMediaPolling(plan.chapterIndex, [data.mediaId]);
      }
    } catch (e) {
      setMediaGen(null);
      showToast("生成任务创建失败: " + (e as Error).message);
    }
  }

  /** 单张改词重生成：image 同步（全局 busy）；video 异步任务 + 轮询（mediaId 不变，轮询自然续上） */
  async function regenerateMedia() {
    if (!world || !regenMedia) return;
    const { chapterIndex, media, prompt } = regenMedia;
    setRegenMedia(null);
    try {
      if (media.kind === "image") {
        setBusy(true);
        setBusyPhase("AI 重新生成插画中…");
        const res = await fetch("/api/novel/media/regenerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: world.title, chapterIndex, mediaId: media.id, prompt }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!data.ok) throw new Error(data.error ?? "重生成失败");
        await refreshWorld();
        showToast("插画已重新生成");
      } else {
        const res = await fetch("/api/novel/media/regenerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: world.title, chapterIndex, mediaId: media.id, prompt }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!data.ok) throw new Error(data.error ?? "重生成失败");
        showToast("视频重生成任务已创建，生成中…");
        startMediaPolling(chapterIndex, [media.id]);
      }
    } catch (e) {
      showToast("重生成失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  /** 删除媒体（插画/视频）：二次确认后调 delete 路由，同步删盘文件 */
  function deleteMedia(m: ChapterMedia) {
    if (!world || !shownChapter) return;
    const chapterIndex = shownChapter.index;
    const label = m.kind === "video" ? "视频" : "插画";
    askConfirm(`确定删除该${label}？对应文件将被移除，删除后不可恢复。`, async () => {
      try {
        const res = await fetch("/api/novel/media/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: world.title, chapterIndex, mediaId: m.id }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!data.ok) throw new Error(data.error ?? "删除失败");
        await refreshWorld();
        showToast(`${label}已删除`);
      } catch (e) {
        showToast("删除失败: " + (e as Error).message);
      }
    });
  }

  // —— 一致性治理：变更报告 / 删章两阶段 / 巡检修复 ——
  /** 报告含 warning/danger 或失配媒体才弹窗，否则不打扰 */
  function notableReport(report?: IntegrityReportView): boolean {
    return !!report && (report.findings.some((f) => f.level !== "info") || report.orphanMedia.length > 0);
  }
  function showChangeReport(report: IntegrityReportView | undefined, chapterIndex: number) {
    if (!report || !notableReport(report)) return;
    setIntegrityView({ title: `第 ${chapterIndex} 章变更 · 一致性检查`, desc: "章节内容已变更，以下为自动一致性检查结果（媒体失配可在正文中对应位置重新生成或删除）：", report });
  }

  /** 删章第一步：影响预览（确定性危险项 + 删中间章时服务端附带 LLM 冲突评估） */
  async function requestDeleteChapter() {
    const c = shownChapter;
    if (!world || !c || busy || mediaGen) return;
    if (!requireIdle()) return; // 运行锁：删章禁止
    setChapterMenu(null);
    setBusy(true);
    setBusyPhase("评估删章影响…");
    try {
      const res = await fetch("/api/novel/chapter/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, chapterIndex: c.index }),
      });
      const data = (await res.json()) as { ok?: boolean; report?: IntegrityReportView; error?: string };
      if (!data.ok || !data.report) throw new Error(data.error ?? "评估失败");
      setDeletePreview({ index: c.index, chapterTitle: c.title, report: data.report });
    } catch (e) {
      showToast("删章评估失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  /** 删章第二步：确认后级联删除（允许空洞不重排章号），成功后呈现残留报告；
   * 被删章节无结算快照（旧存档）时自动重算剩余最后一章账本，对齐角色/伏笔状态 */
  async function confirmDeleteChapter() {
    if (!world || !deletePreview) return;
    const { index } = deletePreview;
    setBusy(true);
    setBusyPhase(`删除第 ${index} 章中…`);
    try {
      const res = await fetch("/api/novel/chapter/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, chapterIndex: index, strategy: "merge" }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; report?: IntegrityReportView; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "删除失败");
      setWorld(data.world);
      setDeletePreview(null);
      // 删除的是当前选中章节 → 回退到相邻章节（上一章优先，其次下一章；无章节则 -1），
      // 避免正文区/左栏脉络停留在已删除章节——修「删除章节后脉络未更新」；同时同步 URL 阅读位置
      if (activeIdx === index) {
        const rest = data.world.chapters;
        const nextIdx =
          [...rest].reverse().find((c) => c.index < index)?.index ??
          rest.find((c) => c.index > index)?.index ??
          -1;
        setActiveIdx(nextIdx);
        setStoryUrl(world.title, nextIdx);
        if (reviewOpen) {
          const nc = data.world.chapters.find((c) => c.index === nextIdx);
          setActiveReview(nc?.review ?? null);
          setActiveFindingIdx(null);
          setCitationTarget(null);
        }
      }
      // 自动账本修复：被删章节无结算快照（旧存档）→ 角色/伏笔状态无法自动回退 → 重算剩余最后一章对齐
      const deltaMissing = (data.report?.findings ?? []).some((f) => f.kind === "delta-missing");
      if (deltaMissing) {
        const last = data.world.chapters[data.world.chapters.length - 1];
        if (last) {
          try {
            const rr = await fetch("/api/novel/chapter/resettle", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: world.title, index: last.index }),
            });
            const rd = (await rr.json()) as { ok?: boolean; world?: WorldState; error?: string };
            if (rd.ok && rd.world) setWorld(rd.world);
            showToast(`已删除；第 ${last.index} 章账本已自动重算，角色/伏笔状态已与正文对齐。`);
          } catch {
            showToast("已删除，但角色状态可能残留：请在「更多 → 重算本章账本」手动对齐。");
          }
        }
      }
      if (data.report && notableReport(data.report)) {
        setIntegrityView({ title: `第 ${index} 章已删除 · 一致性报告`, desc: "删除已完成，以下为残留影响与留痕：", report: data.report });
      } else if (!deltaMissing) {
        showToast(`第 ${index} 章已删除`);
      }
    } catch (e) {
      showToast("删除章节失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  /** 一致性巡检：零 LLM 确定性审计（孤儿引用/伏笔章号/失配媒体） */
  async function runIntegrityScan() {
    if (!world || busy) return;
    setChapterMenu(null);
    setBusy(true);
    setBusyPhase("一致性巡检中…");
    try {
      const res = await fetch("/api/novel/integrity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, action: "scan" }),
      });
      const data = (await res.json()) as { ok?: boolean; report?: IntegrityReportView; error?: string };
      if (!data.ok || !data.report) throw new Error(data.error ?? "巡检失败");
      setIntegrityView({ title: "一致性巡检报告", tip: "确定性审计：孤儿引用、伏笔章号异常、失配媒体。孤儿条目/悬空键可一键修复；伏笔类问题涉及剧情决策，需在伏笔账本中手动处置", report: data.report, repairable: true });
    } catch (e) {
      showToast("巡检失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  /** 一键修复：幂等清除孤儿条目/悬空键 + 重算登场记录（不删正文/媒体/伏笔） */
  async function repairIntegrity() {
    if (!world || busy) return;
    setBusy(true);
    setBusyPhase("修复一致性问题…");
    try {
      const res = await fetch("/api/novel/integrity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, action: "repair" }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; report?: IntegrityReportView; autoFixed?: string[]; error?: string };
      if (!data.ok) throw new Error(data.error ?? "修复失败");
      if (data.world) setWorld(data.world);
      if (data.report) setIntegrityView({ title: "一致性修复完成", report: data.report });
      showToast(data.autoFixed?.length ? `已修复 ${data.autoFixed.length} 项` : "未发现需修复项");
    } catch (e) {
      showToast("修复失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  // —— P4.5 自动连载（git 式）：会话状态查询 / 轮询 / 控制台操作 ——

  /** 查询连载会话与暂存区（刷新恢复 / 轮询 / SSE 结束后同步） */
  async function fetchAutoStatus() {
    if (!world) return null;
    try {
      const res = await fetch(`/api/novel/auto/status?title=${encodeURIComponent(world.title)}`);
      const d = (await res.json()) as { session?: AutoSessionView | null; pending?: PendingChapterView | null; error?: string };
      if (d.error) return null;
      setAutoSession(d.session ?? null);
      setAutoPending(d.pending ?? null);
      return d.session ?? null;
    } catch {
      return null;
    }
  }

  /** 后台续跑轮询：SSE 断开（刷新/切页）后每 5s 同步一次进度；终态（paused/stopped/done）自动停止 */
  function startAutoPoll() {
    stopAutoPoll();
    autoPollRef.current = setInterval(async () => {
      const s = await fetchAutoStatus();
      if (!s) return;
      if (s.status !== "running") {
        stopAutoPoll();
        if (s.status === "paused") setShowAutoPanel(true);
        if (s.status === "done" || s.status === "stopped") await refreshWorld();
      }
    }, 5000);
  }
  function stopAutoPoll() {
    if (autoPollRef.current) {
      clearInterval(autoPollRef.current);
      autoPollRef.current = null;
    }
  }
  // 卸载时停止轮询（任务在服务端继续运行，不受页面影响）
  useEffect(() => () => stopAutoPoll(), []);

  // 打开小说 / 刷新恢复：检查未完成会话（running → 控制台+轮询；paused → 控制台）
  useEffect(() => {
    if (!world || autoCheckedRef.current === world.title) return;
    autoCheckedRef.current = world.title;
    void (async () => {
      const s = await fetchAutoStatus();
      if (!s) return;
      if (s.status === "running" || s.status === "paused") {
        setShowAutoPanel(true);
        if (s.status === "running") startAutoPoll();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  // —— P4 自动连载：SSE 消费 auto 事件流（delta 流式预览；review-failed 停下；auto-done 报告） ——
  // 存量"需修改"章节（revise）：自动连载前置检查——审查未通过不允许连载
  const reviseChapters = (world?.chapters ?? []).filter((c) => c.review?.verdict === "revise");
  async function startAutoRun(chapters: number) {
    if (!world || busy || autoRunning) return;
    if (reviseChapters.length) {
      showToast(`存在 ${reviseChapters.length} 章需修改（第 ${reviseChapters.map((c) => c.index).join("、")} 章），请先 AI 修复或手动修改后再连载。`);
      return;
    }
    setAutoRunning(true);
    setBusy(true);
    setLiveDraft("");
    stopAutoPoll(); // 本页 SSE 直连，无需轮询
    void fetchAutoStatus(); // 运行前同步会话基础数据（控制台可用）
    let interrupted = false;
    try {
      const res = await fetch("/api/novel/auto/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, maxChapters: chapters }),
      });
      if (res.status === 409) throw new Error("该书自动连载已在运行中，请先停止");
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      type AutoReportView = { written?: number; reason?: string; avgScore?: number | null; failedChapter?: number };
      let report: AutoReportView | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          let ev: { phase?: string; delta?: string; chapter?: number; written?: number; round?: number; error?: string; reason?: string; resumedFrom?: number; eval?: { overall?: number }; report?: AutoReportView };
          try { ev = JSON.parse(t.slice(5).trim()); } catch { continue; }
          if (ev.error) throw new Error(ev.error);
          if (ev.phase === "delta" && ev.delta) setLiveDraft((d) => d + ev.delta);
          if (ev.phase === "writing") { setLiveDraft(""); setBusyPhase(`自动连载：第 ${ev.chapter} 章写作中（第 ${ev.round ?? 1} 稿）…`); }
          if (ev.phase === "reviewing") setBusyPhase(`自动连载：第 ${ev.chapter} 章审查中…`);
          if (ev.phase === "settling") setBusyPhase(`自动连载：第 ${ev.chapter} 章结算中…`);
          if (ev.phase === "review-failed") { setBusyPhase(`自动连载：第 ${ev.chapter} 章审查未通过，已停下`); }
          // SSE 事件同步控制台会话（实时进度：阶段 + 已写章数）
          if (ev.phase === "writing" || ev.phase === "reviewing" || ev.phase === "settling" || ev.phase === "review-failed") {
            const phaseText = ev.phase === "writing" ? `第 ${ev.chapter} 章写作中（第 ${ev.round ?? 1} 稿）` : ev.phase === "reviewing" ? `第 ${ev.chapter} 章审查中` : ev.phase === "settling" ? `第 ${ev.chapter} 章结算中` : `第 ${ev.chapter} 章审查未通过，已停下`;
            setAutoSession((s) => (s && (s.status === "running" || s.status === "paused") ? { ...s, phase: phaseText, written: typeof ev.written === "number" && ev.written > 0 ? ev.written : s.written } : s));
          }
          if (ev.phase === "interrupted") { interrupted = true; showToast("自动连载被干预打断（草稿未存档）。"); break; }
          if (ev.phase === "auto-status") {
            if (ev.reason === "resumed") showToast(`检测到上次中断的连载（已写至第 ${ev.resumedFrom ?? "?"} 章），已从断点继续。`);
            else if (ev.reason === "eval" && typeof ev.eval?.overall === "number") showToast(`整书评估完成（已写 ${ev.written} 章）：均分 ${ev.eval.overall.toFixed(1)}`);
          }
          if (ev.phase === "auto-done" && ev.report) report = ev.report;
        }
      }
      await refreshWorld();
      await fetchAutoStatus();
      const reasonText: Record<string, string> = {
        done: "已完成目标章数", complete: "全书完结", stopped: "已手动停止",
        interrupted: "被干预打断", score: "评分熔断（连续低分）", quota: "额度/限流暂停", error: "连续失败暂停", review: "审查未通过暂停",
      };
      if (report?.reason === "review") {
        setShowAutoPanel(true);
        showToast(`连载暂停：第 ${report.failedChapter} 章审查未通过，问题已记账，请重试或跳过。`);
      } else if (report) {
        showToast(`自动连载结束：写了 ${report.written ?? 0} 章（${reasonText[report.reason ?? ""] ?? report.reason ?? ""}）${report.avgScore ? `，均分 ${report.avgScore.toFixed(1)}` : ""}`);
      } else if (!interrupted) {
        // 流正常结束但未收到 auto-done：连接中途断开，服务端可能仍在续写
        showToast("连接中断：自动连载可能仍在服务端继续，请刷新后核对章节数。");
      }
    } catch (e) {
      showToast("自动连载失败: " + (e as Error).message);
    } finally {
      setAutoRunning(false);
      setBusy(false);
      setBusyPhase("");
      setLiveDraft("");
    }
  }

  /** 重试暂存区章节并继续（runAuto 检测 pending 自动走 retryChapter） */
  async function retryAutoChapter() {
    if (!autoSession) return;
    setShowAutoPanel(false);
    await startAutoRun(autoSession.target ?? 5);
  }

  /** 跳过暂存区章节继续（丢弃草稿，直接写下一章） */
  async function skipAutoChapter() {
    if (!world || !autoSession) return;
    try {
      const res = await fetch("/api/novel/auto/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!d.ok) throw new Error(d.error ?? "跳过失败");
      setShowAutoPanel(false);
      await refreshWorld();
      await startAutoRun(autoSession.target ?? 5);
    } catch (e) {
      showToast("跳过失败: " + (e as Error).message);
    }
  }

  /** 放弃/关闭会话：清理服务端会话与暂存区（已写章节保留） */
  async function discardAutoSession() {
    if (!world) return;
    try {
      await fetch("/api/novel/auto/clear-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title }),
      });
    } catch { /* 清理失败不打扰 */ }
    stopAutoPoll();
    setAutoSession(null);
    setAutoPending(null);
    setShowAutoPanel(false);
    setShowAutoStart(false);
  }

  async function stopAutoRun() {
    if (!world) return;
    try {
      await fetch("/api/novel/auto/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title }),
      });
      showToast("已发送停止指令，将在本章结束后停下。");
    } catch {
      showToast("停止指令发送失败");
    }
  }

  // 立即打断：当前章草稿不存档（写作中干预打断，用户决策②）
  async function interruptAutoRun() {
    if (!world) return;
    try {
      const res = await fetch("/api/novel/intervene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, action: "interrupt", kind: "user-stop", detail: "用户手动打断" }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!d.ok) throw new Error(d.error ?? "打断失败");
      showToast("已请求打断，当前章草稿将不存档。");
    } catch (e) {
      showToast("打断指令发送失败: " + (e as Error).message);
    }
  }

  // 回溯重写队列消费（L2 策略 rewrite：逐章重生成受影响章节）
  async function runRewrite() {
    if (!world) return;
    if (!requireIdle()) return; // 运行锁：回溯重写禁止
    setBusy(true);
    setBusyPhase("回溯重写中…");
    try {
      const res = await fetch("/api/novel/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, action: "start" }),
      });
      const d = (await res.json()) as { ok?: boolean; rewritten?: number; interrupted?: boolean; error?: string };
      if (!d.ok) throw new Error(d.interrupted ? "重写被干预打断（已完成的章节已保存）" : (d.error ?? "重写失败"));
      await refreshWorld();
      showToast(`已重写 ${d.rewritten ?? 0} 章。`);
    } catch (e) {
      showToast("重写失败: " + (e as Error).message);
    } finally {
      setBusy(false);
      setBusyPhase("");
    }
  }

  async function clearRewriteQueue() {
    if (!world) return;
    if (!requireIdle()) return; // 运行锁：队列清理属编辑类
    try {
      await fetch("/api/novel/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, action: "clear" }),
      });
      await refreshWorld();
    } catch {
      showToast("清空队列失败");
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
    if (!requireIdle()) return; // 运行锁：版本切换禁止
    try {
      const res = await fetch("/api/novel/chapter/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, index: c.index, versionIndex }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; report?: IntegrityReportView; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "回滚失败");
      setWorld(data.world);
      setShowVersions(false);
      showChangeReport(data.report, c.index);
      showToast(`已回滚到第 ${c.index} 章的版本 ${versionIndex + 1}`);
    } catch (e) {
      setRollbackMsg("回滚失败: " + (e as Error).message);
    }
  }

  // 世界书操作：auto（自动生成条目，设定面板「自动生成条目」按钮使用）；
  // save 分支已废弃——手动保存合并到 /api/novel/world（设定面板单接口保存），保留兼容
  async function saveLore(action: "auto" | "save", entries?: LoreEntry[]): Promise<LoreEntry[] | null> {
    if (!world) return null;
    if (!requireIdle()) return null; // 运行锁：世界书/设定编辑禁止
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

  // 字段锁：上锁/解锁角色字段（P3.5）
  async function toggleLock(characterId: string, field: string, locked: boolean): Promise<boolean> {
    if (!world) return false;
    try {
      const res = await fetch("/api/novel/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, characterId, field, locked }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "操作失败");
      setWorld(data.world);
      showToast(locked ? "字段已上锁，AI 记账不再覆盖。" : "字段已解锁，恢复 AI 自动维护。");
      return true;
    } catch (e) {
      showToast("锁操作失败: " + (e as Error).message);
      return false;
    }
  }

  async function onGachaApplied(instructions: string[], applied: Card[]) {
    await refreshWorld();
    showToast(
      `抽中 ${applied.length} 张卡：${applied.map((c) => `${c.rarity}·${c.title}`).join("、")}。` +
        (instructions.length ? " 指令已注入下一章。" : ""),
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
    (world?.chapters.length ? `第 ${world!.nextChapter} 章待写作` : "待机");

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
    const anyOpen = showGacha || showSettings || showVersions || !!relModal || showNewStory || reviewOpen || !!confirmMsg || showAutoPanel || showAutoStart;
    document.body.style.overflow = anyOpen ? "hidden" : "";
  }, [showGacha, showSettings, showVersions, relModal, showNewStory, reviewOpen, confirmMsg, showAutoPanel, showAutoStart]);

  // 全局键盘 / 点击外部 / 滚动关闭浮动菜单
  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (chapterMenu) setChapterMenu(null);
        else if (confirmMsg) cancelConfirm();
        else if (deletePreview) setDeletePreview(null);
        else if (integrityView) setIntegrityView(null);
        else if (regenMedia) setRegenMedia(null);
        else if (mediaPlan) setMediaPlan(null);
        else if (showNewStory) setShowNewStory(false);
        else if (showGacha) setShowGacha(false);
        else if (showSettings) setShowSettings(false);
        else if (showAutoStart) setShowAutoStart(false);
        else if (showAutoPanel) setShowAutoPanel(false);
        else if (portraitView) setPortraitView(null);
        else if (relModal) setRelModal(null);
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
  }, [chapterMenu, confirmMsg, showNewStory, showGacha, showSettings, relModal, showVersions, reviewOpen, regenMedia, mediaPlan, deletePreview, integrityView]);

  // 流派标签高亮同步（active 类仅客户端同步，避免 SSR 差异；点击事件内联在按钮上）
  const genreTagsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = genreTagsRef.current;
    if (!el) return;
    const syncActive = () => {
      const btns = el.querySelectorAll("[data-gi]");
      btns.forEach((btn) => {
        const idx = Number((btn as HTMLElement).dataset.gi);
        btn.classList.toggle("active", GENRE_TEMPLATES[idx]?.genre === genre);
      });
    };
    syncActive(); // 弹窗打开 / 题材变化时同步高亮（客户端 only）
  }, [genre, showNewStory]);

  return (
    <>
      {phase === "landing" && (
        <div className="landing landing-list">
          <header className="landing-header">
            <span className="landing-seal" aria-hidden="true">墨 枢</span>
          </header>

          {/* 小说列表 */}
          <div className="story-list-section">
            <div className="story-list-header">
              <span className="story-list-label">我的作品</span>
              <button className="btn-new-story" onClick={() => setShowNewStory(true)}>+ 新建</button>
            </div>

            {stories.length > 0 ? (
              <div className="story-list">
                {stories.map((s, i) => (
                  <div className="story-card" style={{ animationDelay: `${i * 0.06}s` }} onClick={() => openStory(s.title)} key={s.slug}>
                    {s.cover ? (
                      <img className="story-card-cover" src={`/api/novel/asset?title=${encodeURIComponent(s.title)}&path=${encodeURIComponent(s.cover)}`} alt={s.title} />
                    ) : (
                      <div className="story-card-cover story-card-cover-placeholder">{s.title.slice(0, 1)}</div>
                    )}
                    <div className="story-card-info">
                      <div className="story-card-title">《{s.title}》</div>
                      <div className="story-card-meta">
                        {s.genre && <span className="story-card-genre">{s.genre}</span>}
                        <span>{s.chapters} 章</span>
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
        <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowNewStory(false); }}>
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
                  <button
                    className="genre-tag"
                    data-gi={i}
                    type="button"
                    key={i}
                    onClick={() => { setIdea(t.idea); setGenre(t.genre); }}
                  >
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
            chapter={shownChapter}
            onBackToList={backToList}
            onOpenSettings={() => { setShowSettings(true); void refreshWorld(); }}
            brain={(
              <BrainIndicator
                action={busyPhase || ((autoSession?.status === "running" || autoSession?.status === "paused") && autoSession.phase ? `连载·${autoSession.phase}` : "")}
                busy={Boolean(busyPhase) || autoSession?.status === "running"}
                onClick={() => setShowMemoryAudit(true)}
              />
            )}
          />

          <div className="game-grid">
            {/* 左栏：目录 / 脉络（只读速览，设定统一在设置面板操作） */}
            <LeftPanel
              world={world}
              activeChapter={activeIdx}
              taskActive={taskActive}
              onWorldUpdate={(nw) => setWorld(nw)}
              onToast={showToast}
              onOpenChar={(id) => setRelModal({ editable: false, charId: id })}
              onSelectChapter={(i) => {
                setActiveIdx(i);
                // 路由记录选中章节（-1 = 跟随最新章节 → 记录为最新章节具体 index，刷新后回到该章）
                const record = i > 0 ? i : (world.chapters[world.chapters.length - 1]?.index ?? undefined);
                setStoryUrl(world.title, record);
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
                    <button className="btn-save" data-menu-trigger onClick={toggleChapterMenu}><MoreHorizontal size={13} /> 更多 <ChevronDown size={11} className="chevron" /></button>
                  </div>
                )}
                {editing && (
                  <div className="editor-tools">
                    <button className="btn" onClick={() => setEditing(false)}>取消</button>
                    <button className="btn btn-primary" onClick={saveEdit} disabled={busy} title={busy ? "任务运行中已禁止内容修订——请先取消任务" : undefined}>
                      {busy ? "保存中…" : "保存修改"}
                    </button>
                  </div>
                )}
              </div>
              <div className="center-scroll">
                {/* P4 实时写作预览（delta 流式打字机） */}
                {liveDraft && (
                  <div style={{ marginBottom: "1rem", border: "1px dashed var(--line-strong)", padding: "0.9rem 1rem", background: "var(--paper-dark)" }}>
                    <div style={{ fontSize: "0.72rem", fontFamily: "var(--sans)", color: "var(--seal)", marginBottom: "0.4rem" }}>✍ 实时写作中…</div>
                    <div style={{ fontSize: "0.86rem", lineHeight: 1.9, whiteSpace: "pre-wrap" }}>{liveDraft}<span style={{ opacity: 0.5 }}>▌</span></div>
                  </div>
                )}
                {editing && (
                  <div className="editor-box">
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
                  </div>
                )}
                {/* 编辑模式时隐藏正文渲染，仅显示编辑器 */}
                {!editing && (
                  <>
                    <ChapterView chapter={shownChapter} storyTitle={world.title} writing={busyPhase.includes("写作")} review={shownReview} reviewMode={reviewMode} activeFindingIdx={activeFindingIdx} onMarkClick={handleMarkClick} onMediaAction={(m) => {
                      if (!shownChapter || busy || mediaGen) return;
                      setRegenMedia({ chapterIndex: shownChapter.index, media: m, prompt: m.prompt ?? "" });
                    }} onMediaDelete={(m) => { if (!busy && !mediaGen) deleteMedia(m); }} />
                    {/* 媒体生成内联进度（插画/视频通用，不锁全局；完成后媒体在 ChapterView 对应句子后渲染） */}
                    {mediaGen && mediaGen.chapterIndex === shownChapter?.index && (
                      <div style={{ marginTop: "0.8rem", border: "1px dashed var(--line-strong)", padding: "0.7rem 0.9rem", background: "var(--paper-dark)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem", color: "var(--ink-soft)", marginBottom: "0.5rem" }}>
                          <Wand2 size={14} />
                          <span>{mediaGen.mediaIds.length > 1 ? `插画生成中（${mediaGen.mediaIds.length} 张并发）…` : "媒体生成中…"}</span>
                        </div>
                        <div style={{ height: "6px", background: "var(--paper)", border: "1px solid var(--line)", borderRadius: "3px", overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${mediaGen.mediaIds.length > 1 ? 40 : Math.max(0, mediaGen.progress)}%`, background: "var(--seal)", transition: "width 0.4s ease" }} />
                        </div>
                      </div>
                    )}
                    {/* 审查报告已移入独立审查面板（右上角「审查报告」按钮 / 版本历史弹窗入口） */}
                  </>
                )}
              </div>
            </div>

            {/* 右栏：进度 + 状态面板（人物/伏笔账随当前选中章节联动，只读；头像点击仅只读预览立绘） */}
            <StatusPanel world={world} busyPhase={busyPhase} currentChapter={shownChapter?.index ?? null} onViewPortrait={(c) => openPortrait(c, true)} />
          </div>

          {/* P3.5 新角色提案横幅：确认前不入册、不写入正文 */}
          {pendingProposals.length > 0 && (
            <div style={{ padding: "0.5rem 1rem", borderTop: "1px dashed var(--line-strong)", background: "var(--paper-dark)", display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap", fontSize: "0.78rem" }}>
              <b style={{ fontFamily: "var(--sans)" }}>新角色提案（{pendingProposals.length}）：</b>
              {pendingProposals.slice(0, 3).map((p) => (
                <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", border: "1px solid var(--line)", padding: "0.15rem 0.5rem", background: "var(--paper)" }}>
                  「{p.name}」{p.role}（{p.source === "gacha" ? "抽卡" : "剧情"}）
                  <button className="btn-save" disabled={busy} onClick={() => proposalAction(p.id, "confirm")}>确认入册</button>
                  <button className="btn-save btn-danger-sm" disabled={busy} onClick={() => proposalAction(p.id, "reject")}>拒绝</button>
                </span>
              ))}
              {pendingProposals.length > 3 && <span style={{ color: "var(--ink-soft)" }}>…等 {pendingProposals.length} 项</span>}
            </div>
          )}

          {toast && (
            <div className={`toast-toast ${toastVisible ? "toast-in" : "toast-out"}`}>{toast}</div>
          )}

          {/* 底部控制条：角色入口（最左）+ 状态 + 指令输入 + 抽卡 + 推进 */}
          <nav className="control-bar">
            {/* 手工处理类入口：运行锁统一由 requireIdle/taskActive 管控（任务运行中全面禁止） */}
            <button className="bar-icon-btn" title={taskActive ? "任务运行中已禁止角色编辑——请先取消任务" : "角色与关系"} onClick={() => { if (requireIdle()) setRelModal({ editable: true, charId: null }); }}>
              <Users size={17} />
            </button>
            <button className="bar-icon-btn" title={taskActive ? "任务运行中已禁止伏笔编辑——请先取消任务" : "伏笔账（增删改）"} onClick={() => { if (requireIdle()) setShowForeshadow(true); }}>
              <BookMarked size={16} />
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
            <button className="btn btn-ghost" onClick={() => setShowGacha(true)} disabled={busy || autoRunning} title={busy || autoRunning ? "任务运行中已禁用（抽卡属 AI 类操作）" : undefined}>
              <Dices size={15} /> 抽卡
            </button>
            <button className="btn btn-ghost" onClick={() => setShowEval(true)} disabled={busy || autoRunning || !world.chapters.length} title={busy || autoRunning ? "任务运行中已禁用（评估属 AI 类操作）" : "整书 8 维评估 + 质量债务"}>
              <Search size={15} /> 评估
            </button>
            {autoRunning ? (
              <button className="btn btn-danger-sm" onClick={interruptAutoRun} title="立即中断当前章（草稿不存档）">
                立即打断
              </button>
            ) : null}
            {autoRunning ? (
              <button className="btn" onClick={stopAutoRun}>
                <X size={15} /> 停止连载
              </button>
            ) : null}
            {(autoSession?.status === "running" || autoSession?.status === "paused") && (
              <button className="btn" onClick={() => setShowAutoPanel(true)} title="查看连载进度与操作（停止/重试/跳过）">
                <History size={15} /> 连载控制台
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => setShowTaskCenter(true)} title="任务中心：连载/推进任务进度步骤可视化 + 暂停/恢复/移除 + 确认入册">
              <List size={15} /> 任务中心
            </button>
            {!autoRunning && (
              <button className="btn btn-ghost" onClick={() => setShowAutoStart(true)} disabled={busy || reviseChapters.length > 0} title={reviseChapters.length > 0 ? `存在 ${reviseChapters.length} 章需修改，请先 AI 修复或手动修改后再自动连载` : "自动连续写多章：每章审查通过才提交，审查不过会停下登记问题（可重试/跳过）"}>
                <Play size={15} /> 自动连载
              </button>
            )}
            <button className="btn btn-primary" onClick={advance} disabled={busy}>
              {busy ? "进行中…" : (<><Play size={15} /> 推进剧情</>)}
            </button>
          </nav>
          {(world.rewriteQueue ?? []).length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.5rem", fontSize: "0.78rem", padding: "0.4rem 0.7rem", background: "var(--paper-dark)", border: "1px dashed var(--line)" }}>
              <span>{(world.rewriteQueue ?? []).length} 章待回溯重写（受 L2 变更影响）</span>
              <button className="btn-save btn-xs" onClick={runRewrite} disabled={busy || autoRunning} title={busy || autoRunning ? "任务运行中已禁用（AI 重写）" : undefined}><PenLine size={11} /> 开始重写</button>
              <button className="btn-save btn-xs" onClick={clearRewriteQueue} disabled={busy}>清空队列</button>
            </div>
          )}
        </div>
      )}

      {/* 中枢弹窗一：分层记忆 · 台账 · 操作日志（点击报头中枢指示器打开） */}
      {showMemoryAudit && world && (
        <MemoryAuditModal world={world} onClose={() => setShowMemoryAudit(false)} />
      )}

      {/* 任务中心（弹窗二）：连载/推进任务进度步骤可视化 + 暂停/恢复/移除/取消 + 确认入册 */}
      {showTaskCenter && world && (
        <TaskCenterModal
          title={world.title}
          session={autoSession}
          pending={autoPending}
          advancePhase={busyPhase}
          advanceBusy={busy && !autoRunning}
          autoRunning={autoRunning}
          pendingCommitIdx={pendingCommitIdx}
          onClose={() => setShowTaskCenter(false)}
          onPause={pauseAutoRun}
          onResume={() => { setShowTaskCenter(false); void resumeAutoRun(); }}
          onRemove={removeAutoTask}
          onOpenAutoStart={() => { setShowTaskCenter(false); setShowAutoStart(true); }}
          onCancelAdvance={cancelAdvance}
          onConfirmPending={confirmPendingCommit}
          onRejectPending={rejectPendingCommit}
          onOpenAutoPanel={() => { setShowTaskCenter(false); setShowAutoPanel(true); }}
        />
      )}

      {/* 伏笔账编辑弹窗（底部控制条角色与关系旁入口） */}
      {showForeshadow && world && (
        <ForeshadowModal world={world} onClose={() => setShowForeshadow(false)} onWorldUpdate={(nw) => setWorld(nw)} showToast={showToast} taskActive={taskActive} />
      )}

      {showGacha && world && (
        <GachaModal world={world} onClose={() => setShowGacha(false)} onApplied={onGachaApplied} />
      )}

      {/* 连载控制台：进度 / 每章状态 / 审查失败详情 / 停止·重试·跳过·放弃 */}
      {showAutoPanel && world && autoSession && (
        <AutoRunPanel
          session={autoSession}
          pending={autoPending}
          debtCount={(world.qualityDebt ?? []).filter((d) => d.status === "open").length}
          onStop={stopAutoRun}
          onInterrupt={interruptAutoRun}
          onRetry={retryAutoChapter}
          onSkip={skipAutoChapter}
          onDiscard={discardAutoSession}
          onClose={() => setShowAutoPanel(false)}
          onOpenEval={() => setShowEval(true)}
        />
      )}

      {/* 自动连载启动确认（二次确认 + 章数配置） */}
      {showAutoStart && world && (
        <div className="modal-overlay" onClick={() => setShowAutoStart(false)}>
          <div className="auto-start-box" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontFamily: "var(--sans)", marginBottom: "0.6rem" }}>自动连载</h3>
            <div style={{ fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem" }}>
              目标章数：
              <input
                type="number"
                min={1}
                max={30}
                value={autoChapters}
                onChange={(e) => setAutoChapters(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                style={{ width: "5rem", padding: "0.3rem 0.5rem", border: "1px solid var(--line-strong)", background: "var(--paper)" }}
              />
              <span style={{ color: "var(--ink-soft)" }}>（1~30）</span>
            </div>
            <p style={{ fontSize: "0.76rem", color: "var(--ink-soft)", marginBottom: "0.9rem", lineHeight: 1.7 }}>
              每章写作→审查→通过才提交（入册/记账/伏笔/章纲联动）；<br />
              审查不通过会停下并登记问题，可重试修正或跳过本章继续。<br />
              中途可随时停止/打断；刷新页面与服务重启均不会中断任务。
            </p>
            {reviseChapters.length > 0 && (
              <p style={{ color: "var(--seal)", fontSize: "0.76rem", marginBottom: "0.9rem", lineHeight: 1.7 }}>
                ⚠ 第 {reviseChapters.map((c) => c.index).join("、")} 章需修改：自动连载前请先 AI 修复（章节操作栏「AI 修复」或审查报告按钮），或手动修改后保存。
              </p>
            )}
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button className="btn btn-primary" disabled={reviseChapters.length > 0} onClick={() => { setShowAutoStart(false); void startAutoRun(autoChapters); }}>
                <Play size={14} /> 开始连载
              </button>
              <button className="btn" onClick={() => setShowAutoStart(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && world && (
        <SettingsModal
          world={world}
          onClose={() => setShowSettings(false)}
          onSave={(patch) => saveWorld(patch)}
          onImage={imageAction}
          onToggleLock={toggleLock}
          onLore={saveLore}
          onGenerateOutline={generateOutline}
          outlineBusy={outlineBusy}
          onExport={exportStory}
          onViewPortrait={(c) => openPortrait(c)}
          onWorldUpdate={(w) => setWorld(w)}
          taskActive={taskActive}
        />
      )}

      {relModal && world && (
        <RelationshipModal
          world={world}
          readOnly={!relModal.editable}
          selectedCharId={relModal.editable ? undefined : relModal.charId}
          onSelectCharacter={relModal.editable ? undefined : (id) => setRelModal((m) => (m ? { ...m, charId: id } : m))}
          onSaveRelations={relModal.editable ? (chars) => saveWorld({ characters: chars }) : undefined}
          onViewPortrait={(c) => openPortrait(c, !relModal.editable)}
          onClose={() => setRelModal(null)}
        />
      )}

      {/* P4 整书评估面板 */}
      {showEval && world && (
        <EvalModal
          world={world}
          onClose={() => setShowEval(false)}
          onToast={showToast}
          onWorldUpdate={(nw) => setWorld(nw)}
          taskActive={taskActive}
        />
      )}

      {/* P3.5 干预处理面板：L2 回溯变更三选一 */}
      {intervene && world && (
        <InterveneModal
          report={intervene.report}
          changeDesc={intervene.changeDesc}
          busy={busy}
          onChoose={chooseIntervention}
          onClose={() => setIntervene(null)}
        />
      )}

      {showVersions && world && shownChapter && (
        <div className="modal-mask" onClick={() => setShowVersions(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "820px" }}>
            <div className="modal-head">
              <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>版本历史 · 第 {shownChapter.index} 章</b>
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
                  <ReviewPanel
                    review={shownChapter.review}
                    writingRounds={shownChapter.review.round ?? 1}
                    foreshadowing={world.foreshadowing}
                    characters={world.characters}
                    world={world}
                    readOnly
                    activeCharId={relModal && !relModal.editable ? relModal.charId : null}
                    onOpenChar={(id) => setRelModal({ editable: false, charId: id })}
                  />
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
                  onOpenChar={(id) => setRelModal({ editable: false, charId: id })}
                  activeCharId={relModal && !relModal.editable ? relModal.charId : null}
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
              <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>审查报告 · 第 {shownChapter.index} 章</b>
              <button className="modal-close" onClick={() => setReviewOpen(false)}><X size={16} /></button>
            </div>
            <div className="review-drawer-body">
              {activeReview ? (
                <ReviewPanel
                  review={activeReview}
                  writingRounds={activeReview.round ?? 1}
                  foreshadowing={world.foreshadowing}
                  characters={world.characters}
                  world={world}
                  activeIdx={activeFindingIdx}
                  onCiteClick={handleCiteClick}
                  activeCharId={relModal && !relModal.editable ? relModal.charId : null}
                  onOpenChar={(id) => setRelModal({ editable: false, charId: id })}
                  onAiFix={activeReview?.verdict === "revise" ? () => { setReviewOpen(false); void regenerate(); } : undefined}
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
                AI 已为本章挑选以下关键场景，可修改画面说明与提示词后生成（媒体将插入到对应句子后方，紧贴该句）：
              </p>
              <div className="media-plan-list">
                {mediaPlan.scenes.map((s, i) => {
                  // 角色一致性提示：anchor 所在段落点名角色 vs scene 出现的角色名（服务端 extraChars 已审计）
                  const chp = world?.chapters.find((c) => c.index === mediaPlan.chapterIndex);
                  const paras = (chp?.text ?? "").split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
                  const na = s.anchor.replace(/[\s「」『』“”‘’"'()（）\[\]【】{}《》，。！？；：、—…,.!?;:'\-]/g, "");
                  const para = paras.find((p) => p.replace(/[\s「」『』“”‘’"'()（）\[\]【】{}《》，。！？；：、—…,.!?;:'\-]/g, "").includes(na));
                  const paraChars = para && world ? world.characters.filter((c) => c.name && para.includes(c.name)).map((c) => c.name) : [];
                  return (
                    <div className="media-plan-item" key={i}>
                      <div className="media-plan-anchor">{s.type && <span className={`chapter-media-type type-${s.type}`}>{s.type}</span>}▍{s.anchor.length > 60 ? s.anchor.slice(0, 60) + "…" : s.anchor}</div>
                      <input
                        className="media-plan-caption-input"
                        value={s.caption ?? ""}
                        placeholder="中文画面说明（可选：谁/什么状态/在做什么）"
                        onChange={(e) => updateMediaPlanScene(i, { caption: e.target.value })}
                      />
                      <textarea
                        className="media-plan-edit"
                        rows={3}
                        value={s.scene}
                        placeholder="画面提示词（中文；风格后缀自动拼接）"
                        onChange={(e) => updateMediaPlanScene(i, { scene: e.target.value })}
                      />
                      {s.extraChars && s.extraChars.length > 0 && (
                        <div className="media-plan-warn">
                          ⚠️ 提示词出现本段未出场角色：{s.extraChars.join("、")}（本段出场：{paraChars.length ? paraChars.join("、") : "无"}）——模型可能画出多余人物，建议删除或改为单人画面
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: "0.8rem", justifyContent: "flex-end", marginTop: "1rem" }}>
                <button className="btn" onClick={() => setMediaPlan(null)}>取消</button>
                <button className="btn btn-primary" disabled={mediaPlan.scenes.some((s) => !s.scene.trim())} onClick={() => void confirmMediaGen()}>确认生成</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 改词重生成：预填当前提示词，修改后单张重新生成（风格后缀服务端自动保留） */}
      {regenMedia && (
        <div className="modal-mask" onClick={() => setRegenMedia(null)}>
          <div className="modal modal-stable" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "560px" }}>
            <div className="modal-head">
              <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>
                {regenMedia.media.kind === "video" ? "重生成视频" : "重生成插画"}
              </b>
              <button className="modal-close" onClick={() => setRegenMedia(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: "0.8rem", color: "var(--ink-soft)", marginBottom: "0.7rem" }}>
                对应段落：「{regenMedia.media.anchor.length > 50 ? regenMedia.media.anchor.slice(0, 50) + "…" : regenMedia.media.anchor}」
              </p>
              <textarea
                className="regen-prompt-input"
                value={regenMedia.prompt}
                onChange={(e) => setRegenMedia((r) => (r ? { ...r, prompt: e.target.value } : r))}
                rows={5}
                placeholder="用中文描述画面内容（人物/状态/场景；风格后缀会自动保留）"
              />
              
              <div style={{ display: "flex", gap: "0.8rem", justifyContent: "flex-end", marginTop: "1rem" }}>
                <button className="btn" onClick={() => setRegenMedia(null)}>取消</button>
                <button className="btn btn-primary" disabled={!regenMedia.prompt.trim() || busy || !!mediaGen} onClick={() => void regenerateMedia()}>确认重生成</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 角色全局立绘预览：大图 + 生成/重新生成（无立绘时占位并可直接生成）；key 保证切换角色/重新打开时描述框重置 */}
      {portraitView && world && (
        <PortraitModal
          key={portraitView.id}
          storyTitle={world.title}
          character={world.characters.find((c) => c.id === portraitView.id) ?? portraitView}
          busy={portraitBusy}
          onGenerate={(description) => void generatePortrait(description)}
          onClose={() => setPortraitView(null)}
          readOnly={portraitReadOnly}
        />
      )}

      {/* 删章两阶段：影响预览（含伏笔/离场/媒体/语义冲突）→ 确认删除/放弃 */}
      {deletePreview && (
        <IntegrityModal
          title={`删除第 ${deletePreview.index} 章《${deletePreview.chapterTitle}》 · 影响评估`}
          desc="删除后不可恢复：章号允许空号（不重排），账本将级联清理。请确认以下影响："
          report={deletePreview.report}
          mode="confirm"
          busy={busy}
          onConfirm={() => void confirmDeleteChapter()}
          onClose={() => setDeletePreview(null)}
        />
      )}

      {/* 一致性报告：巡检/变更后检查结果（巡检态带一键修复） */}
      {integrityView && (
        <IntegrityModal
          title={integrityView.title}
          desc={integrityView.desc}
          tip={integrityView.tip}
          report={integrityView.report}
          busy={busy}
          onRepair={integrityView.repairable ? () => void repairIntegrity() : undefined}
          onClose={() => setIntegrityView(null)}
        />
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
          {/* 生成插画（1~3 张）：LLM 挑选关键场景 → 确认选中段落 → 段落锚定生成；每章上限 3 张，超限禁用 */}
          <div className="menu-imgen">
            <span className="menu-imgen-label"><Wand2 size={14} /> 生成插画{(() => {
              const imgCount = (shownChapter?.media ?? []).filter((x) => x.kind === "image").length;
              return <span className="menu-imgen-count">（{imgCount}/3）</span>;
            })()}</span>
            <span className="menu-imgen-counts">
              {[1, 2, 3].map((n) => {
                const imgCount = (shownChapter?.media ?? []).filter((x) => x.kind === "image").length;
                const overLimit = imgCount + n > 3;
                return (
                  <button key={n} className="menu-imgen-num" disabled={busy || !!mediaGen || overLimit} title={overLimit ? `本章已有 ${imgCount} 张插画（上限 3 张），请先删除部分插画` : undefined} onClick={() => { setChapterMenu(null); void planMedia("image", n); }}>{n}张</button>
                );
              })}
            </span>
          </div>
          <button onClick={() => { void planMedia("video", 1); setChapterMenu(null); }} disabled={busy || !!mediaGen}><Video size={14} /> 生成视频</button>
          <button onClick={() => { reReview(); setChapterMenu(null); }} disabled={busy}><Search size={14} /> 重新审查</button>
          {shownChapter?.review?.verdict === "revise" ? (
            <button onClick={() => { setChapterMenu(null); askConfirm("确定要按审查意见 AI 修复本章？当前内容将被覆盖（可在版本历史中回滚）。", regenerate); }} disabled={busy || autoRunning} title={busy || autoRunning ? "任务运行中已禁用（AI 修复）" : undefined}><Sparkles size={14} /> AI 修复本章</button>
          ) : (
            <button onClick={() => { setChapterMenu(null); askConfirm("确定要 AI 重写本章？当前内容将被覆盖（可在版本历史中回滚）。", regenerate); }} disabled={busy}><Sparkles size={14} /> AI 重写本章</button>
          )}
          <button onClick={() => { setChapterMenu(null); askConfirm("以当前正文重新结算本章账本（角色状态/伏笔/时间线）？正文与审查不变；删除该章时恢复将更精确。", resettleChapter); }} disabled={busy || autoRunning} title={busy || autoRunning ? "任务运行中已禁用（重算账本）" : undefined}><RefreshCw size={14} /> 重算本章账本</button>
          <button onClick={() => { void runIntegrityScan(); }} disabled={busy}><Search size={14} /> 一致性巡检</button>
          {/* 删章属编辑类：运行锁统一禁止（函数内 requireIdle 兜底） */}
          <button onClick={() => { void requestDeleteChapter(); }} disabled={busy || !!mediaGen}><AlertTriangle size={14} /> 删除本章</button>
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
  /** 版本内审查面板的角色弹窗接线（顶层共享实例） */
  onOpenChar?: (charId: string) => void;
  activeCharId?: string | null;
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
          <ReviewPanel
            review={p.v.review}
            writingRounds={p.v.review.round ?? 1}
            characters={p.world.characters}
            world={p.world}
            readOnly
            onOpenChar={p.onOpenChar}
            activeCharId={p.activeCharId}
          />
        </div>
      )}
    </div>
  );
};

export default Home;
