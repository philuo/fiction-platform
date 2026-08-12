import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDb } from "./db";
import { canonicalJson as sharedCanonicalJson, createJsonPatch, type JsonPatchOperation } from "../shared/json-patch";

export type CommandStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type JobStatus = "queued" | "running" | "waiting_external" | "paused" | "succeeded" | "failed" | "interrupted" | "cancelled";

export type CommandRequest = {
  commandId: string;
  type: HarnessCommandId;
  scope: { title?: string };
  expectedRevision?: number;
  payload: unknown;
};
export type HarnessCommandId = `CMD-${"N" | "W" | "L" | "M" | "G" | "S" | "Q"}${string}`;

export type CommandReceipt = {
  accepted: true;
  commandId: string;
  status: "queued" | "running" | "succeeded";
};

export class CommandConflictError extends Error {}
export class RevisionConflictError extends Error {}

const LEGACY_USER = "__legacy__";
export function durableUser(user: string | null | undefined): string {
  return user?.trim() || LEGACY_USER;
}

export function canonicalJson(value: unknown): string {
  return sharedCanonicalJson(value);
}

export function contentHash(value: string | unknown): string {
  const raw = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(raw).digest("hex");
}

function now(): string { return new Date().toISOString(); }
function parseJson<T>(raw: string | null | undefined): T | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

