// 抽卡弹层：候选卡池 → 选择/自动抽取 → 应用
import { useState } from "react";
import { Dices, RefreshCw, X } from "../components/icons";
import type { Card, WorldState } from "../api/world";

type Props = {
  world: WorldState;
  onClose: () => void;
  onApplied: (instructions: string[], applied: Card[]) => void;
};

const CARD_TYPES = ["角色", "发展方向", "伏笔", "章节", "道具", "场景"] as const;
const RARITY_COLORS: Record<string, string> = { N: "#888", R: "#4a6fa5", SR: "#a67c2e", SSR: "#b03a2e" };

export const GachaModal: React.FC<Props> = (p) => {
  const [pool, setPool] = useState<Card[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Set<string>>(new Set(CARD_TYPES));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [appliedCards, setAppliedCards] = useState<Card[] | null>(null);
  const [count, setCount] = useState(5);

  function toggleType(t: string) {
    const s = new Set(types);
    s.has(t) ? s.delete(t) : s.add(t);
    if (s.size === 0) s.add(t);
    setTypes(s);
  }

  async function generate() {
    setBusy(true);
    setMsg("抽卡系统生成卡池中…");
    setAppliedCards(null);
    try {
      const res = await fetch("/api/novel/gacha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", title: p.world.title, count, types: [...types] }),
      });
      const data = (await res.json()) as { pool?: Card[]; error?: string };
      if (data.error) throw new Error(data.error);
      const cards = data.pool ?? [];
      if (!cards.length) throw new Error("卡池生成结果为空，请重试");
      setPool(cards);
      setPicked(new Set<string>());
      setRevealed(new Set<string>());
      cards.forEach((c, i) =>
        setTimeout(() => {
          setRevealed((prev) => {
            const s = new Set(prev);
            s.add(c.id);
            return s;
          });
        }, 350 + i * 280),
      );
      setMsg(`已生成 ${cards.length} 张候选卡，请选择要应用的卡（可多选）`);
    } catch (e) {
      setMsg("失败: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    const s = new Set<string>(picked);
    s.has(id) ? s.delete(id) : s.add(id);
    setPicked(s);
  }

  function selectAll() {
    if (!pool) return;
    const allRevealed = pool.filter((c) => revealed.has(c.id));
    if (picked.size === allRevealed.length) {
      setPicked(new Set<string>());
    } else {
      setPicked(new Set(allRevealed.map((c) => c.id)));
    }
  }

  async function apply(auto: boolean) {
    setBusy(true);
    setMsg(auto ? "自动抽取中（AI 优先稀有度与伏笔/人物卡）…" : "应用所选卡牌…");
    try {
      const res = await fetch("/api/novel/gacha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          title: p.world.title,
          auto,
          pick: auto ? undefined : [...picked],
        }),
      });
      const data = (await res.json()) as { applied?: Card[]; instructions?: string[]; error?: string };
      if (data.error) throw new Error(data.error);
      const applied = data.applied ?? [];
      if (!applied.length) throw new Error("未成功应用任何卡牌（可能已被抽取过）");
      setAppliedCards(applied);
      setMsg(`✅ 已应用 ${applied.length} 张卡，指令已注入下一章写作`);
      p.onApplied(data.instructions ?? [], applied);
      setTimeout(() => p.onClose(), 1800);
    } catch (e) {
      setMsg("失败: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onClick={p.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "820px" }}>
        <div className="modal-head">
          <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}><Dices size={15} /> 抽 卡</b>
          <button className="modal-close" onClick={p.onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">

        {/* 应用成功展示 */}
        {appliedCards && (
          <div style={{ textAlign: "center", padding: "1rem", marginBottom: "0.8rem", background: "rgba(77,122,77,0.06)", border: "1px solid rgba(77,122,77,0.3)", borderRadius: "var(--radius)" }}>
            <div style={{ fontSize: "1.2rem", marginBottom: "0.4rem" }}>🎉</div>
            <div style={{ fontFamily: "var(--sans)", fontSize: "0.85rem", fontWeight: "700" }}>
              抽取成功！
            </div>
            <div style={{ fontSize: "0.8rem", marginTop: "0.3rem" }}>
              {appliedCards.map((c) => (
                <span key={c.id} style={{ display: "inline-block", margin: "0.2em 0.4em", padding: "0.15em 0.6em", border: `1px solid ${RARITY_COLORS[c.rarity] ?? "#888"}`, borderRadius: "var(--radius)", fontSize: "0.75rem" }}>
                  <b style={{ color: RARITY_COLORS[c.rarity] ?? "#888" }}>{c.rarity}</b> {c.title}
                </span>
              ))}
            </div>
          </div>
        )}

        {pool && !appliedCards ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
              <span style={{ fontFamily: "var(--sans)", fontSize: "0.78rem", color: "var(--ink-soft)" }}>
                已选 {picked.size} / {pool.length} 张
              </span>
              <button className="btn-save" onClick={selectAll} disabled={busy}>
                {picked.size === pool.length ? "取消全选" : "全选"}
              </button>
            </div>
            <div className="card-grid">
              {pool.map((c) => (
                <div
                  key={c.id}
                  className={`card rarity-${c.rarity} ${picked.has(c.id) ? "selected" : ""} ${revealed.has(c.id) ? "revealed-card" : ""}`}
                  onClick={() => revealed.has(c.id) && !busy && toggle(c.id)}
                >
                  {picked.has(c.id) && (
                    <div className="card-pick-badge">✓</div>
                  )}
                  <div className="card-scene">
                    <div className={`card-flip ${revealed.has(c.id) ? "revealed" : ""}`}>
                      <div className="card-face front">
                        <div className="card-back-art" />
                      </div>
                      <div className="card-face back">
                        <span className={`card-rarity ${c.rarity}`}>{c.rarity}</span>
                        <div className="card-title">{c.title}</div>
                        <div className="card-desc">{c.description}</div>
                        <span className="card-type">{c.type}</span>
                        <div className="card-glow" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="gacha-actions">
              <button className="btn" onClick={() => { setPicked(new Set<string>()); setPool(null); setRevealed(new Set<string>()); setMsg(""); }} disabled={busy}>
                <RefreshCw size={14} /> 重新生成
              </button>
              <button className="btn" onClick={() => apply(false)} disabled={busy || picked.size === 0}>
                抽取所选（{picked.size}）
              </button>
              <button className="btn btn-primary" onClick={() => apply(true)} disabled={busy}>
                <Dices size={15} /> 自动抽取
              </button>
            </div>
          </>
        ) : (
          !appliedCards && (
            <div style={{ textAlign: "center", padding: "1.5rem" }}>
              <div style={{ fontSize: "2.5rem", marginBottom: "0.8rem", opacity: "0.6" }}><Dices size={44} color="var(--ink-soft)" /></div>
              <p style={{ fontFamily: "var(--sans)", fontSize: "0.85rem", color: "var(--ink-soft)", marginBottom: "1rem" }}>
                抽卡系统将根据当前世界状态生成候选卡。选择卡池类型和数量后生成：
              </p>
              <div className="gacha-type-filters">
                {CARD_TYPES.map((t) => (
                  <label className={`gacha-type-chip ${types.has(t) ? "active" : ""}`} key={t}>
                    <input type="checkbox" checked={types.has(t)} onChange={() => toggleType(t)} /> {t}
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", justifyContent: "center", marginTop: "1rem" }}>
                <span style={{ fontFamily: "var(--sans)", fontSize: "0.78rem" }}>卡池数量：</span>
                {[3, 4, 5, 6].map((n) => (
                  <button className={`panel-tab ${count === n ? "active" : ""}`} onClick={() => setCount(n)} key={n}>{n} 张</button>
                ))}
              </div>
              <button className="btn btn-primary" onClick={generate} disabled={busy} style={{ marginTop: "1rem" }}>
                {busy ? (
                  <><span className="loading-spinner" style={{ width: "14px", height: "14px", borderWidth: "2px", display: "inline-block", verticalAlign: "middle", marginRight: "0.4em" }} /> 生成中…</>
                ) : (
                  <><Dices size={15} /> 生成卡池</>
                )}
              </button>
            </div>
          )
        )}
        {msg && (
          <div className="busy-line" style={{ animation: "none" }}>{msg}</div>
        )}
        </div>
      </div>
    </div>
  );
};
