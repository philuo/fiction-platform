// 一致性治理：章节变更（编辑/重写/回滚/删除）后的确定性审计与安全修复。
// 原则：① 审计零 LLM、可重复幂等；② autoRepair 只做确定性可逆修复（孤儿条目/悬空键），
//       任何删除正文/媒体/伏笔的动作一律不做，升级为 finding 交用户决策；③ 删章允许空洞、绝不重排 index。
// 注：登场记录重算（recomputeAppearedIn）不在 autoRepair 内——正文变更路径（settle/编辑/回滚/重写/改名/删章）
//     均已显式重算，读时自愈（/api/novel/state）兜底历史脏数据；避免每次伏笔/蓝图/设定写点
//     的 alignWorld 都做 O(全书正文) 全量扫描。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { recomputeAppearedIn } from "./chronicler";
import { logChange } from "./steering";
import { storyDir } from "./storage";
import { isPendingForeshadow } from "./world";
import type { ChapterDelta, ConsistencyFinding, WorldState } from "./world";

const fid = (kind: string, target: string | number): string => `${kind}:${target}`;

/** 字段级冲突检查：index 之后的章节变更快照中，是否存在对同一目标（角色 id+字段 / 全局当前状态 / 弧线 id）的变更 */
function hasLaterChange(w: WorldState, chapterIndex: number, check: (d: ChapterDelta) => boolean): boolean {
  const deltas = w.chapterDeltas ?? {};
  for (const i of Object.keys(deltas).map(Number).filter((i) => i > chapterIndex).sort((a, b) => a - b)) {
    if (check(deltas[i])) return true;
  }
  return false;
}

/**
 * 按本章结算变更快照逆操作恢复账本（git revert 语义）：
 * - 伏笔：本章回收的伏笔回退为回收前状态（埋设未回收的由 deleteChapterCascade 现有逻辑删除）
 * - 角色 status/look：字段级冲突检查（后续章未改则恢复旧值，后续章改过则保留并报告）
 * - 全局当前状态、弧线：同上冲突检查后恢复
 * - 提案：pending 移除；confirmed 保留并留痕（角色已入册，保守不移除）
 * 返回恢复/冲突/留痕 finding 列表；不碰磁盘，纯函数。
 */
