// 中枢对话舱卡片组件库：卡片式浏览 + 智能控制的视觉载体
// 四类卡片：PreviewCard（操作预览）/ ConfirmCard（L2/L3 确认）/ ResultCard（执行结果）/ BrowseCard（浏览）
// 卡片类型定义同时供 PHASE 4 意图识别编排器产出
// 可选 image 字段：任意卡片可携带一张图（角色立绘/章节插画等），渲染在卡片内容上方
import { useState, type ReactNode } from "react";

// ============ 卡片数据类型 ============

/** 卡片附图（src 可为 data URI 或相对/绝对 URL） */
export type CardImage = { src: string; alt?: string };

export type BrainCardLevel = "L0" | "L1" | "L2" | "L3";

export type PreviewCard = {
  kind: "preview";
  title: string;
  commandId?: string;
  level?: BrainCardLevel;
  summary: string;
  confirmRequired?: boolean;
  /** 客户端执行信息：点击「执行」时 fetch 对应 /api/novel/* 端点 */
  action?: { endpoint: string; method?: string; body: Record<string, unknown> };
  /** 附图（如写操作影响章节的主插画预览） */
  image?: CardImage;
};

export type ConfirmCard = {
  kind: "confirm";
  title: string;
  commandId?: string;
  level?: BrainCardLevel;
  impact?: string;
  verdict?: string; // 闸门裁决 allow/reject
  options: ("merge" | "rewrite" | "abort")[];
};

export type ResultCard = {
  kind: "result";
  title: string;
  success: boolean;
  detail: string;
  image?: CardImage;
};

export type BrowseCardAction = {
  label: string;
  danger?: boolean;
  action: { endpoint: string; method?: string; body: Record<string, unknown> };
};

export type BrowseCard = {
  kind: "browse";
  title: string;
  browseType:
    | "chapter" | "character" | "foreshadow" | "review" | "eval" | "proposal" | "gacha"
    // —— 查询扩展（Phase 1）：列表/进度/统计可视化 ——
    | "chapters" | "characters" | "plans" | "tasks" | "logs" | "worldbook" | "media";
  data: unknown;
  /** 列表级可选操作（proposal 列表项内嵌 actions 由渲染层读取，此字段暂为列表级扩展） */
  actions?: BrowseCardAction[];
  /** 附图（如角色立绘/章节插画） */
  image?: CardImage;
};

/**
 * 可视化 data 约定（后端 executeQuery 产出，渲染层按 browseType 读取）：
 * - 通用进度字段：data.done / data.target（target 为 null 时不显示进度条）、data.pct 可选覆盖
 * - 统计网格：data.stats = Record<string, number>（chapters/characters/media/tasks 用）
 * - 列表：data.list = { 标题键, 元信息键, status?, score?, actions? }[]
 * - 内嵌操作：列表项 actions = { label, danger?, action: { endpoint, method, body } }[]
 */

/** 计划/意见选项卡（plan/opinion 共用）：中枢给出多个方向，用户点击遵循其意见 */
export type ChoiceOption = {
  label: string;
  description?: string;
  /** 可执行动作（点击后 fetch 端点） */
  action?: { endpoint: string; method?: string; body: Record<string, unknown> };
};

export type ChoiceCard = {
  kind: "plan" | "opinion";
  title: string;
  summary?: string;
  options: ChoiceOption[];
  image?: CardImage;
};

// ============ 表单卡（FormCard）：结构化字段 → 填写 → 提交 ============

/** 表单字段定义（与后端 brain-chat.ts FormFieldDef 结构一致） */
export type FormField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "multiselect";
  value?: string | number | string[];
  options?: { label: string; value: string }[];
  placeholder?: string;
  required?: boolean;
  /** textarea 按行拆分数组提交 */
  array?: boolean;
  /** "bool"：开/关 → boolean */
  transform?: "bool";
};

export type FormCard = {
  kind: "form";
  title: string;
  commandId?: string;
  level?: BrainCardLevel;
  summary?: string;
  fields: FormField[];
  action: { endpoint: string; method?: string; body: Record<string, unknown> };
  submitLabel?: string;
  /** L2/L3 提示：提交可能触发干预确认 */
  confirmRequired?: boolean;
  image?: CardImage;
};

