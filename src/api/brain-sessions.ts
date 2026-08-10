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
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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

/** 单会话消息条数上限（防文件膨胀；超出丢最旧） */
const MAX_MESSAGES = 100;

// —— 持久化：data/<username>/<slug>/brain-sessions.json（内存缓存 + 写时同步落盘） ——

const cache = new Map<string, BrainSession[]>();

/** 缓存 key：用户前缀 + slug，不同账号的同名书会话缓存互不串扰 */
function cacheKey(title: string): string {
  return `${currentUser() ?? ""}::${slugify(title)}`;
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
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ sessions }, null, 2), "utf-8");
  renameSync(tmp, p);
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