export function applyChapterDeltaRevert(w: WorldState, chapterIndex: number, delta: ChapterDelta): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];

  // 伏笔回退：本章回收的伏笔恢复为回收前状态
  for (const rf of delta.resolvedForeshadows) {
    const f = w.foreshadowing.find((x) => x.id === rf.id);
    if (!f) continue;
    f.status = rf.prevStatus;
    f.resolvedAt = rf.prevResolvedAt;
    f.note = rf.prevNote;
    findings.push({ id: fid("delta-restored", `foreshadow:${rf.id}`), level: "info", kind: "delta-restored", chapterIndex, issue: `伏笔「${f.text.slice(0, 30)}」的回收记录已随第 ${chapterIndex} 章删除而回退（恢复为${rf.prevStatus}）`, suggestion: "若该悬念仍需回收，请在后续章节重新安排" });
  }

  // 角色字段恢复（字段级冲突检查）
  for (const cu of delta.characterUpdates) {
    const c = w.characters.find((x) => x.id === cu.id);
    if (!c) continue;
    if (cu.status) {
      const later = hasLaterChange(w, chapterIndex, (d) => d.characterUpdates.some((x) => x.id === cu.id && x.status));
      if (later) {
        findings.push({ id: fid("delta-conflict", `${cu.id}:status`), level: "warning", kind: "delta-conflict", chapterIndex, issue: `角色「${c.name}」的状态在后续章节仍被更新，保留后续值（删除第 ${chapterIndex} 章的变更为 ${cu.status.neu}）`, suggestion: "如需回退到删除章之前的状态，请在角色面板手动修改" });
      } else if (cu.status.old !== undefined) {
        c.status = cu.status.old;
        findings.push({ id: fid("delta-restored", `${cu.id}:status`), level: "info", kind: "delta-restored", chapterIndex, issue: `角色「${c.name}」的状态已恢复为删除前的「${cu.status.old}」`, suggestion: "" });
      }
    }
    if (cu.look) {
      const later = hasLaterChange(w, chapterIndex, (d) => d.characterUpdates.some((x) => x.id === cu.id && x.look));
      if (later) {
        findings.push({ id: fid("delta-conflict", `${cu.id}:look`), level: "warning", kind: "delta-conflict", chapterIndex, issue: `角色「${c.name}」的形象在后续章节仍被更新，保留后续值（删除第 ${chapterIndex} 章的变更为 ${cu.look.neu}）`, suggestion: "如需回退到删除章之前的状态，请在角色面板手动修改" });
      } else if (cu.look.old !== undefined) {
        c.look = cu.look.old;
        findings.push({ id: fid("delta-restored", `${cu.id}:look`), level: "info", kind: "delta-restored", chapterIndex, issue: `角色「${c.name}」的形象已恢复为删除前的「${cu.look.old}」`, suggestion: "" });
      } else {
        delete c.look; // 删除章之前该角色本无形象
        findings.push({ id: fid("delta-restored", `${cu.id}:look`), level: "info", kind: "delta-restored", chapterIndex, issue: `角色「${c.name}」的形象已随删除清空（删除前无形象）`, suggestion: "" });
      }
    }
  }

  // 全局当前状态恢复（冲突检查）
  if (delta.worldCurrent) {
    const later = hasLaterChange(w, chapterIndex, (d) => !!d.worldCurrent);
    if (later) {
      findings.push({ id: fid("delta-conflict", "world-current"), level: "warning", kind: "delta-conflict", chapterIndex, issue: "全局当前状态在后续章节仍被更新，保留后续值（未回退删除章之前的结算值）", suggestion: "如需回退，请在全局设置中手动修改当前状态" });
    } else {
      w.current = delta.worldCurrent.old;
      findings.push({ id: fid("delta-restored", "world-current"), level: "info", kind: "delta-restored", chapterIndex, issue: "全局当前状态已恢复为删除章之前的结算值", suggestion: "" });
    }
  }

  // 弧线状态恢复（冲突检查）
  for (const pt of delta.plotThreadUpdates) {
    const target = (w.plotThreads ?? []).find((x) => x.id === pt.id);
    if (!target) continue;
    const later = hasLaterChange(w, chapterIndex, (d) => d.plotThreadUpdates.some((x) => x.id === pt.id));
    if (later) {
      findings.push({ id: fid("delta-conflict", `thread:${pt.id}`), level: "warning", kind: "delta-conflict", chapterIndex, issue: `弧线「${target.name}」的状态在后续章节仍被更新，保留后续值`, suggestion: "" });
    } else {
      target.status = pt.oldStatus as "进行中" | "已解决";
      target.note = pt.oldNote;
      findings.push({ id: fid("delta-restored", `thread:${pt.id}`), level: "info", kind: "delta-restored", chapterIndex, issue: `弧线「${target.name}」已恢复为删除章之前的状态（${pt.oldStatus}）`, suggestion: "" });
    }
  }

  // 角色关系回退（增量合并的逆操作：有旧值恢复，无旧值删除该向关系；后续章改过则保留并报告）
  for (const ru of delta.relationUpdates ?? []) {
    const c = w.characters.find((x) => x.id === ru.id);
    if (!c) continue;
    const cur = c.relations?.[ru.target];
    if (cur === undefined) continue;
    const later = hasLaterChange(w, chapterIndex, (d) => d.relationUpdates.some((x) => x.id === ru.id && x.target === ru.target));
    if (later) {
      findings.push({ id: fid("delta-conflict", `${ru.id}:rel:${ru.target}`), level: "warning", kind: "delta-conflict", chapterIndex, issue: `角色「${c.name}」与「${ru.target}」的关系在后续章节仍被更新，保留后续值`, suggestion: "如需回退，请在角色面板手动修改" });
    } else if (ru.old !== undefined) {
      c.relations = { ...(c.relations ?? {}), [ru.target]: ru.old };
      findings.push({ id: fid("delta-restored", `${ru.id}:rel:${ru.target}`), level: "info", kind: "delta-restored", chapterIndex, issue: `角色「${c.name}」与「${ru.target}」的关系已恢复为「${ru.old}」`, suggestion: "" });
    } else {
      const { [ru.target]: _drop, ...rest } = c.relations ?? {};
      c.relations = rest;
      findings.push({ id: fid("delta-restored", `${ru.id}:rel:${ru.target}`), level: "info", kind: "delta-restored", chapterIndex, issue: `角色「${c.name}」与「${ru.target}」的关系已随删除清除`, suggestion: "" });
    }
  }

  // 设定规则回退：移除本章新增的规则（后续章也引用了同规则则提示）
  for (const r of delta.addedSettingRules ?? []) {
    const stillUsed = hasLaterChange(w, chapterIndex, (d) => (d.addedSettingRules ?? []).includes(r));
    if (stillUsed) {
      findings.push({ id: fid("delta-conflict", `setting-rule:${r.slice(0, 16)}`), level: "warning", kind: "delta-conflict", chapterIndex, issue: `设定规则「${r.slice(0, 30)}」在后续章节仍被引用，保留该规则`, suggestion: "" });
    } else {
      w.setting.rules = (w.setting.rules ?? []).filter((x) => x !== r);
    }
  }
  if ((delta.addedSettingRules ?? []).length) {
    findings.push({ id: fid("delta-restored", "setting-rules"), level: "info", kind: "delta-restored", chapterIndex, issue: `第 ${chapterIndex} 章新增的设定规则已随删除回退`, suggestion: "" });
  }

  // 提案：pending 移除；confirmed 留痕（角色已入册，保守不移除）
  for (const pid of delta.proposalIds) {
    const prop = (w.characterProposals ?? []).find((x) => x.id === pid);
    if (!prop) continue;
    if (prop.status === "pending") {
      w.characterProposals = (w.characterProposals ?? []).filter((x) => x.id !== pid);
      findings.push({ id: fid("delta-restored", `proposal:${pid}`), level: "info", kind: "delta-restored", chapterIndex, issue: `待确认角色提案「${prop.name}」已随第 ${chapterIndex} 章删除而移除`, suggestion: "" });
    } else {
      findings.push({ id: fid("delta-conflict", `proposal:${pid}`), level: "info", kind: "delta-conflict", chapterIndex, issue: `角色「${prop.name}」由第 ${chapterIndex} 章提案且已确认入册，删除章节不自动移除角色`, suggestion: "如需移除该角色，可在设置面板角色页删除（未登场才可删）" });
    }
  }

  return findings;
}