export type BrainCard = PreviewCard | ConfirmCard | ResultCard | BrowseCard | ChoiceCard | FormCard;

// ============ 级别徽章 ============

const LEVEL_LABEL: Record<BrainCardLevel, string> = {
  L0: "L0·只读", L1: "L1·前瞻", L2: "L2·回溯", L3: "L3·不可逆",
};

function LevelBadge({ level }: { level?: BrainCardLevel }) {
  if (!level) return null;
  return <span className={`bc-level bc-level-${level}`}>{LEVEL_LABEL[level]}</span>;
}

function CommandBadge({ commandId }: { commandId?: string }) {
  if (!commandId) return null;
  return <span className="bc-cmd" title={`指令 ${commandId}`}>{commandId}</span>;
}

// ============ PreviewCard 操作预览卡 ============

export const PreviewCardView: React.FC<{ card: PreviewCard; onExecute?: () => void; busy?: boolean }> = ({ card, onExecute, busy }) => (
  <div className="brain-card brain-card-preview">
    <div className="brain-card-head">
      <span className="brain-card-title">{card.title}</span>
      <CommandBadge commandId={card.commandId} />
      <LevelBadge level={card.level} />
      {card.confirmRequired && <span className="bc-confirm-tag">需确认</span>}
    </div>
    <p className="brain-card-body">{card.summary}</p>
    {card.action && onExecute && (
      <div className="brain-card-actions">
        <button className="btn-save btn-xs" disabled={busy} onClick={onExecute}>执行</button>
      </div>
    )}
  </div>
);

// ============ ConfirmCard 确认卡（L2/L3 三选一） ============

export const ConfirmCardView: React.FC<{
  card: ConfirmCard;
  onChoose?: (opt: "merge" | "rewrite" | "abort") => void;
  busy?: boolean;
}> = ({ card, onChoose, busy }) => {
  const optLabel: Record<string, string> = { merge: "① 正向弥合", rewrite: "② 回溯重写", abort: "③ 放弃" };
  return (
    <div className="brain-card brain-card-confirm">
      <div className="brain-card-head">
        <span className="brain-card-title">{card.title}</span>
        <CommandBadge commandId={card.commandId} />
        <LevelBadge level={card.level} />
      </div>
      {card.impact && <p className="brain-card-impact">{card.impact}</p>}
      {card.verdict && <p className="brain-card-verdict">闸门裁决：{card.verdict}</p>}
      <div className="brain-card-actions">
        {card.options.map((opt) => (
          <button key={opt} className="btn-save btn-xs" disabled={busy} onClick={() => onChoose?.(opt)}>
            {optLabel[opt]}
          </button>
        ))}
      </div>
    </div>
  );
};

// ============ ResultCard 结果卡 ============

export const ResultCardView: React.FC<{ card: ResultCard }> = ({ card }) => (
  <div className={`brain-card brain-card-result ${card.success ? "ok" : "fail"}`}>
    <div className="brain-card-head">
      <span className="brain-card-title">{card.success ? "✓ " : "✗ "}{card.title}</span>
    </div>
    <p className="brain-card-body">{card.detail}</p>
  </div>
);

// ============ BrowseCard 浏览卡 ============

type ProposalListItem = Record<string, unknown> & {
  actions?: { label?: string; danger?: boolean; action?: BrowseCardAction["action"] }[];
};

// ============ 可视化辅助组件（Phase 1 查询卡共用） ============

/** 进度条：done/target；target 为 null/0 时不渲染 */
function CardProgressBar({ done, target }: { done?: unknown; target?: unknown }) {
  const d = Number(done ?? 0);
  const t = Number(target ?? 0);
  if (!(t > 0)) return null;
  const pct = Math.min(100, Math.round((d / t) * 100));
  return (
    <div className="bc-progress">
      <div className="bc-progress-bar"><span className="bc-progress-fill" style={{ width: `${pct}%` }} /></div>
      <span className="bc-progress-label">{d} / {t}（{pct}%）</span>
    </div>
  );
}

