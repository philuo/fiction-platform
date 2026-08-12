// 中枢聊天会话（brain sessions）：多会话模型 + 持久化 + 会话级生成任务注册表
// 存储：data/<username>/<slug>/brain-sessions.json（原子写 tmp + rename，复用 storage.ts 模式）；
// 用户目录随会话隔离：不同账号的同名书会话互不可见。
//
// 关键设计：
// 1. 流式生成中，会话消息在**内存**实时更新（不逐 delta 落盘，避免 IO 尖峰）；
//    关键节点（回合开始 / 完成 / 中断）落盘。服务器重启仅丢失"未完成消息的尾部增量"。
// 2. 会话级生成任务注册表：SSE 连接断开**不杀死**生成任务，任务继续写会话内存；
//    刷新后新连接 attach 到同一任务，立即重放已生成文本（resume 事件）再收后续 delta，
//    从而支撑"刷新恢复状态、流式输出完成"且不重复生成。
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { slugify, currentUser } from "./storage";
import { uuid } from "../shared/uuid";

export type BrainChatRole = "user" | "assistant";

/** 卡片 JSON：与 components/brain-cards.tsx 的 BrainCard 一致（kind/title/…），后端透传前端渲染 */
export type BrainChatCard = Record<string, unknown>;

export type BrainChatMsg = {
  id: string;
  role: BrainChatRole;
  /** 消息正文：流式生成中实时追加 */
  text: string;
  /** DeepSeek 思维链内容（思考模式开启时流式累积，与正文分离存储）；折叠展示用 */
  thinking?: string;
  /** 完成后携带的卡片（预览/确认/结果/浏览/计划/意见询问） */
  cards?: BrainChatCard[];
  /** epoch ms */
  at: number;
  /** 生成中（未完成）；刷新恢复据此识别可续流消息 */
  pending?: boolean;
  /** 被用户中断 */
  interrupted?: boolean;
  /** 系统事件消息（kind="system"）：系统状态变化自动注入会话（连载提交/任务完成等），前端灰色系统条渲染 */
  kind?: "system";
};

export type BrainSession = {
  id: string;
  /** 会话标题：首条用户消息截断生成 */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: BrainChatMsg[];
  /** 当前是否有进行中的生成回合（供前端渲染运行中波纹） */
  streaming: boolean;
  /** 已执行的卡片操作 key（`消息id:卡片下标[:列表项id]`）：服务端持久化，刷新后随详情返回，前端恢复完成态 */
  completed?: string[];
  /** 已注入的系统事件 id（幂等去重：同一事件不重复注入聊天会话） */
  systemNotes?: string[];
};

/** WS 同步快照使用的权威会话状态。消息/卡片完整返回，便于刷新或多 Tab 直接覆盖本地缓存。 */
export function listSyncSessionSnapshots(title: string): BrainSession[] {
  // streaming/pending 是进程内流任务的镜像。服务重启后任务注册表必为空，落盘的 true
  // 不能继续作为权威状态，否则所有新连接都会把会话卡永久恢复成 loading。
  const sessions = loadSessions(title);
  let dirty = false;
  for (const s of sessions) {
    if ((!s.streaming && !s.messages.some((m) => m.pending)) || isSessionRunning(title, s.id)) continue;
    s.streaming = false;
    for (const m of s.messages) {
      if (!m.pending) continue;
      m.pending = false;
      m.interrupted = true;
    }
    s.updatedAt = Date.now();
    dirty = true;
  }
  if (dirty) saveSessions(title, sessions);
  return listSessions(title);
}

export function sessionHasAsyncState(s: BrainSession): boolean {
  return s.streaming || s.messages.some((m) =>
    m.pending || (m.cards ?? []).some((c) => c?.status === "running" || c?.status === "pending"),
  );
}

/** 单会话消息条数上限（防文件膨胀；超出丢最旧） */
const MAX_MESSAGES = 100;

// —— 持久化：data/<username>/<slug>/brain-sessions.json（内存缓存 + 写时同步落盘） ——

const cache = new Map<string, BrainSession[]>();

/** 缓存 key：用户前缀 + slug，不同账号的同名书会话缓存互不串扰 */
function cacheKey(title: string): string {
  return `${currentUser() ?? ""}::${slugify(title)}`;
}

/** 删书后清理当前用户上下文下该书的会话缓存（按 title；已知用户上下文时调用）。
 *  同时清掉无用户前缀的遗留 key；删书时不知用户请用 invalidateStoryBySlug。 */