/**
 * 确定性全书审计（零 LLM，纯函数可单测）：孤儿引用 / 悬空键 / 伏笔章号异常 / 摘要人物偏离名册。
 * 只产出 findings，不改状态；chapterPlans 中 status=planned 的未来本章计划不算孤儿。
 */
export function auditWorld(w: WorldState): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const valid = new Set(w.chapters.map((c) => c.index));
  const has = (i: number) => valid.has(i);
  const roster = new Set(w.characters.map((c) => c.name));

  for (const s of w.chapterSummaries ?? []) {
    if (!has(s.index)) {
      findings.push({ id: fid("orphan-summary", s.index), level: "warning", kind: "orphan-summary", chapterIndex: s.index, issue: `第 ${s.index} 节摘要指向不存在的章节`, suggestion: "运行一键修复清除孤儿摘要" });
    } else {
      for (const name of s.appeared ?? []) {
        if (name && !roster.has(name)) {
          findings.push({ id: fid("summary-unknown-char", `${s.index}:${name}`), level: "info", kind: "summary-unknown-char", chapterIndex: s.index, issue: `第 ${s.index} 章摘要登场名单含未入册角色「${name}」`, suggestion: "可能是新角色提案未确认，或摘要过期，可重算本章记账" });
        }
      }
    }
  }
  for (const t of w.timeline) {
    if (!has(t.chapter)) {
      findings.push({ id: fid("orphan-timeline", t.chapter), level: "warning", kind: "orphan-timeline", chapterIndex: t.chapter, issue: `时间线第 ${t.chapter} 章条目指向不存在的章节`, suggestion: "运行一键修复清除孤儿条目" });
    }
  }
  for (const p of w.chapterPlans ?? []) {
    // 仅已核销（done）的本章计划需要章节存在；planned 指向未来章节是正常态
    if (p.status === "done" && !has(p.index)) {
      findings.push({ id: fid("orphan-plan", p.index), level: "warning", kind: "orphan-plan", chapterIndex: p.index, issue: `第 ${p.index} 节本章计划已核销但章节不存在`, suggestion: "运行一键修复清除孤儿本章计划" });
    }
  }
  for (const d of w.qualityDebt ?? []) {
    if (!has(d.chapterIndex)) {
      findings.push({ id: fid("orphan-debt", d.id), level: "info", kind: "orphan-debt", chapterIndex: d.chapterIndex, issue: `质量债务（${d.lens}）指向不存在的第 ${d.chapterIndex} 章`, suggestion: "运行一键修复清除悬空债务" });
    }
  }
  for (const k of Object.keys(w.chapterGen ?? {})) {
    if (!has(Number(k))) {
      findings.push({ id: fid("dangling-chaptergen", k), level: "info", kind: "dangling-chaptergen", chapterIndex: Number(k), issue: `第 ${k} 节存在章节级生成参数覆盖但章节不存在`, suggestion: "运行一键修复清除悬空覆盖" });
    }
  }
  for (const f of w.foreshadowing) {
    // 非法伏笔：文本为空或状态不在枚举（脏数据直接可见，不静默）
    const validStatus = f.status === "planted" || f.status === "active" || f.status === "resolved";
    if (!f.text || !f.text.trim() || !validStatus) {
      findings.push({ id: fid("foreshadow-invalid", f.id), level: "warning", kind: "foreshadow-invalid", chapterIndex: f.plantedAt, issue: `伏笔「${(f.text ?? "").slice(0, 30)}」数据非法（${!validStatus ? `状态「${f.status}」不在已埋设/推进中/已回收` : "内容为空"}）`, suggestion: "请在伏笔账本中修正或删除该条目" });
    }
    if (!has(f.plantedAt) && f.status !== "resolved") {
      // 待埋设（plantedAt 指向尚未创作的未来章节，如抽卡预登记）= 正常过渡态，不报异常
      if (isPendingForeshadow(w, f)) continue;
      findings.push({ id: fid("foreshadow-orphan-planted", f.id), level: "danger", kind: "foreshadow-orphan-planted", chapterIndex: f.plantedAt, issue: `活跃伏笔「${f.text.slice(0, 40)}」的埋设章（第 ${f.plantedAt} 章）已被删除`, suggestion: "源章节已删除：请在伏笔账本中手动处置（回收或删除）" });
    }
    if (f.resolvedAt != null && !has(f.resolvedAt)) {
      findings.push({ id: fid("foreshadow-orphan-resolved", f.id), level: "warning", kind: "foreshadow-orphan-resolved", chapterIndex: f.resolvedAt, issue: `伏笔「${f.text.slice(0, 40)}」的回收章（第 ${f.resolvedAt} 章）已不存在`, suggestion: "回收记录保留留痕，建议人工复核" });
    }
    if (f.resolvedAt != null && f.resolvedAt < f.plantedAt) {
      findings.push({ id: fid("foreshadow-order", f.id), level: "warning", kind: "foreshadow-order", chapterIndex: f.resolvedAt, issue: `伏笔「${f.text.slice(0, 40)}」回收章早于埋设章`, suggestion: "章号记录异常，建议人工复核" });
    }
  }
  for (const c of w.characters) {
    if (c.exit?.chapter != null && !has(c.exit.chapter)) {
      findings.push({ id: fid("dangling-exit", c.id), level: "warning", kind: "dangling-exit", issue: `角色「${c.name}」的离场记录指向不存在的第 ${c.exit.chapter} 节`, suggestion: "源章节已删除：请人工确认该角色是否仍应离场" });
    }
  }
  return findings.slice(0, 100); // 截断保护
}