/** 统计网格：stats = Record<标签, 数值> */
function CardStats({ stats }: { stats?: unknown }) {
  const s = stats as Record<string, unknown> | null | undefined;
  if (!s) return null;
  const entries = Object.entries(s).filter(([, v]) => v != null);
  if (!entries.length) return null;
  return (
    <div className="bc-stats">
      {entries.map(([k, v]) => (
        <span className="bc-stat" key={k}><b>{String(v)}</b>{k}</span>
      ))}
    </div>
  );
}

/** 状态徽章（level 决定配色：ok=绿 / warn=琥珀 / danger=红 / info=灰） */
function CardStatusBadge({ status, level }: { status?: unknown; level?: "ok" | "warn" | "danger" | "info" }) {
  if (status == null || status === "") return null;
  return <span className={`bc-badge ${level ? `bc-badge-${level}` : "bc-badge-info"}`}>{String(status)}</span>;
}

/** 分数徽章（如审查 coherence 分） */
function CardScore({ score }: { score?: unknown }) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  const cls = s >= 8 ? "bc-badge-ok" : s >= 6 ? "bc-badge-warn" : "bc-badge-danger";
  return <span className={`bc-badge ${cls}`}>分 {s}</span>;
}

/** 列表项内嵌操作按钮（proposal/tasks 共用） */
function CardItemActions({
  item, busy, onAction,
}: {
  item: Record<string, unknown>;
  busy?: boolean;
  onAction?: (action: BrowseCardAction["action"]) => void;
}) {
  const actions = item.actions as ProposalListItem["actions"] | undefined;
  if (!Array.isArray(actions) || actions.length === 0 || !onAction) return null;
  return (
    <div className="bc-browse-actions">
      {actions.map((a, j) =>
        a.action ? (
          <button
            key={j}
            className={`btn-save btn-xs${a.danger ? " btn-danger-sm" : ""}`}
            disabled={busy}
            onClick={() => onAction(a.action!)}
          >
            {a.label ?? "执行"}
          </button>
        ) : null,
      )}
    </div>
  );
}

/** 列表项包装：主文本 + 元信息 + 徽章 + 操作 */
function CardListItem({ item, title, meta, status, statusLevel, score }: {
  item: Record<string, unknown>;
  title: ReactNode;
  meta?: ReactNode;
  status?: unknown;
  statusLevel?: "ok" | "warn" | "danger" | "info";
  score?: unknown;
}) {
  return (
    <div className="bc-browse-item">
      <div className="bc-browse-item-head">
        <span className="bc-browse-item-title">{title}</span>
        <span className="bc-browse-item-badges">
          <CardScore score={score} />
          <CardStatusBadge status={status} level={statusLevel} />
        </span>
      </div>
      {meta && <div className="bc-browse-meta">{meta}</div>}
    </div>
  );
}

/** 内嵌操作注入：给已渲染列表项追加操作按钮（与渲染体共享 item 数据） */
function WithItemActions({ item, busy, onAction, children }: {
  item: Record<string, unknown>;
  busy?: boolean;
  onAction?: (action: BrowseCardAction["action"]) => void;
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <CardItemActions item={item} busy={busy} onAction={onAction} />
    </>
  );
}