export function invalidateStoryCache(title: string): void {
  const slug = slugify(title);
  cache.delete(cacheKey(title));
  cache.delete(slug); // 兼容遗留/无用户上下文的裸 slug key
}

/** 按 slug 清理所有用户下该书的会话缓存（deleteStory 按 slug 删目录、可能不知用户名时调用）：
 *  删除 key===slug 或以 ::<slug> 结尾的全部条目。 */
export function invalidateStoryBySlug(slug: string): void {
  const suffix = `::${slug}`;
  for (const key of [...cache.keys()]) {
    if (key === slug || key.endsWith(suffix)) cache.delete(key);
  }
}

function sessionsPath(title: string): string {
  return join(sessionsDir(title), "brain-sessions.json");
}

/** 数据根：默认 <cwd>/data；测试可用 BRAIN_SESSIONS_DATA_DIR 覆盖（生产不设置） */
export function dataRoot(): string {
  return process.env.BRAIN_SESSIONS_DATA_DIR || join(process.cwd(), "data");
}

/** 会话目录：data/<username>/<slug>（无用户上下文时 data/<slug>，兼容遗留/测试） */
export function sessionsDir(title: string): string {
  return join(dataRoot(), currentUser() ?? "", slugify(title));
}

export function loadSessions(title: string): BrainSession[] {
  const key = cacheKey(title);
  const hit = cache.get(key);
  if (hit) return hit;
  let sessions: BrainSession[] = [];
  try {
    const raw = readFileSync(sessionsPath(title), "utf-8");
    const parsed = JSON.parse(raw) as { sessions?: unknown };
    if (Array.isArray(parsed.sessions)) sessions = parsed.sessions as BrainSession[];
  } catch {
    /* 文件不存在/损坏：从空列表开始 */
  }
  cache.set(key, sessions);
  return sessions;
}

export function saveSessions(title: string, sessions: BrainSession[]): void {
  const key = cacheKey(title);
  cache.set(key, sessions);
  const dir = sessionsDir(title);
  mkdirSync(dir, { recursive: true });
  const p = sessionsPath(title);
  // 多 Tab/后台任务可能在相邻 tick 写同一会话文件；固定 .tmp 会在 Windows 上争用并 rename EPERM。
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(tmp, JSON.stringify({ sessions }, null, 2), "utf-8");
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmp, p);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      // Windows 上另一个 Tab 的原子替换可能短暂占用目标文件。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * (attempt + 1));
    }
  }
  try { unlinkSync(tmp); } catch { /* best effort */ }
  throw lastError;
}

export function getSession(title: string, id: string): BrainSession | undefined {
  return loadSessions(title).find((s) => s.id === id);
}

/** 会话级写操作（内存缓存实时；persist=false 时仅更新内存，供流式高频 delta 节流落盘） */
function mutateSession(title: string, id: string, fn: (s: BrainSession) => void, persist = true): BrainSession | undefined {
  const sessions = loadSessions(title);
  const s = sessions.find((x) => x.id === id);
  if (!s) return undefined;
  fn(s);
  s.updatedAt = Date.now();
  // 单会话消息条数上限：丢最旧
  if (s.messages.length > MAX_MESSAGES) s.messages = s.messages.slice(-MAX_MESSAGES);
  if (persist) saveSessions(title, sessions);
  return s;
}

export function createSession(title: string, firstPrompt?: string, id?: string): BrainSession {
  const now = Date.now();
  const s: BrainSession = {
    id: id ?? uuid(),
    title: makeTitle(firstPrompt ?? "新会话"),
    createdAt: now,
    updatedAt: now,
    messages: [],
    streaming: false,
  };
  const sessions = loadSessions(title);
  sessions.push(s);
  saveSessions(title, sessions);
  return s;
}

export function deleteSession(title: string, id: string): boolean {
  const sessions = loadSessions(title);
  const next = sessions.filter((s) => s.id !== id);
  if (next.length === sessions.length) return false;
  saveSessions(title, next);
  return true;
}

/** 截断会话：删除 fromMessageId 及其之后的所有消息（编辑重发前置：清掉旧问答） */
export function truncateSession(title: string, id: string, fromMessageId: string): boolean {
  let hit = false;
  mutateSession(title, id, (s) => {
    const idx = s.messages.findIndex((m) => m.id === fromMessageId);
    if (idx >= 0) {
      hit = true;
      s.messages = s.messages.slice(0, idx);
    }
  });
  return hit;
}

