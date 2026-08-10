// 立项异步任务持久化（newtask）：/api/novel/new 由同步阻塞改为异步提交。
// 解决的问题：立项需串行 5 个 LLM 调用（1-3 分钟），同步 await 会让前端"点了没反应"且刷新即丢失感知。
// 方案：提交立即返回 taskId；任务状态落盘到 data/<username>/newstory-tasks.json，
// 列表接口合并 creating 占位，前端轮询任务终态（done 自动打开 / failed 报错），刷新列表也能看到生成中的书。
// 与 advancetask/autorun-session 同规范：原子写、服务重启清理陈旧任务。
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { runAsUser, userDir, currentUser } from "./storage";
import { listUsernames } from "./auth";

export type NewTaskStatus = "running" | "ready" | "done" | "failed";

export type NewStoryTask = {
  id: string;
  status: NewTaskStatus;
  idea: string;
  genre?: string;
  /** done/ready：立项完成后的书名（ready 起即可用于打开页面） */
  title?: string;
  /** 后台执行阶段文案（如「正在生成故事蓝图…」），前端构建徽章实时显示 */
  stage?: string;
  startedAt: string;
  updatedAt: string;
  /** failed：错误信息 */
  error?: string;
};

/** 陈旧判定：running 超过 2 小时视为中断。立项链路已放宽超时/重试（单调用 180s×4 次×5 调用×chatJson 2 层 ≈ 2 小时），
 *  必须留足余量，否则运行中的长任务会被误判陈旧标 failed（立项失败不可忍受）。 */
const STALE_MS = 2 * 60 * 60 * 1000;
/** done/failed 终态保留时长：前端轮询 / 列表感知窗口，之后清理 */
const DONE_RETENTION_MS = 30 * 60 * 1000;
/** 任务文件保留上限（防无限增长） */
const MAX_TASKS = 50;

function tasksPath(): string {
  return join(userDir(currentUser() ?? ""), "newstory-tasks.json");
}

export function loadNewStoryTasks(): NewStoryTask[] {
  try {
    const p = tasksPath();
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, "utf-8")) as NewStoryTask[];
  } catch {
    return [];
  }
}

function saveNewStoryTasks(tasks: NewStoryTask[]): void {
  try {
    const p = tasksPath();
    mkdirSync(join(p, ".."), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf-8");
    renameSync(tmp, p);
  } catch (e) {
    console.warn("[newtask] 写入失败:", (e as Error).message);
  }
}

/** 启动任务：写 running。返回 { id, created }——
 *  created=true 新建任务；created=false 表示已有 running 任务（并发立项防抖，同一用户同时只跑一个），
 *  调用方**不得**再启动新的后台执行（否则两个并发任务写同一 taskId 互相覆盖终态）。 */
export function createNewStoryTask(idea: string, genre?: string): { id: string; created: boolean } {
  const tasks = loadNewStoryTasks();
  const running = tasks.find((t) => t.status === "running");
  if (running) return { id: running.id, created: false };
  const task: NewStoryTask = {
    id: crypto.randomUUID().slice(0, 12),
    status: "running",
    idea,
    genre,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.unshift(task);
  saveNewStoryTasks(tasks);
  return { id: task.id, created: true };
}

/** 任务完成（记录最终书名） */
export function completeNewStoryTask(id: string, title: string): void {
  const tasks = loadNewStoryTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  t.status = "done";
  t.title = title;
  t.stage = undefined;
  t.updatedAt = new Date().toISOString();
  saveNewStoryTasks(tasks);
}

/** 壳就绪：running → ready（基础 world 已落盘，前端可立即进入三栏页面），记录书名 */
export function markNewStoryTaskReady(id: string, title: string): void {
  const tasks = loadNewStoryTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t || t.status !== "running") return;
  t.status = "ready";
  t.title = title;
  t.stage = "世界已就绪，正在生成故事蓝图…";
  t.updatedAt = new Date().toISOString();
  saveNewStoryTasks(tasks);
}

/** 更新后台执行阶段文案（构建徽章显示） */
export function updateNewStoryTaskStage(id: string, stage: string): void {
  const tasks = loadNewStoryTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t || (t.status !== "running" && t.status !== "ready")) return;
  t.stage = stage;
  t.updatedAt = new Date().toISOString();
  saveNewStoryTasks(tasks);
}