export const BrowseCardView: React.FC<{
  card: BrowseCard;
  onAction?: (action: BrowseCardAction["action"]) => void;
  busy?: boolean;
}> = ({ card, onAction, busy }) => {
  let body: ReactNode = null;
  const d = card.data as Record<string, unknown> | null;
  if (card.browseType === "chapter" && d) {
    body = (
      <>
        <div className="bc-browse-title">第 {String(d.index ?? "")} 章 · {String(d.title ?? "")}</div>
        <p className="bc-browse-text">{String(d.text ?? "").slice(0, 200)}…</p>
      </>
    );
  } else if (card.browseType === "character" && d) {
    body = (
      <>
        <div className="bc-browse-title">{String(d.name ?? "")} · {String(d.role ?? "")}</div>
        <p className="bc-browse-text">{String(d.motivation ?? "")}</p>
      </>
    );
  } else if (card.browseType === "foreshadow" && d) {
    const list = (Array.isArray(d.list) ? d.list : [d]) as Record<string, unknown>[];
    body = (
      <div className="bc-browse-list">
        {list.map((f, i) => (
          <div key={i} className="bc-browse-item">
            <span className="bc-browse-item-id">伏笔 · {String(f.id ?? "")}</span>
            <p className="bc-browse-text">{String(f.text ?? "")}</p>
            <span className="bc-browse-meta">状态：{String(f.status ?? "")}｜埋于第 {String(f.plantedAt ?? "")} 章</span>
          </div>
        ))}
      </div>
    );
  } else if (card.browseType === "proposal" && d) {
    // 新角色提案：推荐原因 + 动机 + 确认/拒绝操作（卡片可交互，允许操作）
    const list = (Array.isArray(d.list) ? d.list : [d]) as ProposalListItem[];
    body = (
      <div className="bc-browse-list">
        {list.map((p, i) => (
          <div key={String(p.id ?? i)} className="bc-browse-item bc-proposal-item">
            <div className="bc-proposal-head">
              <span className="bc-browse-item-id">角色提案 · {String(p.source === "gacha" ? "抽卡" : "剧情")}</span>
              <span className="bc-proposal-name">「{String(p.name ?? "")}」{String(p.role ?? "")}</span>
            </div>
            {p.reason ? <p className="bc-proposal-reason">推荐原因：{String(p.reason)}</p> : null}
            {p.motivation ? <p className="bc-browse-meta">动机：{String(p.motivation)}</p> : null}
            <CardItemActions item={p} busy={busy} onAction={onAction} />
          </div>
        ))}
      </div>
    );
  } else if (card.browseType === "gacha" && d) {
    // 抽卡卡池：稀有度色标 + 类型标签 + 卡牌信息 + 逐张应用；顶部全部应用（AI 优选）
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    body = (
      <>
        <CardItemActions item={{ actions: card.actions }} busy={busy} onAction={onAction} />
        <div className="bc-gacha-grid">
          {list.map((c) => (
            <div key={String(c.id ?? "")} className={`bc-gacha-card bc-gacha-${String(c.rarity ?? "N").toLowerCase()}`}>
              <div className="bc-gacha-head">
                <span className="bc-gacha-rarity">{String(c.rarity ?? "N")}</span>
                <span className="bc-gacha-type">{String(c.type ?? "")}</span>
              </div>
              <div className="bc-gacha-title">{String(c.title ?? "")}</div>
              {c.description ? <p className="bc-browse-text">{String(c.description)}</p> : null}
              {c.effect ? <p className="bc-gacha-effect">效果：{String(c.effect)}</p> : null}
              {c.dueHint ? <p className="bc-browse-meta">回收时机：{String(c.dueHint)}</p> : null}
              {(c.character as Record<string, unknown> | null) && (
                <p className="bc-browse-meta">
                  人物：{String((c.character as Record<string, unknown>).name)} · {String((c.character as Record<string, unknown>).role)}
                  {((c.character as Record<string, unknown>).traits as unknown[])?.length ? ` · ${((c.character as Record<string, unknown>).traits as unknown[]).map(String).join("/")}` : ""}
                </p>
              )}
              <CardItemActions item={c} busy={busy} onAction={onAction} />
            </div>
          ))}
        </div>
      </>
    );
  } else if (card.browseType === "chapters" && d) {
    // 章节目录：进度条 + 每章（状态徽章/分数/字数/媒体数）
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    body = (
      <>
        <CardProgressBar done={d.done} target={d.target} />
        <div className="bc-browse-list">
          {list.map((c) => (
            <CardListItem
              key={String(c.index ?? "")}
              item={c}
              title={<span className="bc-browse-item-id">第 {String(c.index ?? "")} 章 · {String(c.title ?? "")}</span>}
              meta={<>{String(c.words ?? 0)} 字 · {String(c.media ?? 0)} 媒体</>}
              status={c.status}
              statusLevel={c.status === "需修订" ? "warn" : "ok"}
              score={c.score}
            />
          ))}
        </div>
      </>
    );
  } else if (card.browseType === "characters" && d) {
    // 角色列表：统计网格 + 每角色（定位/身份/状态/出场/立绘）
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    body = (
      <>
        <CardStats stats={d.stats} />
        <div className="bc-browse-list">
          {list.map((c) => (
            <CardListItem
              key={String(c.name ?? "")}
              item={c}
              title={<span className="bc-browse-item-title">「{String(c.name ?? "")}」· {String(c.role ?? "")}</span>}
              meta={<>{[c.gender, c.age, c.identity].filter(Boolean).map(String).join(" · ")}｜出场 {String(c.appeared ?? 0)} 章{c.portrait ? "｜立绘✓" : ""}</>}
              status={c.status}
              statusLevel={c.portrait ? "ok" : "info"}
            />
          ))}
        </div>
      </>
    );
  } else if (card.browseType === "plans" && d) {
    // 计划/章纲：章纲进度条 + 指南针 + 卷 + 弧 + 章纲（next 高亮）
    const volumes = (Array.isArray(d.volumes) ? d.volumes : []) as Record<string, unknown>[];
    const arcs = (Array.isArray(d.arcs) ? d.arcs : []) as Record<string, unknown>[];
    const plans = (Array.isArray(d.plans) ? d.plans : []) as Record<string, unknown>[];
    const next = d.next as Record<string, unknown> | null | undefined;
    body = (
      <>
        <CardProgressBar done={d.done} target={d.target} />
        {d.compass ? <p className="bc-browse-quote">指南针：{String(d.compass)}</p> : null}
        {d.progressContract ? <p className="bc-browse-meta">进度承诺：{String(d.progressContract)}</p> : null}
        {volumes.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">卷</div>
            {volumes.map((v) => (
              <CardListItem
                key={String(v.title ?? "")}
                item={v}
                title={<span className="bc-browse-item-title">{String(v.title ?? "")}</span>}
                meta={v.goal ? <>{String(v.goal)}</> : null}
                status={v.status}
                statusLevel={v.status === "done" ? "ok" : v.status === "writing" ? "warn" : "info"}
              />
            ))}
          </div>
        )}
        {arcs.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">故事弧</div>
            {arcs.map((a) => (
              <CardListItem
                key={String(a.title ?? "")}
                item={a}
                title={<span className="bc-browse-item-title">{String(a.title ?? "")}</span>}
                meta={a.goal ? <>{String(a.goal)}｜约 {String(a.estChapters ?? "?")} 章</> : null}
                status={a.status}
                statusLevel={a.status === "done" ? "ok" : a.status === "writing" || a.status === "expanded" ? "warn" : "info"}
              />
            ))}
          </div>
        )}
        {plans.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">章纲</div>
            {plans.map((p) => (
              <div key={String(p.index ?? "")} className={`bc-browse-item${next && p.index === next.index ? " bc-next" : ""}`}>
                <span className="bc-browse-item-title">第 {String(p.index ?? "")} 章 · {String(p.goal ?? "")}</span>
                <span className="bc-browse-item-badges"><CardStatusBadge status={p.status === "done" ? "完成" : "待写"} level={p.status === "done" ? "ok" : "warn"} /></span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  } else if (card.browseType === "tasks" && d) {
    // 任务中心：统计 + 质量债（内嵌 fix/ignore）+ 重写队列 + 弥合任务
    const debt = (Array.isArray(d.debt) ? d.debt : []) as Record<string, unknown>[];
    const rewriteQueue = (Array.isArray(d.rewriteQueue) ? d.rewriteQueue : []) as number[];
    const mergeTasks = (Array.isArray(d.mergeTasks) ? d.mergeTasks : []) as string[];
    body = (
      <>
        <CardStats stats={{ 质量债: debt.length, 严重: d.major ?? 0, 重写队列: rewriteQueue.length, 弥合任务: mergeTasks.length }} />
        {debt.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">质量债</div>
            {debt.map((t) => (
              <WithItemActions key={String(t.id ?? "")} item={t} busy={busy} onAction={onAction}>
                <div className="bc-browse-item">
                  <div className="bc-browse-item-head">
                    <span className="bc-browse-item-title">第 {String(t.chapterIndex ?? "")} 章 · {String(t.lens ?? "")}</span>
                    <span className="bc-browse-item-badges"><CardStatusBadge status={t.severity === "major" ? "严重" : "轻微"} level={t.severity === "major" ? "danger" : "info"} /></span>
                  </div>
                  <p className="bc-browse-text">{String(t.issue ?? "")}</p>
                </div>
              </WithItemActions>
            ))}
          </div>
        )}
        {rewriteQueue.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">回溯重写队列</div>
            <div className="bc-chip-row">{rewriteQueue.map((i) => <span key={i} className="bc-chip">第 {i} 章</span>)}</div>
            <p className="bc-browse-meta">可通过「重写章节」消费或清空队列</p>
          </div>
        )}
        {mergeTasks.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">弥合任务</div>
            {mergeTasks.map((t, i) => <p key={i} className="bc-browse-text">· {t}</p>)}
          </div>
        )}
        {debt.length === 0 && rewriteQueue.length === 0 && mergeTasks.length === 0 && (
          <p className="bc-browse-text">当前没有待处理任务 🎉</p>
        )}
      </>
    );
  } else if (card.browseType === "logs" && d) {
    // 台账·操作日志：时间 + actor + kind + commandId + detail
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    body = (
      <div className="bc-browse-list">
        {list.map((e, i) => (
          <div key={i} className="bc-browse-item bc-log-item">
            <div className="bc-browse-item-head">
              <span className="bc-browse-item-id">{String(e.kind ?? "")}{e.commandId ? ` · ${String(e.commandId)}` : ""}</span>
              {e.level ? <CardStatusBadge status={e.level} level={e.level === "L3" ? "danger" : e.level === "L2" ? "warn" : "info"} /> : null}
            </div>
            <p className="bc-browse-text">{String(e.detail ?? "")}</p>
            <span className="bc-browse-meta">{String(e.at ?? "")} · {String(e.actor ?? "")}{e.chapter ? ` · 第 ${e.chapter} 章` : ""}</span>
          </div>
        ))}
      </div>
    );
  } else if (card.browseType === "worldbook" && d) {
    // 设定·世界书：setting 摘要 + lore 条目
    const setting = d.setting as Record<string, unknown> | null | undefined;
    const rules = (Array.isArray(setting?.rules) ? setting.rules : []) as string[];
    const lore = (Array.isArray(d.lore) ? d.lore : []) as Record<string, unknown>[];
    body = (
      <>
        {setting && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">设定</div>
            <div className="bc-browse-item">
              <p className="bc-browse-text">时代 {String(setting.time ?? "—")}｜地点 {String(setting.place ?? "—")}｜基调 {String(setting.tone ?? "—")}</p>
              {rules.length > 0 && <div className="bc-chip-row">{rules.map((r, i) => <span key={i} className="bc-chip">{r}</span>)}</div>}
            </div>
          </div>
        )}
        {lore.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">世界书（{lore.length} 条）</div>
            {lore.map((l, i) => (
              <div key={i} className="bc-browse-item">
                <div className="bc-browse-item-head">
                  <span className="bc-browse-item-title">{String((l.keywords as string[] | undefined)?.join("、") ?? "")}</span>
                  <CardStatusBadge status={l.enabled === false ? "关闭" : "启用"} level={l.enabled === false ? "info" : "ok"} />
                </div>
                <p className="bc-browse-text">{String(l.content ?? "")}</p>
              </div>
            ))}
          </div>
        )}
      </>
    );
  } else if (card.browseType === "media" && d) {
    // 媒体资源：统计 + 列表（类型/章节/图注/状态）
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    body = (
      <>
        <CardStats stats={{ 插画: d.stats ? (d.stats as Record<string, unknown>).images ?? 0 : 0, 视频: d.stats ? (d.stats as Record<string, unknown>).videos ?? 0 : 0, 角色立绘: d.stats ? (d.stats as Record<string, unknown>).characters ?? 0 : 0 }} />
        <div className="bc-browse-list">
          {list.map((m, i) => (
            <div key={i} className="bc-browse-item">
              <div className="bc-browse-item-head">
                <span className="bc-browse-item-title">{m.kind === "video" ? "🎬" : "🖼"} 第 {String(m.chapter ?? "")} 章{m.caption ? ` · ${String(m.caption)}` : ""}</span>
                <CardStatusBadge status={m.status === "ready" ? "就绪" : m.status === "pending" ? "生成中" : "失败"} level={m.status === "ready" ? "ok" : m.status === "pending" ? "warn" : "danger"} />
              </div>
            </div>
          ))}
        </div>
      </>
    );
  } else if (card.browseType === "review" && d) {
    // 审查报告：verdict + 5 维分数 + findings
    const scores = d.scores as Record<string, unknown> | null | undefined;
    const findings = (Array.isArray(d.findings) ? d.findings : []) as Record<string, unknown>[];
    body = (
      <>
        <CardStatusBadge status={d.verdict === "pass" ? "通过" : "需修订"} level={d.verdict === "pass" ? "ok" : "warn"} />
        {scores && (
          <div className="bc-stats">
            {Object.entries(scores).map(([k, v]) => (
              <span className="bc-stat" key={k}><b>{String(v)}</b>{k}</span>
            ))}
          </div>
        )}
        {findings.length > 0 && (
          <div className="bc-browse-list">
            {findings.map((f, i) => (
              <div key={i} className="bc-browse-item">
                <div className="bc-browse-item-head">
                  <span className="bc-browse-item-title">{String(f.lens ?? "")}</span>
                  <CardStatusBadge status={f.severity === "major" ? "严重" : "轻微"} level={f.severity === "major" ? "danger" : "info"} />
                </div>
                <p className="bc-browse-text">{String(f.issue ?? "")}</p>
                {f.suggestion ? <p className="bc-browse-meta">建议：{String(f.suggestion)}</p> : null}
              </div>
            ))}
          </div>
        )}
      </>
    );
  } else if (card.browseType === "eval" && d) {
    body = <p className="bc-browse-text">整书评估 overall: {String(d.overall ?? "")}</p>;
  } else {
    body = <p className="bc-browse-text">{JSON.stringify(d ?? {}).slice(0, 300)}</p>;
  }
  return (
    <div className="brain-card brain-card-browse">
      <div className="brain-card-head"><span className="brain-card-title">{card.title}</span></div>
      {body}
    </div>
  );
};