export function listSessions(title: string): BrainSession[] {
  // 按最近更新倒序（更新时间相同按创建时间新者优先，保证稳定排序）
  return [...loadSessions(title)].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

/** 会话标题：首条用户消息截断 24 字符（去空白） */
export function makeTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 24 ? `${t.slice(0, 24)}…` : t || "新会话";
}

export function appendMessage(title: string, sessionId: string, msg: BrainChatMsg): void {
  mutateSession(title, sessionId, (s) => {
    s.messages.push(msg);
    if (!s.title || s.title === "新会话") s.title = makeTitle(msg.text);
  });
}

/** 系统事件注入会话（幂等）：把系统状态变化（连载提交章节/任务完成等）以【系统】消息追加到
 * 最近更新的会话（listSessions 首条；无会话则跳过——事件不补录，后续新事件照常注入）。
 * 已注入的事件按 eventId 记录在 session.systemNotes 去重，同事件不重复刷屏；
 * 消息进入会话历史 → 意图识别/回复上下文（hist.slice(-6)）自动携带，中枢 AI 感知系统动态。
 * @returns 是否实际注入（false=无会话或重复事件）
 */
export function appendSystemNote(title: string, eventId: string, text: string): boolean {
  const session = listSessions(title)[0];
  if (!session) return false;
  let injected = false;
  mutateSession(title, session.id, (s) => {
    const notes = s.systemNotes ?? (s.systemNotes = []);
    if (notes.includes(eventId)) return; // 幂等：同事件不重复注入
    notes.push(eventId);
    if (notes.length > 200) s.systemNotes = notes.slice(-200); // 防膨胀，只留最近 200 条事件 id
    s.messages.push({ id: `sys-${eventId}`, role: "assistant", text: `【系统】${text}`, at: Date.now(), kind: "system" });
    injected = true;
  });
  return injected;
}

/** 流式生成中更新消息文本：persist=true 落盘（消息完成/关键节点），false 仅内存（高频 delta 节流） */
export function updateMessageText(title: string, sessionId: string, messageId: string, text: string, persist = true): void {
  mutateSession(
    title,
    sessionId,
    (s) => {
      const m = s.messages.find((x) => x.id === messageId);
      if (m) m.text = text;
    },
    persist,
  );
}

/** 流式生成中更新消息思维链（thinking）：与正文同节流语义，persist=true 落盘 / false 仅内存 */
export function updateMessageThinking(title: string, sessionId: string, messageId: string, thinking: string, persist = true): void {
  mutateSession(
    title,
    sessionId,
    (s) => {
      const m = s.messages.find((x) => x.id === messageId);
      if (m) m.thinking = thinking;
    },
    persist,
  );
}

/** 记录会话内已执行的卡片操作 key（幂等去重 + 落盘）；刷新后随详情返回，前端恢复完成态 */
export function markSessionCompleted(title: string, sessionId: string, key: string): boolean {
  let hit = false;
  mutateSession(title, sessionId, (s) => {
    const arr = s.completed ?? (s.completed = []);
    if (!arr.includes(key)) {
      arr.push(key);
      hit = true;
    }
  });
  return hit;
}

/** 回合完成：清 pending，附卡片，streaming=false，落盘 */
export function markMessageDone(title: string, sessionId: string, messageId: string, cards?: BrainChatCard[]): void {
  mutateSession(title, sessionId, (s) => {
    const m = s.messages.find((x) => x.id === messageId);
    if (m) {
      m.pending = false;
      if (cards?.length) m.cards = cards;
    }
    s.streaming = false;
  });
}

/** 回合中断：清 pending，标 interrupted，streaming=false，落盘 */
export function markMessageInterrupted(title: string, sessionId: string, messageId: string): void {
  mutateSession(title, sessionId, (s) => {
    const m = s.messages.find((x) => x.id === messageId);
    if (m) {
      m.pending = false;
      m.interrupted = true;
    }
    s.streaming = false;
  });
}

/** 回合开始：streaming=true，落盘（刷新后可见运行中） */
export function markStreaming(title: string, sessionId: string): void {
  mutateSession(title, sessionId, (s) => {
    s.streaming = true;
  });
}

