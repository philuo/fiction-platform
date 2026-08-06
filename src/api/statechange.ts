// 状态变更收敛（DEEP-DIVE §2 / FLOWS flow 3 落地）：applyStateChange 单一写接口
// 中枢架构核心抽象：所有写 WorldState 的路径收敛到单一入口，由中枢统一 分级→预检→闸门→写+日志→收尾。
// - 分级判定：复用 steering.classifyWorldPatch（已登场角色改/已写章节改规则 → L2）
// - 确定性预检：复用 chronicler 守卫语义（字段锁 isLocked / 别名归一 / 长度 clamp / 去重）
// - 闸门审查：AGNES_BRAIN_GATE=on 且分级 ≥ L2 → 中枢模型审查（brain.gateChange），失败降级放行（闸门是"加保险"非"拦路虎"）
// - 写字段 + logCommandChange（携带 HARNESS commandId/level/reason）+ alignWorld + saveWorld 统一收尾
import { alignWorld } from "./integrity";
import { saveWorld } from "./storage";
import { classifyWorldPatch, logCommandChange, type ChangeLevel } from "./steering";
import { getCommand } from "./harness";
import type { ChangeLogEntry, WorldState } from "./world";

export type ChangeActor = "user" | "ai" | "brain" | "integrity" | "system";

/** 结构化变更描述（INTERVENTION §3 变更语义模型 + DEEP-DIVE §2.1） */
export type StateChange = {
  actor: ChangeActor;
  /** HARNESS 指令 ID（如 CMD-L07 伏笔 CRUD），写日志/闸门分级用 */
  commandId?: string;
  /** 目标字段路径描述（供日志/审查阅读，如 "foreshadowing"、"blueprint.compass"） */
  field: string;
  op?: "set" | "merge" | "delete" | "replace";
  value?: unknown;
  /** 业务语义说明（供中枢审查与 changeLog.detail） */
  reason: string;
  /** 附加元数据（受影响章/角色等，写入 changeLog.meta） */
  meta?: Record<string, unknown>;
  chapter?: number;
  /** 变更的分级（可选；缺省由 classifyWorldPatch 判定） */
  level?: ChangeLevel;
};

export type ChangeResult =
  | { ok: true; applied: true; level: ChangeLevel }
  | { ok: true; applied: false; reason: string; level: ChangeLevel } // 拒绝/被闸门修正，未写字段
  | { ok: false; error: string; level: ChangeLevel }; // 预检失败/异常

/** 确定性预检（复用 chronicler 守卫语义，纯函数不落盘）。
 * 目前覆盖：字段锁（characters[].status/look）与关键文本长度 clamp。
 * 后续可扩展：伏笔 ID 精确匹配、弧线 ID 匹配、数组去重等（chronicler.applySettle 内部仍保留完整守卫）。 */
function deterministicGuard(w: WorldState, change: StateChange): string | null {
  const value = change.value as Record<string, unknown> | undefined;
  // 字段锁：角色 status/look 被人工上锁时禁止覆盖
  if ((change.field === "characters" || change.field.startsWith("characters[")) && value) {
    if (typeof value.status === "string" || typeof value.look === "string") {
      const id = typeof value.id === "string" ? value.id : (change.meta?.characterId as string | undefined);
      if (id) {
        const locked = (w.lockedFields ?? []).filter((l) => l.characterId === id);
        if (locked.some((l) => l.field === "status") && typeof value.status === "string") {
          return `字段已上锁：${id}.status 禁止 AI 覆盖`;
        }
        if (locked.some((l) => l.field === "look") && typeof value.look === "string") {
          return `字段已上锁：${id}.look 禁止 AI 覆盖`;
        }
      }
    }
  }
  return null;
}

/** 变更分级：优先取 HARNESS 指令的 level（commandId 命中时权威），
 * 否则按 field 启发式：角色/设定规则复用 classifyWorldPatch，账本类字段按破坏性取 L2/L1，其余 L0。 */