// ============ ChoiceCard 计划/意见选项卡（plan/opinion 共用） ============

export const ChoiceCardView: React.FC<{
  card: ChoiceCard;
  onOption?: (option: ChoiceOption) => void;
  busy?: boolean;
}> = ({ card, onOption, busy }) => (
  <div className={`brain-card brain-card-choice brain-card-${card.kind}`}>
    <div className="brain-card-head">
      <span className="brain-card-title">{card.kind === "plan" ? "🗺 " : "💬 "}{card.title}</span>
      {card.kind === "opinion" && <span className="bc-confirm-tag">请选择</span>}
    </div>
    {card.summary && <p className="brain-card-body">{card.summary}</p>}
    <div className="bc-choice-options">
      {card.options.map((o, i) => (
        <button
          key={i}
          className="bc-choice-option"
          disabled={busy}
          onClick={() => onOption?.(o)}
          title={o.description ?? o.label}
        >
          <span className="bc-choice-label">{o.label}</span>
          {o.description && <span className="bc-choice-desc">{o.description}</span>}
          {o.action && <span className="bc-choice-go">→</span>}
        </button>
      ))}
    </div>
  </div>
);

// ============ 卡片分发器 ============

/** 卡片附图：渲染在卡片内容上方（data URI / URL 均可） */
function CardFigure({ image }: { image?: CardImage }) {
  if (!image?.src) return null;
  return <img className="brain-card-image" src={image.src} alt={image.alt ?? ""} loading="lazy" />;
}

