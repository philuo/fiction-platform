// 账号与会话（bun:sqlite + Bun.password 哈希）：
// - 密码：Bun.password.hash（argon2id）存储，verify 校验
// - 会话：随机 token 存 sessions 表；经 httpOnly cookie 传递（仅承载「你是谁」，供 SSR 首帧识别用户）
// - 新角色提案关闭状态：按用户 + 书名存 proposal_closed 表（服务端权威，SSR 首帧直接读库，刷新不闪现）
import { getDb } from "./db";
import { randomBytes } from "node:crypto";
import type { AuthUser } from "../contracts/auth";

export const SESSION_COOKIE = "ms_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export type { AuthUser };

export class AuthError extends Error {}

const USERNAME_RE = /^[\w\u4e00-\u9fa5-]{2,20}$/; // 2-20 位：字母数字下划线中文连字符

export function validateCredentials(username: string, password: string): string | null {
  if (!USERNAME_RE.test(username)) return "用户名需为 2-20 位中文/字母/数字/下划线/连字符";
  if (password.length < 6) return "密码至少 6 位";
  if (password.length > 72) return "密码过长（最多 72 位）";
  return null;
}

export async function registerUser(username: string, password: string, displayName = ""): Promise<AuthUser & { isFirstUser: boolean }> {
  const db = getDb();
  const existed = db.query("SELECT id FROM users WHERE username = ?").get(username);
  if (existed) throw new AuthError("用户名已被占用");
  const passwordHash = await Bun.password.hash(password); // 默认 argon2id
  const now = new Date().toISOString();
  // 首个注册用户判定 + 插入放同一写事务（BEGIN IMMEDIATE 立即拿写锁）：并发注册时串行化，
  // 避免两个请求同时读到空表而双双被认领为首用户（误触发旧数据迁移）
  db.exec("BEGIN IMMEDIATE");
  let isFirstUser = false;
  let info: { lastInsertRowid: number | bigint };
  try {
    isFirstUser = (db.query("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c === 0;
    info = db
      .query("INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run(username, passwordHash, displayName, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { id: Number(info.lastInsertRowid), username, displayName, isFirstUser };
}

/** 全部用户名（后台任务遍历各用户目录时用） */
export function listUsernames(): string[] {
  const rows = getDb().query("SELECT username FROM users ORDER BY id").all() as { username: string }[];
  return rows.map((r) => r.username);
}

/** 第一个注册的用户（users 表 id 最小者）；无用户返回 null（等待首个注册触发迁移） */
export function firstUsername(): string | null {
  const row = getDb().query("SELECT username FROM users ORDER BY id LIMIT 1").get() as { username: string } | undefined;
  return row?.username ?? null;
}

/** 登录成功返回 { token, user }；失败返回 null（不区分「用户不存在」与「密码错误」） */
export async function loginUser(username: string, password: string): Promise<{ token: string; user: AuthUser } | null> {
  const db = getDb();
  const row = db.query("SELECT id, username, password_hash, display_name FROM users WHERE username = ?").get(username) as
    | { id: number; username: string; password_hash: string; display_name: string }
    | undefined;
  if (!row) return null;
  const ok = await Bun.password.verify(password, row.password_hash);
  if (!ok) return null;
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  db.query("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token,
    row.id,
    new Date(now).toISOString(),
    new Date(now + SESSION_TTL_MS).toISOString(),
  );
  return { token, user: { id: row.id, username: row.username, displayName: row.display_name } };
}

export function logoutSession(token: string): void {
  getDb().query("DELETE FROM sessions WHERE token = ?").run(token);
}

export function userFromToken(token: string): AuthUser | null {
  if (!token) return null;
  const row = getDb().query(
    `SELECT u.id, u.username, u.display_name FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
  ).get(token, new Date().toISOString()) as { id: number; username: string; display_name: string } | undefined;
  if (!row) return null;
  return { id: row.id, username: row.username, displayName: row.display_name };
}

/** 兼容内部 CommandBus/恢复调用：业务层已由 runAsUser 建立上下文时按用户名解析 DTO。 */
export function userByUsername(username: string | null): AuthUser | null {
  if (!username) return null;
  const row = getDb().query("SELECT id, username, display_name FROM users WHERE username = ?").get(username) as
    | { id: number; username: string; display_name: string }
    | undefined;
  return row ? { id: row.id, username: row.username, displayName: row.display_name } : null;
}

/** 从请求解析当前登录用户：优先 `Authorization: Bearer <token>`（业务 API 凭证），
 * 回退 httpOnly 只读 cookie（SSR 首帧识别用户，浏览器自动携带）。
 * 服务端一次改动即让所有 API 同时支持两种凭证形态。 */
export function userFromRequest(req: Request): AuthUser | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) {
      const u = userFromToken(token);
      if (u) return u;
    }
  }
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  const pair = cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  if (!pair) return null;
  return userFromToken(pair.slice(SESSION_COOKIE.length + 1));
}

/** 会话 cookie 的 Set-Cookie 值（登录时下发；httpOnly + SameSite=Lax，本地 http 不设 Secure） */
export function sessionCookieValue(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

/** 清除会话 cookie 的 Set-Cookie 值（登出时下发） */
export function clearSessionCookieValue(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// —— 新角色提案关闭状态（服务端权威，按用户 + 书名） ——

export function getPropClosed(userId: number, title: string): boolean {
  const row = getDb().query("SELECT 1 FROM proposal_closed WHERE user_id = ? AND title = ?").get(userId, title);
  return !!row;
}

/** Sync projection builders run with an explicit username context, not an HTTP AuthUser. */
export function getPropClosedForUsername(username: string | null, title: string): boolean {
  if (!username) return false;
  const row = getDb().query(
    `SELECT 1 FROM proposal_closed p
     JOIN users u ON u.id = p.user_id
     WHERE u.username = ? AND p.title = ?`,
  ).get(username, title);
  return !!row;
}

export function setPropClosed(userId: number, title: string, closed: boolean): void {
  const db = getDb();
  if (closed) {
    db.query(
      `INSERT INTO proposal_closed (user_id, title, closed_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, title) DO UPDATE SET closed_at = excluded.closed_at`,
    ).run(userId, title, new Date().toISOString());
  } else {
    db.query("DELETE FROM proposal_closed WHERE user_id = ? AND title = ?").run(userId, title);
  }
}