export function classifyChange(w: WorldState, change: StateChange): ChangeLevel {
  if (change.level) return change.level;
  if (change.commandId) {
    const cmd = getCommand(change.commandId);
    if (cmd) return cmd.level;
  }
  // 字段启发式（无 commandId 的调用点）
  const f = change.field;
  // 媒体类（chapters[].media）优先：纯 L0 资源，不触发账本级分级
  if (f.includes(".media") || f === "cover" || f.startsWith("characters[") && (f.includes(".portrait") || f.includes(".image"))) {
    return "L0";
  }
  if (f === "characters" || f.startsWith("characters[") || f === "setting" || f.startsWith("setting[")) {
    return classifyWorldPatch(w, {});
  }
  if (
    f === "foreshadowing" || f === "timeline" || f === "plotThreads" || f === "chapterDeltas" ||
    f === "chapterSummaries" || f === "chapters" || f.startsWith("chapters[") ||
    f === "qualityDebt" || f === "characterProposals" || f === "current" || f === "appearedIn"
  ) {
    return "L2";
  }
  if (f === "blueprint" || f.startsWith("blueprint") || f === "outline" || f === "lore" || f === "gen" || f === "chapterPlans") {
    return "L1";
  }
  return "L0";
}

/** 应用变更的默认实现：按 field 顶层键直接写入（媒体/账本等复杂路径由调用方自行处理后传入已变更的引用）。
 * 注意：本实现接受「调用方已应用变更」的 w（内存引用），field 仅作日志/分级描述——这是收编既有写点的最小侵入方式，
 * 保证 routes 现有逻辑（伏笔 CRUD/蓝图编辑等）不改行为。 */
export function applyStateChange(
  w: WorldState,
  change: StateChange,
  opts?: { gate?: (w: WorldState, change: StateChange) => Promise<{ allow: boolean; reason?: string }> },
): ChangeResult {
  const level = classifyChange(w, change);
  const guard = deterministicGuard(w, change);
  if (guard) return { ok: false, error: guard, level };

  const cmd = change.commandId ? getCommand(change.commandId) : undefined;
  const entry: Omit<ChangeLogEntry, "at"> = {
    chapter: change.chapter ?? w.nextChapter,
    actor: change.actor,
    kind: cmd?.id ?? change.field,
    detail: change.reason,
    commandId: cmd?.id,
    level,
    ...(change.meta ? { meta: change.meta } : {}),
  };
  logCommandChange(w, entry);
  return { ok: true, applied: true, level };
}

/** 收尾：账本对齐 + 落盘（业务函数不落盘，由本接口统一 saveWorld——DEEP-DIVE §3.3 落盘三归一） */
export function finalizeStateChange(w: WorldState, result: { ok: boolean }): void {
  if (!result.ok) return;
  alignWorld(w);
  saveWorld(w);
}

/** 异步闸门版：适用于闸门需要 LLM 审查（AGNES_BRAIN_GATE=on 且 L2+）的场景。
 * 返回是否放行；失败降级放行（reason=brain_unavailable 已由 brain.gateChange 内部记录）。 */
export async function applyStateChangeAsync(
  w: WorldState,
  change: StateChange,
  opts?: { gate?: (w: WorldState, change: StateChange) => Promise<{ allow: boolean; reason?: string }> },
): Promise<ChangeResult> {
  if (opts?.gate) {
    try {
      const g = await opts.gate(w, change);
      if (!g.allow) {
        // 拒绝：写日志（applied:false），不写字段
        const cmd = change.commandId ? getCommand(change.commandId) : undefined;
        const lvl = classifyChange(w, change);
        logCommandChange(w, {
          chapter: change.chapter ?? w.nextChapter,
          actor: "brain",
          kind: "brain-gate-reject",
          detail: `${change.reason}（被中枢拒绝${g.reason ? `：${g.reason}` : ""}）`,
          commandId: cmd?.id,
          level: lvl,
          reason: g.reason ?? "gate_reject",
        });
        return { ok: true, applied: false, reason: g.reason ?? "gate_reject", level: lvl };
      }
    } catch {
      // 闸门异常：降级放行（闸门是"加保险"不是"拦路虎"）
    }
  }
  return applyStateChange(w, change, opts);
}