/**
 * 安全自动修复（幂等）：仅清除孤儿条目/悬空键 + 重算登场记录。
 * 不删正文/媒体/伏笔——这些一律以 finding 形式交用户决策。
 */
export function autoRepair(w: WorldState): string[] {
  const fixed: string[] = [];
  const valid = new Set(w.chapters.map((c) => c.index));

  const before = (w.chapterSummaries ?? []).length;
  w.chapterSummaries = (w.chapterSummaries ?? []).filter((s) => valid.has(s.index));
  if (w.chapterSummaries.length < before) fixed.push(`清除 ${before - w.chapterSummaries.length} 条孤儿章节摘要`);

  const tBefore = w.timeline.length;
  w.timeline = w.timeline.filter((t) => valid.has(t.chapter));
  if (w.timeline.length < tBefore) fixed.push(`清除 ${tBefore - w.timeline.length} 条孤儿时间线`);

  const pBefore = (w.chapterPlans ?? []).length;
  w.chapterPlans = (w.chapterPlans ?? []).filter((p) => !(p.status === "done" && !valid.has(p.index)));
  if ((w.chapterPlans ?? []).length < pBefore) fixed.push(`清除 ${pBefore - (w.chapterPlans ?? []).length} 条孤儿本章计划`);

  const dBefore = (w.qualityDebt ?? []).length;
  w.qualityDebt = (w.qualityDebt ?? []).filter((d) => valid.has(d.chapterIndex));
  if ((w.qualityDebt ?? []).length < dBefore) fixed.push(`清除 ${dBefore - (w.qualityDebt ?? []).length} 条悬空质量债务`);

  if (w.chapterGen) {
    let n = 0;
    for (const k of Object.keys(w.chapterGen)) {
      if (!valid.has(Number(k))) { delete w.chapterGen[Number(k)]; n++; }
    }
    if (n) fixed.push(`清除 ${n} 个悬空章节级参数覆盖`);
  }

  if (fixed.length) {
    logChange(w, { chapter: w.nextChapter, actor: "ai", kind: "integrity-repair", detail: fixed.join("；") });
  }
  return fixed;
}