export function acceptCommandOnce(user: string | null, req: CommandRequest): { receipt: CommandReceipt; created: boolean } {
  if (!req.commandId.trim() || !req.type.trim()) throw new Error("commandId/type 不能为空");
  const db = getDb();
  const requestHash = contentHash({ type: req.type, scope: req.scope, expectedRevision: req.expectedRevision, payload: req.payload });
  const username = durableUser(user);
  const existing = db.query("SELECT request_hash, status, user_name FROM command_receipts WHERE command_id=?").get(req.commandId) as { request_hash: string; status: CommandStatus; user_name: string } | null;
  if (existing) {
    if (existing.user_name !== username) throw new CommandConflictError("commandId 已由其他用户使用");
    if (existing.request_hash !== requestHash) throw new CommandConflictError("同一 commandId 的请求内容不同");
    const status = existing.status === "succeeded" ? "succeeded" : existing.status === "running" ? "running" : "queued";
    return { receipt: { accepted: true, commandId: req.commandId, status }, created: false };
  }
  const at = now();
  try {
    db.query(`INSERT INTO command_receipts
      (command_id,request_hash,user_name,command_type,scope_title,expected_revision,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
        req.commandId, requestHash, username, req.type, req.scope.title ?? null,
        req.expectedRevision ?? null, "queued", at, at,
      );
    return { receipt: { accepted: true, commandId: req.commandId, status: "queued" }, created: true };
  } catch (error) {
    // 跨进程同时重试同 commandId：主键是最终仲裁者。
    const raced = db.query("SELECT request_hash, status, user_name FROM command_receipts WHERE command_id=?").get(req.commandId) as { request_hash: string; status: CommandStatus; user_name: string } | null;
    if (!raced) throw error;
    if (raced.user_name !== username) throw new CommandConflictError("commandId 已由其他用户使用");
    if (raced.request_hash !== requestHash) throw new CommandConflictError("同一 commandId 的请求内容不同");
    const status = raced.status === "succeeded" ? "succeeded" : raced.status === "running" ? "running" : "queued";
    return { receipt: { accepted: true, commandId: req.commandId, status }, created: false };
  }
}

export function acceptCommand(user: string | null, req: CommandRequest): CommandReceipt {
  return acceptCommandOnce(user, req).receipt;
}

export function updateCommand(commandId: string, status: CommandStatus, result?: unknown, error?: string): void {
  getDb().query("UPDATE command_receipts SET status=?, result_json=?, error=?, updated_at=? WHERE command_id=?")
    .run(status, result === undefined ? null : JSON.stringify(result), error ?? null, now(), commandId);
}

export type DurableJob = {
  id: string;
  commandId?: string;
  user: string;
  title?: string;
  kind: string;
  dedupeKey: string;
  status: JobStatus;
  phase: string;
  progress?: unknown;
  recovery?: unknown;
  result?: unknown;
  error?: string;
  deadlineAt?: string;
  updatedAt: string;
};

function rowToJob(row: Record<string, unknown>): DurableJob {
  return {
    id: String(row.id), commandId: row.command_id ? String(row.command_id) : undefined,
    user: String(row.user_name), title: row.scope_title ? String(row.scope_title) : undefined,
    kind: String(row.kind), dedupeKey: String(row.dedupe_key), status: row.status as JobStatus,
    phase: String(row.phase ?? ""), progress: parseJson(String(row.progress_json ?? "")),
    recovery: parseJson(String(row.recovery_json ?? "")), result: parseJson(String(row.result_json ?? "")),
    error: row.error ? String(row.error) : undefined, deadlineAt: row.deadline_at ? String(row.deadline_at) : undefined,
    updatedAt: String(row.updated_at),
  };
}

export function createJob(input: {
  id?: string; commandId?: string; user: string | null; title?: string; kind: string; dedupeKey: string;
  status?: JobStatus; phase?: string; recovery?: unknown; deadlineAt?: string;
}): { job: DurableJob; created: boolean } {
  const db = getDb();
  const username = durableUser(input.user);
  const active = db.query(`SELECT * FROM jobs WHERE user_name=? AND dedupe_key=?
    AND status IN ('queued','running','waiting_external','paused') LIMIT 1`).get(username, input.dedupeKey) as Record<string, unknown> | null;
  if (active) return { job: rowToJob(active), created: false };
  const id = input.id ?? crypto.randomUUID();
  const at = now();
  try {
    db.query(`INSERT INTO jobs
      (id,command_id,user_name,scope_title,kind,dedupe_key,status,phase,recovery_json,deadline_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, input.commandId ?? null, username, input.title ?? null, input.kind, input.dedupeKey,
        input.status ?? "queued", input.phase ?? "", input.recovery === undefined ? null : JSON.stringify(input.recovery),
        input.deadlineAt ?? null, at, at,
      );
  } catch (error) {
    // SELECT 与 INSERT 之间可能有另一个进程抢先登记；唯一索引是最终仲裁者。
    const raced = db.query(`SELECT * FROM jobs WHERE user_name=? AND dedupe_key=?
      AND status IN ('queued','running','waiting_external','paused') LIMIT 1`).get(username, input.dedupeKey) as Record<string, unknown> | null;
    if (raced) return { job: rowToJob(raced), created: false };
    throw error;
  }
  return { job: getJob(id)!, created: true };
}

export function getJob(id: string): DurableJob | null {
  const row = getDb().query("SELECT * FROM jobs WHERE id=?").get(id) as Record<string, unknown> | null;
  return row ? rowToJob(row) : null;
}

export function getActiveJob(user: string | null, dedupeKey: string): DurableJob | null {
  const row = getDb().query(`SELECT * FROM jobs WHERE user_name=? AND dedupe_key=?
    AND status IN ('queued','running','waiting_external','paused') LIMIT 1`)
    .get(durableUser(user), dedupeKey) as Record<string, unknown> | null;
  return row ? rowToJob(row) : null;
}

export function listJobs(user: string | null, title?: string, activeOnly = false): DurableJob[] {
  const args: (string | number | null)[] = [durableUser(user)];
  let sql = "SELECT * FROM jobs WHERE user_name=?";
  if (title !== undefined) { sql += " AND scope_title=?"; args.push(title); }
  if (activeOnly) sql += " AND status IN ('queued','running','waiting_external','paused')";
  sql += " ORDER BY updated_at DESC";
  return (getDb().query(sql).all(...args) as Record<string, unknown>[]).map(rowToJob);
}

export function updateJob(id: string, patch: {
  status?: JobStatus; phase?: string; progress?: unknown; recovery?: unknown; result?: unknown; error?: string | null;
  leaseOwner?: string | null; leaseExpiresAt?: string | null;
}): DurableJob | null {
  const prev = getJob(id);
  if (!prev) return null;
  const status = patch.status ?? prev.status;
  getDb().query(`UPDATE jobs SET status=?, phase=?, progress_json=COALESCE(?,progress_json),
    recovery_json=COALESCE(?,recovery_json), result_json=COALESCE(?,result_json), error=?,
    lease_owner=?, lease_expires_at=?, updated_at=? WHERE id=?`).run(
      status, patch.phase ?? prev.phase,
      patch.progress === undefined ? null : JSON.stringify(patch.progress),
      patch.recovery === undefined ? null : JSON.stringify(patch.recovery),
      patch.result === undefined ? null : JSON.stringify(patch.result),
      patch.error === undefined ? prev.error ?? null : patch.error,
      patch.leaseOwner === undefined ? null : patch.leaseOwner,
      patch.leaseExpiresAt === undefined ? null : patch.leaseExpiresAt,
      now(), id,
    );
  if (prev.commandId && ["succeeded", "failed", "cancelled"].includes(status)) {
    updateCommand(prev.commandId, status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed", patch.result, patch.error ?? undefined);
  }
  return getJob(id);
}

export function transitionJob(id: string, from: JobStatus[], to: JobStatus, phase: string): boolean {
  if (from.length === 0) return false;
  const placeholders = from.map(() => "?").join(",");
  const result = getDb().query(`UPDATE jobs SET status=?,phase=?,updated_at=? WHERE id=? AND status IN (${placeholders})`)
    .run(to, phase, now(), id, ...from);
  return Number(result.changes) === 1;
}

export function listScheduledJobs(kind: string): DurableJob[] {
  return (getDb().query(`SELECT * FROM jobs WHERE kind=? AND status='queued' ORDER BY deadline_at,created_at`).all(kind) as Record<string, unknown>[])
    .map(rowToJob);
}

/** 收敛重启后已失去进程执行句柄的任务；仅保留有安全恢复点的任务。 */
export function settleOrphanedJobs(): number {
  const rows = getDb().query(`SELECT id,kind,status,recovery_json FROM jobs
    WHERE status IN ('queued','running','waiting_external')`).all() as {
      id: string; kind: string; status: JobStatus; recovery_json: string | null;
    }[];
  let interrupted = 0;
  for (const row of rows) {
    const recovery = parseJson<Record<string, unknown>>(row.recovery_json);
    const resumableVideo = (row.kind === "video" || row.kind === "media-regenerate") && typeof recovery?.videoId === "string" && Boolean(recovery.videoId);
    const resumableAuto = row.kind === "auto";
    const scheduledMedia = row.kind === "media-auto-generate" && row.status === "queued";
    if (resumableVideo || resumableAuto || scheduledMedia) {
      updateJob(row.id, {
        status: resumableVideo ? "waiting_external" : "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      continue;
    }
    updateJob(row.id, {
      status: "interrupted",
      phase: "interrupted",
      error: "服务重启中断了任务；已核对持久状态，无法证明任务完成",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    interrupted++;
  }
  return interrupted;
}

export function syncRevision(user: string | null, scope: string, document: string): { revision: number; hash: string } {
  const row = getDb().query("SELECT revision,content_hash FROM sync_scopes WHERE user_name=? AND scope=? AND document=?")
    .get(durableUser(user), scope, document) as { revision: number; content_hash: string } | null;
  return { revision: row?.revision ?? 0, hash: row?.content_hash ?? "" };
}

export type ProjectionCommit = {
  revision: number;
  hash: string;
  changed: boolean;
  cursor: number;
  frameCursor?: number;
  frame?: { type: "patch"; scope: string; document: string; baseRevision: number; revision: number; hash: string; ops: JsonPatchOperation[] };
};

function projectionFrameAt(user: string, scope: string, document: string, revision: number): { cursor: number; frame?: ProjectionCommit["frame"] } | null {
  const row = getDb().query(`SELECT id,frame_json FROM sync_outbox
    WHERE user_name=? AND scope=? AND document=? AND revision=?`).get(user, scope, document, revision) as { id: number; frame_json: string } | null;
  return row ? { cursor: Number(row.id), frame: parseJson<ProjectionCommit["frame"]>(row.frame_json) } : null;
}

/** 非 world 投影的正文、revision/hash 与 RFC 6902 outbox 在同一事务内提交。 */
export function recordProjectionSnapshot(user: string | null, scope: string, document: string, data: unknown): ProjectionCommit {
  const username = durableUser(user);
  const hash = contentHash(data);
  const json = canonicalJson(data);
  const db = getDb();
  const tx = db.transaction((): ProjectionCommit => {
    const row = db.query("SELECT revision,content_hash,document_json FROM sync_scopes WHERE user_name=? AND scope=? AND document=?")
      .get(username, scope, document) as { revision: number; content_hash: string; document_json: string | null } | null;
    const revision = Number(row?.revision ?? 0);
    if (row?.content_hash === hash && row.document_json === json) {
      const previousFrame = projectionFrameAt(username, scope, document, revision);
      return { revision, hash, changed: false, cursor: latestOutboxCursor(username), frameCursor: previousFrame?.cursor, frame: previousFrame?.frame };
    }
    const previous = row?.document_json ? parseJson<unknown>(row.document_json) : undefined;
    const nextRevision = revision + 1;
    const ops = createJsonPatch(previous, data);
    const frame = { type: "patch" as const, scope, document, baseRevision: revision, revision: nextRevision, hash, ops };
    const at = now();
    db.query(`INSERT INTO sync_scopes(user_name,scope,document,revision,content_hash,document_json,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_name,scope,document) DO UPDATE SET
      revision=excluded.revision,content_hash=excluded.content_hash,document_json=excluded.document_json,updated_at=excluded.updated_at`)
      .run(username, scope, document, nextRevision, hash, json, at);
    db.query(`INSERT INTO sync_outbox
      (user_name,scope,document,base_revision,revision,content_hash,frame_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(username, scope, document, revision, nextRevision, hash, JSON.stringify(frame), at);
    const cursor = Number((db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    return { revision: nextRevision, hash, changed: true, cursor, frameCursor: cursor, frame };
  });
  return tx.immediate();
}

export type PreparedWorldCommit = { id: string; baseRevision: number; targetRevision: number; oldHash: string; newHash: string };

export function prepareWorldCommit(input: { user: string | null; title: string; filePath: string; oldJson?: string; newJson: string }): PreparedWorldCommit {
  const username = durableUser(input.user);
  const scope = `story/${input.title}`;
  const current = syncRevision(username, scope, "world");
  const oldHash = input.oldJson === undefined ? "" : contentHash(input.oldJson);
  if (current.hash && oldHash && current.hash !== oldHash) {
    throw new RevisionConflictError(`世界文件与控制面 hash 不一致：${input.title}`);
  }
  const id = crypto.randomUUID();
  const at = now();
  getDb().query(`INSERT INTO world_commits
    (id,user_name,title,file_path,base_revision,target_revision,old_hash,new_hash,old_json,new_json,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, username, input.title, input.filePath, current.revision, current.revision + 1,
      oldHash, contentHash(input.newJson), input.oldJson ?? null, input.newJson, "prepared", at, at,
    );
  return { id, baseRevision: current.revision, targetRevision: current.revision + 1, oldHash, newHash: contentHash(input.newJson) };
}

export function commitWorldCommit(id: string): PreparedWorldCommit {
  const db = getDb();
  const row = db.query("SELECT * FROM world_commits WHERE id=?").get(id) as Record<string, unknown> | null;
  if (!row) throw new Error(`world commit 不存在: ${id}`);
  const info = { id, baseRevision: Number(row.base_revision), targetRevision: Number(row.target_revision), oldHash: String(row.old_hash), newHash: String(row.new_hash) };
  if (row.status === "committed") return info;
  const tx = db.transaction(() => {
    const at = now();
    const username = String(row.user_name);
    const scope = `story/${String(row.title)}`;
    db.query(`INSERT INTO sync_scopes(user_name,scope,document,revision,content_hash,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(user_name,scope,document) DO UPDATE SET
      revision=excluded.revision,content_hash=excluded.content_hash,updated_at=excluded.updated_at`)
      .run(username, scope, "world", info.targetRevision, info.newHash, at);
    const frame = { type: "document-changed", scope, document: "world", baseRevision: info.baseRevision, revision: info.targetRevision, hash: info.newHash };
    db.query(`INSERT OR IGNORE INTO sync_outbox
      (user_name,scope,document,base_revision,revision,content_hash,frame_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(username, scope, "world", info.baseRevision, info.targetRevision, info.newHash, JSON.stringify(frame), at);
    db.query("UPDATE world_commits SET status='committed',updated_at=? WHERE id=?").run(at, id);
  });
  tx();
  return info;
}

export function abortWorldCommit(id: string, error: string): void {
  getDb().query("UPDATE world_commits SET status='aborted',error=?,updated_at=? WHERE id=? AND status='prepared'").run(error, now(), id);
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.recover-${process.pid}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

export function recoverPreparedWorldCommits(): { committed: number; aborted: number; conflicts: number } {
  const db = getDb();
  const rows = db.query("SELECT * FROM world_commits WHERE status='prepared' ORDER BY created_at")
    .all() as Record<string, unknown>[];
  const result = { committed: 0, aborted: 0, conflicts: 0 };
  for (const row of rows) {
    const id = String(row.id);
    const path = String(row.file_path);
    const disk = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
    const diskHash = disk === undefined ? "" : contentHash(disk);
    if (diskHash === String(row.new_hash)) {
      commitWorldCommit(id); result.committed++; continue;
    }
    if (diskHash === String(row.old_hash)) {
      abortWorldCommit(id, "启动恢复：文件仍为旧版本"); result.aborted++; continue;
    }
    // 若磁盘缺失但 journal 保存了旧内容，恢复旧文件后中止提交；其他未知内容不覆盖。
    if (disk === undefined && row.old_json) {
      atomicWrite(path, String(row.old_json));
      abortWorldCommit(id, "启动恢复：主文件缺失，已恢复旧版本"); result.aborted++; continue;
    }
    db.query("UPDATE world_commits SET status='conflict',error=?,updated_at=? WHERE id=?")
      .run("启动恢复：磁盘内容与 journal 新旧 hash 均不匹配", now(), id);
    result.conflicts++;
  }
  return result;
}

export function pendingOutbox(afterId = 0, limit = 500): { id: number; frame: unknown }[] {
  return (getDb().query("SELECT id,frame_json FROM sync_outbox WHERE id>? ORDER BY id LIMIT ?").all(afterId, limit) as { id: number; frame_json: string }[])
    .map((row) => ({ id: row.id, frame: JSON.parse(row.frame_json) as unknown }));
}

export function latestOutboxCursor(user: string | null): number {
  const row = getDb().query("SELECT COALESCE(MAX(id),0) AS id FROM sync_outbox WHERE user_name=?")
    .get(durableUser(user)) as { id: number };
  return Number(row.id ?? 0);
}

export function userOutboxAfter(user: string | null, afterId: number, limit = 500): { id: number; frame: Record<string, unknown> }[] {
  return (getDb().query("SELECT id,frame_json FROM sync_outbox WHERE user_name=? AND id>? ORDER BY id LIMIT ?")
    .all(durableUser(user), Math.max(0, afterId), limit) as { id: number; frame_json: string }[])
    .map((row) => ({ id: row.id, frame: JSON.parse(row.frame_json) as Record<string, unknown> }));
}
