// 应用数据库（bun:sqlite）：账号 / 会话 / 新角色提案关闭状态
// 数据文件：data/app.db（与小说存档同级）；WAL 模式支持 SSR 与 API 同进程并发读写
// 惰性单例 + APP_DB_PATH 可覆盖：测试可指向临时库，避免污染真实数据
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let _db: Database | null = null;

export function getDb(): Database {
  // 单例曾被 close（测试清理等）：bun:sqlite 无 isClosed 属性，用轻量查询探测后重建
  if (_db) {
    try {
      _db.query("SELECT 1").get();
      return _db;
    } catch {
      _db = null; // 已关闭：重建
    }
  }
  const dataDir = join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  const path = process.env.APP_DB_PATH || join(dataDir, "app.db");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS proposal_closed (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, title)
);
`);
  _db = db;
  return db;
}