/** 就地更新某消息内指定卡片（阶段 3a：卡片稳定标识 cardId → 系统事件就地翻转状态/刷新数据）。
 *  @returns 是否命中（消息不存在 / 卡片无 cardId / cardId 不匹配 → false，调用方不广播）
 */
export function updateMessageCard(
  title: string,
  sessionId: string,
  messageId: string,
  cardId: string,
  patch: Record<string, unknown>,
): boolean {
  let hit = false;
  mutateSession(title, sessionId, (s) => {
    const m = s.messages.find((x) => x.id === messageId);
    if (!m) return;
    for (let i = 0; i < (m.cards ?? []).length; i++) {
      const c = m.cards![i] as (BrainChatCard & { cardId?: string });
      if (c.cardId === cardId) {
        m.cards![i] = { ...c, ...patch, cardId }; // 保留 cardId；patch 覆盖其余字段
        hit = true;
        return;
      }
    }
  });
  return hit;
}

/** 就地替换某消息内指定下标的卡片（阶段 3b 补充：媒体生成 form→preview 单面板流转）。
 *  与 updateMessageCard 的区别：按「消息内下标」整体替换卡片对象（含 kind/action 变更），
 *  而非按 cardId 合并字段——媒体分镜提交后 form 卡整体变为 preview 卡，合并无法改变卡片类型。
 *  @returns 是否命中（消息不存在 / 下标越界 → false）
 */
export function replaceMessageCard(
  title: string,
  sessionId: string,
  messageId: string,
  cardIndex: number,
  card: BrainChatCard,
): boolean {
  let hit = false;
  mutateSession(title, sessionId, (s) => {
    const m = s.messages.find((x) => x.id === messageId);
    if (!m || !Array.isArray(m.cards)) return;
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= m.cards.length) return;
    m.cards[cardIndex] = card;
    hit = true;
  });
  return hit;
}

/** 更新媒体参数 form 卡的已选值（sync WS 上行使用）。
 *  仅接受 /media/plan 表单且只写既有 chapterIndex/count 字段，避免 WS 成为任意卡片改写通道。 */
export function updateMediaFormCardValues(
  title: string,
  sessionId: string,
  messageId: string,
  cardIndex: number,
  values: { chapterIndex: number; count?: number },
): BrainChatCard | null {
  let updated: BrainChatCard | null = null;
  mutateSession(title, sessionId, (s) => {
    const m = s.messages.find((x) => x.id === messageId);
    if (!m || !Array.isArray(m.cards) || cardIndex < 0 || cardIndex >= m.cards.length) return;
    const card = m.cards[cardIndex] as BrainChatCard;
    const action = card.action as { endpoint?: unknown; body?: { kind?: unknown } } | undefined;
    if (card.kind !== "form" || action?.endpoint !== "/api/novel/media/plan" || !Array.isArray(card.fields)) return;
    const kind = String(action.body?.kind ?? "image");
    const fields = (card.fields as Record<string, unknown>[]).map((field) => {
      if (field.key === "chapterIndex") return { ...field, value: values.chapterIndex };
      if (field.key === "count" && kind === "image" && values.count != null) return { ...field, value: values.count };
      return field;
    });
    updated = { ...card, fields };
    m.cards[cardIndex] = updated;
  });
  return updated;
}

/** 创建「任务进度消息」（阶段 3b：推进/连载的持久进度卡）。
 *  追加一条 assistant 消息，cards 内放一张带 cardId 的 progress 卡（status:running）；
 *  前端 SSE 流式期间就地更新，完成后经 update-card 翻转 + 广播（多 tab 一致，刷新可见）。
 *  @returns { messageId, cardId }——调用方透传给更新/翻转链路。
 */
export function createProgressMessage(title: string, sessionId: string, cardTitle: string): { messageId: string; cardId: string } {
  const messageId = uuid();
  const cardId = `progress-${uuid()}`;
  appendMessage(title, sessionId, {
    id: messageId,
    role: "assistant",
    text: "",
    at: Date.now(),
    cards: [{ kind: "progress", cardId, title: cardTitle, phase: "start", text: "", status: "running" }],
  });
  return { messageId, cardId };
}

/** 会话最后一条未完成（pending=流式进行中 或 interrupted=被中断）消息；无则 null（resume 续流目标） */
export function lastIncompleteMessage(s: BrainSession): BrainChatMsg | null {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === "assistant" && (s.messages[i].pending || s.messages[i].interrupted)) return s.messages[i];
  }
  return null;
}