/** 任务失败 */
export function failNewStoryTask(id: string, error: string): void {
  const tasks = loadNewStoryTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  t.status = "failed";
  t.error = error;
  t.updatedAt = new Date().toISOString();
  saveNewStoryTasks(tasks);
}

/** 查询单任务（无则 null） */
export function getNewStoryTask(id: string): NewStoryTask | null {
  return loadNewStoryTasks().find((t) => t.id === id) ?? null;
}

/** 列表接口合并用：进行中的任务（running 壳未就绪 + ready 壳已就绪仍在增强），含陈旧清理后的最新状态 */
export function listActiveNewStoryTasks(): NewStoryTask[] {
  return loadNewStoryTasks().filter((t) => t.status === "running" || t.status === "ready");
}

/** 删除一本书时同步清理其关联的立项任务（running/ready/done 全清——书已删，任务无存在意义；
 *  防「书删了占位卡复活、点开 404」的状态不一致） */
export function removeNewStoryTaskByTitle(title: string): void {
  const tasks = loadNewStoryTasks();
  const next = tasks.filter((t) => t.title !== title);
  if (next.length !== tasks.length) saveNewStoryTasks(next);
}

/** 服务启动清理：陈旧 running → failed（执行上下文不持久化，重启即中断）；终态超保留期清理；截断上限 */
export function cleanupNewStoryTasks(): void {
  cleanupForDir("");
  for (const username of listUsernames()) {
    runAsUser(username, () => cleanupForDir(username));
  }
}

function cleanupForDir(username: string): void {
  try {
    const dir = userDir(username);
    if (!existsSync(dir)) return;
    const p = join(dir, "newstory-tasks.json");
    if (!existsSync(p)) return;
    let tasks = JSON.parse(readFileSync(p, "utf-8")) as NewStoryTask[];
    const now = Date.now();
    const next: NewStoryTask[] = [];
    let changed = false;
    for (const t of tasks) {
      if ((t.status === "running" || t.status === "ready") && now - Date.parse(t.updatedAt) > STALE_MS) {
        next.push({ ...t, status: "failed", error: "服务重启中断了立项任务，请重新发起", updatedAt: new Date().toISOString() });
        changed = true; // 状态变更（数量不变也须落盘）
        console.log(`[newtask] 清理陈旧立项任务: ${t.id}`);
      } else if ((t.status === "done" || t.status === "failed") && now - Date.parse(t.updatedAt) > DONE_RETENTION_MS) {
        changed = true; // 终态超期清除
        continue;
      } else {
        next.push(t);
      }
    }
    if (changed) {
      if (next.length > MAX_TASKS) next.length = MAX_TASKS;
      saveNewStoryTasksForDir(next, username);
    }
  } catch (e) {
    console.warn("[newtask] 启动清理失败:", (e as Error).message);
  }
}

function saveNewStoryTasksForDir(tasks: NewStoryTask[], username: string): void {
  try {
    const p = join(userDir(username), "newstory-tasks.json");
    mkdirSync(join(p, ".."), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf-8");
    renameSync(tmp, p);
  } catch (e) {
    console.warn("[newtask] 清理写入失败:", (e as Error).message);
  }
}

/** 测试辅助：清空当前用户任务文件 */
export function _clearNewStoryTasks(): void {
  try {
    const p = tasksPath();
    if (existsSync(p)) unlinkSync(p);
  } catch { /* 忽略 */ }
}