/** 全局账本确定性对齐（零 LLM、幂等）：复用 autoRepair（孤儿摘要/时间线/本章计划/债务/章节覆盖）。
 * 供角色/伏笔/大纲/设定/世界书等全局变更后自动调用，保持引用与索引一致。
 * 登场记录重算由正文变更路径显式触发（settle/编辑/回滚/重写/改名/删章 + 读时自愈）。 */
export function alignWorld(w: WorldState): string[] {
  return autoRepair(w);
}

/**
 * 收集磁盘孤儿媒体文件（只读扫描）：列举 images/videos/versions 目录，
 * 返回 state 未引用的文件相对路径（不含 .DS_Store）。供巡检 scan 报告、repair 删盘。
 * 与 autoRepair 的区别：autoRepair 修的是 state 内孤儿条目；本函数扫的是磁盘上 state 未引用的文件
 * （旧重生成/迁移残留、后台生成被删章节丢弃的产物等--历史遗留的本地无用数据）。
 */
export function collectOrphanMediaFiles(w: WorldState): string[] {
  const referenced = new Set<string>();
  const add = (p?: string) => { if (p && typeof p === "string" && p.trim()) referenced.add(p); };
  add(w.cover);
  for (const c of w.characters) { add(c.image); add(c.portrait?.path); }
  for (const ch of w.chapters) {
    for (const m of ch.media ?? []) add(m.path);
    for (const f of ch.versionFiles ?? []) add(`versions/${f}`);
  }
  const orphans: string[] = [];
  for (const sub of ["images", "videos", "versions"]) {
    const d = join(storyDir(w.title), sub);
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; } // 目录不存在 = 无文件
    for (const f of entries) {
      if (f === ".DS_Store") continue;
      const rel = `${sub}/${f}`;
      if (!referenced.has(rel)) orphans.push(rel);
    }
  }
  return orphans;
}

export type DeleteCascadeResult = {
  mediaPaths: string[]; // 待锁外删盘的媒体文件（已做全书引用校验）
  versionFilePaths: string[]; // 待锁外删盘的章节版本快照（versions/ 外置，章节删除后无引用）
  findings: ConsistencyFinding[]; // 删章引发的危险/留痕项（交报告呈现）
  removedForeshadows: number;
};

/**
 * 删章级联（纯函数，不碰磁盘）：允许空洞、绝不重排 index。
 * 变更快照恢复（git 式）：有 chapterDelta 时先按快照逆操作恢复角色形象/当前状态/弧线/伏笔回收/提案，
 * 无快照（旧存档）则降级为基础清理并提示；随后清理该章摘要/时间线/本章计划/质量债务/参数覆盖；
 * 伏笔保守策略（未回收者删除并列明，已回收者留痕）；清该章离场记录；重算登场；仅删尾章时回退 nextChapter。
 */