/** 会话最后一条 pending（流式进行中）消息；无则 null */
export function lastPendingMessage(s: BrainSession): BrainChatMsg | null {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].pending) return s.messages[i];
  }
  return null;
}

/** 会话最后一条 user 消息（resume 重放 prompt 用） */
export function lastUserMessage(s: BrainSession): BrainChatMsg | null {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === "user") return s.messages[i];
  }
  return null;
}

// —— 会话级生成任务注册表（连接解耦：断连不杀任务，新连接可附加恢复） ——

export type SessionTask = {
  running: boolean;
  /** 当前附加的 SSE 连接 emitter（广播目标） */
  emitters: Set<(obj: unknown) => void>;
  /** 任务自身的 AbortController（"停止生成"入口；req.signal 取消时同步 abort） */
  abort: AbortController;
};

const tasks = new Map<string, SessionTask>();

/** 任务表 key：用户 + 书名 + sessionId——sessionId 可由调用方指定（brain-chat 传请求 body 的 id），
 * 不同账号 / 不同书 / 同 sessionId 均不可互串（否则同用户跨书同 id 会 attach 到错误任务收错 delta） */
function taskKey(title: string, sessionId: string): string {
  return `${currentUser() ?? ""}::${slugify(title)}::${sessionId}`;
}

/** 若会话已有进行中任务则注册 emitter 并返回任务；没有返回 null（调用方自行开新回合） */
export function attachSessionTask(title: string, sessionId: string, emitter: (obj: unknown) => void): SessionTask | null {
  const t = tasks.get(taskKey(title, sessionId));
  if (!t || !t.running) return null;
  t.emitters.add(emitter);
  return t;
}

/** 创建（或复用已结束的）任务并注册 emitter；abortSignal 取消时自动 abort 任务 */
export function registerSessionTask(title: string, sessionId: string, emitter: (obj: unknown) => void, signal?: AbortSignal): SessionTask {
  const key = taskKey(title, sessionId);
  let t = tasks.get(key);
  if (!t) {
    t = { running: false, emitters: new Set(), abort: new AbortController() };
    tasks.set(key, t);
  }
  t.emitters.add(emitter);
  if (signal) {
    signal.addEventListener("abort", () => {
      if (t) t.abort.abort();
    }, { once: true });
  }
  return t;
}

/** 向会话所有附加连接广播（连接断开吞掉 enqueue 异常） */
export function broadcastToSession(title: string, sessionId: string, obj: unknown): void {
  const t = tasks.get(taskKey(title, sessionId));
  if (!t) return;
  for (const e of [...t.emitters]) {
    try {
      e(obj);
    } catch {
      /* 客户端已断开，忽略 */
    }
  }
}

/** 移除一个 emitter；空集时任务停表（内存泄漏防护） */
export function detachSessionTask(title: string, sessionId: string, emitter: (obj: unknown) => void): void {
  const key = taskKey(title, sessionId);
  const t = tasks.get(key);
  if (!t) return;
  t.emitters.delete(emitter);
  if (t.emitters.size === 0) tasks.delete(key);
}

/** 回合结束：running=false，清空 emitter（任务停表） */
export function finishSessionTask(title: string, sessionId: string): void {
  const key = taskKey(title, sessionId);
  const t = tasks.get(key);
  if (!t) return;
  t.running = false;
  t.emitters.clear();
  tasks.delete(key);
}

export function isSessionRunning(title: string, sessionId: string): boolean {
  const t = tasks.get(taskKey(title, sessionId));
  return !!t && t.running;
}

/** 外部取消会话的进行中流式回合（删除/截断会话时调用）：abort 任务自身的 controller。
 *  正在跑的 brain-chat 循环会感知 AbortError 并自行 finishSessionTask；幂等（无任务/no-op）。
 *  注意：这只取消 SSE 文本回合，章节媒体/分镜的后台 Promise 由 routes 的 cancelMediaTasks 单独取消。 */
export function abortSessionTask(title: string, sessionId: string): boolean {
  const t = tasks.get(taskKey(title, sessionId));
  if (!t) return false;
  if (!t.abort.signal.aborted) t.abort.abort();
  return true;
}