// ============ 表单卡（FormCard）：结构化字段 → 填写 → 提交 ============

export const FormCardView: React.FC<{
  card: FormCard;
  onSubmit?: (card: FormCard, values: Record<string, unknown>) => void;
  busy?: boolean;
}> = ({ card, onSubmit, busy }) => {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of card.fields ?? []) init[f.key] = f.value ?? (f.type === "number" ? "" : f.type === "multiselect" ? [] : "");
    return init;
  });
  const set = (key: string, v: unknown) => setValues((prev) => ({ ...prev, [key]: v }));

  const submit = () => {
    // required 校验：空字符串 / null 视为未填
    const missing = (card.fields ?? []).find((f) => f.required && (values[f.key] == null || String(values[f.key]).trim() === ""));
    if (missing) {
      const el = document.getElementById(`fld-${card.title}-${missing.key}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus();
      return;
    }
    onSubmit?.(card, values);
  };

  return (
    <div className={`brain-card brain-card-form${card.confirmRequired ? " bc-form-confirm" : ""}`}>
      <div className="brain-card-head">
        <span className="brain-card-title">{card.title}</span>
        <CommandBadge commandId={card.commandId} />
        <LevelBadge level={card.level} />
        {card.confirmRequired && <span className="bc-confirm-tag">需确认</span>}
      </div>
      {card.summary && <p className="brain-card-body">{card.summary}</p>}
      {(card.fields ?? []).length === 0 ? (
        <p className="bc-browse-meta">无需填写字段，直接提交执行。</p>
      ) : (
        <div className="bc-form-fields">
          {(card.fields ?? []).map((f) => {
            const id = `fld-${card.title}-${f.key}`;
            return (
              <label className="bc-form-field" key={f.key} htmlFor={id}>
                <span className="bc-form-label">{f.label}{f.required ? " *" : ""}</span>
                {f.type === "textarea" ? (
                  <textarea
                    id={id} rows={2} className="bc-form-input" placeholder={f.placeholder}
                    value={String(values[f.key] ?? "")}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                ) : f.type === "select" ? (
                  <select id={id} className="bc-form-input" value={String(values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                    {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.type === "multiselect" ? (
                  <div className="bc-form-checkgroup" id={id}>
                    {(f.options ?? []).map((o) => {
                      const arr = Array.isArray(values[f.key]) ? (values[f.key] as string[]) : [];
                      const checked = arr.includes(o.value);
                      return (
                        <label className="bc-form-check" key={o.value}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const next = e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value);
                              set(f.key, next);
                            }}
                          />
                          {o.label}
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <input
                    id={id} type={f.type === "number" ? "number" : "text"} className="bc-form-input" placeholder={f.placeholder}
                    value={String(values[f.key] ?? "")}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
              </label>
            );
          })}
        </div>
      )}
      <div className="brain-card-actions">
        {onSubmit && (
          <button className="btn-save btn-xs" disabled={busy} onClick={submit}>
            {card.submitLabel ?? "提交"}
          </button>
        )}
      </div>
    </div>
  );
};

export const BrainCardView: React.FC<{
  card: BrainCard;
  onExecute?: (card: BrainCard, action?: BrowseCardAction["action"]) => void;
  onConfirmChoose?: (opt: "merge" | "rewrite" | "abort") => void;
  onOption?: (option: ChoiceOption) => void;
  onFormSubmit?: (card: FormCard, values: Record<string, unknown>) => void;
  busy?: boolean;
}> = ({ card, onExecute, onConfirmChoose, onOption, onFormSubmit, busy }) => {
  const inner = (() => {
    switch (card.kind) {
      case "preview": return <PreviewCardView card={card} onExecute={onExecute ? () => onExecute(card) : undefined} busy={busy} />;
      case "confirm": return <ConfirmCardView card={card} onChoose={onConfirmChoose} busy={busy} />;
      case "result": return <ResultCardView card={card} />;
      case "browse": return <BrowseCardView card={card} onAction={onExecute ? (action) => onExecute(card, action) : undefined} busy={busy} />;
      case "plan":
      case "opinion": return <ChoiceCardView card={card} onOption={onOption} busy={busy} />;
      case "form": return <FormCardView card={card} onSubmit={onFormSubmit} busy={busy} />;
    }
  })();
  const image = (card as { image?: CardImage }).image;
  if (!image?.src) return inner;
  return (
    <>
      <div className="brain-card-image-wrap"><CardFigure image={image} /></div>
      {inner}
    </>
  );
};