export function deleteChapterCascade(w: WorldState, index: number): DeleteCascadeResult {
  const findings: ConsistencyFinding[] = [];
  const ch = w.chapters.find((c) => c.index === index);
  if (!ch) return { mediaPaths: [], versionFilePaths: [], findings, removedForeshadows: 0 };

  // 媒体文件收集：仅删不被全书其他媒体引用的 path
  const others = new Set<string>();
  for (const c of w.chapters) {
    if (c.index === index) continue;
    for (const m of c.media ?? []) if (m.path) others.add(m.path);
  }
  const mediaPaths = (ch.media ?? []).map((m) => m.path).filter((p): p is string => !!p && !others.has(p));
  // 版本快照收集：本章外置版本文件（versions/<name>），章节删除后无引用，随删盘
  const versionFilePaths = (ch.versionFiles ?? []).map((f) => `versions/${f}`);

  // 变更快照恢复（git 式）：优先按本章结算快照逆操作恢复账本
  const delta = w.chapterDeltas?.[index];
  if (delta) {
    findings.push(...applyChapterDeltaRevert(w, index, delta));
    if (w.chapterDeltas) delete w.chapterDeltas[index];
  } else {
    findings.push({
      id: fid("delta-missing", index), level: "warning", kind: "delta-missing", chapterIndex: index,
      issue: "该章节无结算变更快照（旧存档或未结算），已按基础清理执行；被该章覆盖的角色形象/当前状态等无法自动恢复",
      suggestion: "如需精确恢复，请人工核对角色面板与全局当前状态",
    });
  }

  // 伏笔保守策略
  let removedForeshadows = 0;
  w.foreshadowing = w.foreshadowing.flatMap((f) => {
    if (f.plantedAt === index && f.status !== "resolved") {
      removedForeshadows++;
      findings.push({ id: fid("planted-foreshadow-lost", f.id), level: "danger", kind: "planted-foreshadow-lost", chapterIndex: index, issue: `本章埋设的活跃伏笔「${f.text.slice(0, 40)}」随章节删除`, suggestion: "如需保留该悬念，请在后续章节重新埋设" });
      return [];
    }
    if (f.resolvedAt === index) {
      findings.push({ id: fid("resolved-foreshadow-source-lost", f.id), level: "warning", kind: "resolved-foreshadow-source-lost", issue: `伏笔「${f.text.slice(0, 40)}」的回收章节（第 ${index} 节）已删除，回收记录保留留痕`, suggestion: "建议人工复核该伏笔是否需要重新回收" });
      return [{ ...f, note: `${f.note ?? ""}（源章节已删除）`.trim() }];
    }
    return [f];
  });

  // 该章离场记录清除
  for (const c of w.characters) {
    if (c.exit?.chapter === index) {
      delete c.exit;
      findings.push({ id: fid("exit-cleared", c.id), level: "info", kind: "exit-cleared", issue: `角色「${c.name}」的离场记录随第 ${index} 章删除被清除`, suggestion: "如角色确已离场，请在角色面板重新登记" });
    }
  }

  // 账本条目清理
  w.chapterSummaries = (w.chapterSummaries ?? []).filter((s) => s.index !== index);
  w.timeline = w.timeline.filter((t) => t.chapter !== index);
  const deletedPlan = (w.chapterPlans ?? []).find((p) => p.index === index);
  w.chapterPlans = (w.chapterPlans ?? []).filter((p) => p.index !== index);
  // 删章后弧状态检查：被删章所属弧若已 done，回退为 writing（摘要可能不准，下回合可重新触发边界处理）
  if (deletedPlan) {
    const arc = (w.storyArcs ?? []).find((a) => a.id === deletedPlan.arcId);
    if (arc && arc.status === "done") {
      arc.status = "writing";
      findings.push({ id: fid("arc-status-revert", deletedPlan.arcId), level: "warning", kind: "arc-status-revert", chapterIndex: index, issue: `弧「${arc.title}」因第 ${index} 章删除被回退为写作中（原状态 done，摘要可能需复核）`, suggestion: "弧内剩余章节写完后会重新触发边界处理生成新摘要" });
    }
  }
  w.qualityDebt = (w.qualityDebt ?? []).filter((d) => d.chapterIndex !== index);
  if (w.chapterGen) delete w.chapterGen[index];

  // 移除章节本体 + 登场重算
  w.chapters = w.chapters.filter((c) => c.index !== index);
  recomputeAppearedIn(w);

  // 仅删尾章时回退 nextChapter；删中间章保留（空洞），所有按 index 引用的账本零迁移
  if (index === w.nextChapter - 1) w.nextChapter--;

  return { mediaPaths, versionFilePaths, findings, removedForeshadows };
}