/** 启动恢复：扫描本书所有会话的 preview 卡，把服务重启后失去后台依托的 running 卡收敛到终态。
 *  只翻状态、不重启任何 LLM/生图。终态通过 updateMessageCard 落盘（调用方负责随后广播 WS）。
 *  @param mediaStatusById 重启后由 state.json 扫描得到的 mediaId → "pending"|"ready"|"failed" 映射；
 *                         map 中缺失的 mediaId 视为孤儿 → failed。
 *  @returns 每类收敛数量（供启动日志） */
export function recoverRunningMediaCards(
  title: string,
  mediaStatusById: Map<string, string>,
): { planFailed: number; mediaDone: number; mediaFailed: number; stuckFailed: number; kept: number } {
  const result = { planFailed: 0, mediaDone: 0, mediaFailed: 0, stuckFailed: 0, kept: 0 };
  const sessions = loadSessions(title);
  let mutated = false;

  for (const s of sessions) {
    for (const m of s.messages) {
      const cards = m.cards;
      if (!Array.isArray(cards)) continue;
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i] as BrainChatCard & {
          cardId?: string; kind?: string; status?: string;
          planId?: string; mediaIds?: unknown; scenes?: unknown;
        };
        if (c.kind !== "preview" || c.status !== "running" || !c.cardId) continue;

        // 1) 分镜中卡：planTasks 是纯内存态，重启必失 → 失败
        if (c.planId) {
          cards[i] = { ...c, status: "failed", detail: "分镜任务因服务重启中断，请重新发起" };
          result.planFailed++;
          mutated = true;
          continue;
        }

        // 2) 媒体生成中卡：按 mediaIds 的真实状态收敛
        const mediaIds = Array.isArray(c.mediaIds) ? (c.mediaIds as string[]).filter((x) => typeof x === "string" && x) : [];
        if (mediaIds.length) {
          let ready = 0, failed = 0, pending = 0;
          for (const id of mediaIds) {
            const st = mediaStatusById.get(id);
            if (st === "ready") ready++;
            else if (st === "pending" || st === "in_progress") pending++;
            else failed++; // 缺失/failed 都算失败
          }
          if (pending > 0) { result.kept++; continue; } // 仍有在途：保留 running，交 WS/一次性核对收敛
          if (failed > 0 && ready > 0) {
            cards[i] = { ...c, status: "failed", detail: `部分生成失败（成功 ${ready}，失败 ${failed}），请重新生成失败项` };
            result.mediaFailed++;
          } else if (failed > 0) {
            cards[i] = { ...c, status: "failed", detail: "生成任务因服务重启中断，请重新发起" };
            result.mediaFailed++;
          } else {
            cards[i] = { ...c, status: "done", detail: "生成完成" };
            result.mediaDone++;
          }
          mutated = true;
          continue;
        }

        // 3) 既无 planId 也无 mediaIds/scenes：提交中断的悬死卡 → 失败；有 scenes（倒计时卡）保留
        if (!c.scenes) {
          cards[i] = { ...c, status: "failed", detail: "任务因服务重启中断，请重新发起" };
          result.stuckFailed++;
          mutated = true;
        }
      }
    }
  }

  if (mutated) saveSessions(title, sessions);
  return result;
}

/** 在 brain 会话中查找「含指定 pending 媒体、仍处于 running」的 preview 卡，返回其会话定位。
 *  供重启恢复视频 watcher 时关联会话，使重启期间完成的视频也能由服务端权威翻 brain 卡。
 *  找不到返回 null（无卡可翻：仅章节媒体维度收敛）。 */
export function findRunningMediaCard(
  title: string,
  mediaId: string,
): { sessionId: string; messageId: string; cardIndex: number; cardId: string; chapterIndex?: number } | null {
  const sessions = loadSessions(title);
  for (const s of sessions) {
    for (const m of s.messages) {
      const cards = m.cards;
      if (!Array.isArray(cards)) continue;
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i] as BrainChatCard & {
          cardId?: string; kind?: string; status?: string; mediaIds?: unknown; chapterIndex?: number;
        };
        if (c.kind !== "preview" || c.status !== "running" || !c.cardId) continue;
        const ids = Array.isArray(c.mediaIds) ? (c.mediaIds as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0) : [];
        if (!ids.includes(mediaId)) continue;
        return {
          sessionId: s.id, messageId: m.id, cardIndex: i, cardId: c.cardId,
          ...(typeof c.chapterIndex === "number" ? { chapterIndex: c.chapterIndex } : {}),
        };
      }
    }
  }
  return null;
}
