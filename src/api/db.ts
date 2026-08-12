// 应用数据库（bun:sqlite）：账号 / 会话 / 新角色提案关闭状态
// 数据文件：data/app.db（与小说存档同级）；WAL 模式支持 SSR 与 API 同进程并发读写
// 惰性单例 + APP_DB_PATH 可覆盖：测试可指向临时库，避免污染真实数据
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let _db: Database | null = null;
let _dbPath: string | null = null;

/**
 * 显式释放 SQLite 单例。测试切换临时 cwd、进程热重载与优雅停机都应调用它，
 * 否则 Windows 会因 WAL/SHM 句柄仍打开而拒绝删除临时目录。
 */
export function closeDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* 已关闭 */ }
  }
  _db = null;
  _dbPath = null;
}

export function getDb(): Database {
  const dataDir = join(process.cwd(), "data");
  const path = process.env.APP_DB_PATH || join(dataDir, "app.db");
  // 测试与运维迁移可能在同一进程内切换数据库路径；绝不能继续复用旧路径的健康连接。
  if (_db && _dbPath !== path) {
    closeDb();
  }
  // 单例曾被 close（测试清理等）：bun:sqlite 无 isClosed 属性，用轻量查询探测后重建
  if (_db) {
    try {
      _db.query("SELECT 1").get();
      return _db;
    } catch {
      _db = null; // 已关闭：重建
      _dbPath = null;
    }
  }
  mkdirSync(dataDir, { recursive: true });
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
CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  user_name TEXT NOT NULL,
  command_type TEXT NOT NULL,
  scope_title TEXT,
  expected_revision INTEGER,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_receipts_user_updated
  ON command_receipts(user_name, updated_at DESC);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  command_id TEXT REFERENCES command_receipts(command_id) ON DELETE SET NULL,
  user_name TEXT NOT NULL,
  scope_title TEXT,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_external','paused','succeeded','failed','interrupted','cancelled')),
  phase TEXT NOT NULL DEFAULT '',
  progress_json TEXT,
  recovery_json TEXT,
  result_json TEXT,
  error TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active
  ON jobs(user_name, dedupe_key)
  WHERE status IN ('queued','running','waiting_external','paused');
CREATE INDEX IF NOT EXISTS idx_jobs_scope_updated
  ON jobs(user_name, scope_title, updated_at DESC);
CREATE TABLE IF NOT EXISTS sync_scopes (
  user_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  document TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_name, scope, document)
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  document TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  frame_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_outbox_revision
  ON sync_outbox(user_name, scope, document, revision);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
  ON sync_outbox(delivered_at, id);
CREATE TABLE IF NOT EXISTS world_commits (
  id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  target_revision INTEGER NOT NULL,
  old_hash TEXT NOT NULL,
  new_hash TEXT NOT NULL,
  old_json TEXT,
  new_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','committed','aborted','conflict')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_world_commits_status
  ON world_commits(status, created_at);
`);
  _db = db;
  _dbPath = path;
  return db;
}
