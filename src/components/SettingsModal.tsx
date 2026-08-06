// ⚙️ 设置面板：小说级 / 章节级设定统一管控
// Tab：全局生成参数 / 章节覆盖 / 设定（基础·自定义）/ 角色 / 大纲 / 导出
import { useState } from "react";
import { BookMarked, FileText, Settings, Upload, Wand2, X, Sparkles } from "../components/icons";
import { DEFAULT_GEN, type Character, type FidelityRule, type GenProfile, type LoreEntry, type WorldState, type WorldPatch } from "../api/world";
import { RangeSlider } from "./RangeSlider";
import { IntegrityModal, type IntegrityReportView } from "./IntegrityModal";

type Tab = "全局" | "章节" | "设定" | "角色" | "大纲" | "导出";

const TABS: Tab[] = ["全局", "章节", "设定", "角色", "大纲", "导出"];

type Props = {
  world: WorldState;
  onSave: (patch: WorldPatch) => Promise<boolean>;
  onImage: (kind: "cover" | "character" | "chapter", args?: Record<string, unknown>) => Promise<{ path?: string } | null>;
  onToggleLock?: (characterId: string, field: string, locked: boolean) => Promise<boolean>;
  onLore: (action: "auto" | "save", entries?: LoreEntry[]) => Promise<LoreEntry[] | null>;
  onGenerateOutline: (hint?: string) => Promise<string[] | null>;
  outlineBusy: boolean;
  onExport: (format?: "epub") => void;
  /** 查看/生成角色全局立绘（大图预览） */
  onViewPortrait?: (c: Character) => void;
  /** 世界整体更新（删章等结构变更后同步父级状态） */
  onWorldUpdate?: (w: WorldState) => void;
  /** 运行锁：任务运行中禁止一切编辑（删章/风格/删角色等直接 fetch 入口） */
  taskActive?: boolean;
  onClose: () => void;
};

const radio = (name: string, opts: string[], cur: string, set: (v: never) => void) => (
  <div className="radio-group">
    {opts.map((o) => (
      <label className={`radio-chip ${cur === o ? "active" : ""}`} key={o}>
        <input type="radio" name={name} checked={cur === o} onChange={() => set(o as never)} /> {o}
      </label>
    ))}
  </div>
);

export const SettingsModal: React.FC<Props> = (p) => {
  const [tab, setTab] = useState<Tab>("全局");

  return (
    <div className="modal-mask" onClick={p.onClose}>
      <div className="modal modal-settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}><Settings size={14} /> 小说设置</b>
          <button className="modal-close" onClick={p.onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="settings-tabs">
          {TABS.map((t) => (
            <button className={`panel-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)} key={t}>
              {t === "全局" ? "全局设置" : t === "章节" ? "章节设置" : t}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {tab === "全局" && <GlobalSettings world={p.world} onSave={p.onSave} onImage={p.onImage} taskActive={p.taskActive} />}
          {tab === "章节" && <ChapterSettings world={p.world} onSave={p.onSave} onWorldUpdate={p.onWorldUpdate} taskActive={p.taskActive} />}
          {tab === "设定" && <SettingPanel world={p.world} onSave={p.onSave} onLore={p.onLore} />}
          {tab === "角色" && <CharacterEditor world={p.world} onSave={p.onSave} onImage={p.onImage} onToggleLock={p.onToggleLock} onViewPortrait={p.onViewPortrait} taskActive={p.taskActive} />}
          {tab === "大纲" && <OutlineEditor world={p.world} onSave={p.onSave} onGenerate={p.onGenerateOutline} busy={p.outlineBusy} />}
          {tab === "导出" && <ExportTab onExport={p.onExport} />}
        </div>
      </div>
    </div>
  );
};

// —— 全局设置 ——
const GlobalSettings: React.FC<{ world: WorldState; onSave: Props["onSave"]; onImage: Props["onImage"]; taskActive?: boolean }> = (p) => {
  const g = { ...DEFAULT_GEN, ...p.world.gen };
  const [bookTitle, setBookTitle] = useState(p.world.title);
  const [author, setAuthor] = useState(p.world.author ?? "");
  const [current, setCurrent] = useState(p.world.current ?? "");
  const [minWords, setMinWords] = useState(String(g.minWords));
  const [maxWords, setMaxWords] = useState(String(g.maxWords));
  const [mode, setMode] = useState<GenProfile["settingMode"]>(g.settingMode);
  const [pov, setPov] = useState<GenProfile["pov"]>(g.pov);
  const [temp, setTemp] = useState(String(g.temperature));
  const [strict, setStrict] = useState<GenProfile["reviewStrictness"]>(g.reviewStrictness);
  const [maxFs, setMaxFs] = useState(String(g.maxForeshadowPerChapter));
  const [hook, setHook] = useState(g.forceHook);
  const [auto, setAuto] = useState(g.autoGacha);
  const [confirmCommit, setConfirmCommit] = useState((g.commitPolicy ?? "auto") === "confirm"); // 推进剧情完成策略：人工确认 commit
  const [rules, setRules] = useState<FidelityRule[]>([...(g.fidelityRules ?? [])]);
  const [msg, setMsg] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  // P5 风格仿写：样章 → 指纹提取
  const [styleSample, setStyleSample] = useState("");
  const [styleBusy, setStyleBusy] = useState(false);

  function setRule(i: number, patch: Partial<FidelityRule>) {
    setRules((arr) => arr.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRule() {
    setRules((arr) => [...arr, { content: "", follow: "架空" }]);
  }
  function removeRule(i: number) {
    setRules((arr) => arr.filter((_, idx) => idx !== i));
  }

  async function save() {
    if (!bookTitle.trim()) {
      setMsg("书名不能为空");
      return;
    }
    const ok = await p.onSave({
      bookTitle: bookTitle.trim() !== p.world.title ? bookTitle.trim() : undefined,
      author: author !== (p.world.author ?? "") ? author : undefined,
      current: current.trim() !== (p.world.current ?? "") ? current.trim() : undefined,
      gen: {
        minWords: Number(minWords) || DEFAULT_GEN.minWords,
        maxWords: Number(maxWords) || DEFAULT_GEN.maxWords,
        settingMode: mode,
        pov: pov,
        temperature: Number(temp) || DEFAULT_GEN.temperature,
        reviewStrictness: strict,
        maxForeshadowPerChapter: Number(maxFs) || DEFAULT_GEN.maxForeshadowPerChapter,
        forceHook: hook,
        autoGacha: auto,
        commitPolicy: confirmCommit ? "confirm" : "auto",
        fidelityRules: rules.filter((r) => r.content.trim()),
      },
    });
    setMsg(ok ? "已保存，下一章生效" : "保存失败");
  }

  return (
    <div className="settings-tab-root">
      <div className="settings-page">
      <div className="field">
        <label>书名</label>
        <input value={bookTitle} onChange={(e) => setBookTitle(e.target.value)} placeholder="书名" />
        <div className="rules-hint">修改书名后存档目录会同步改名，媒体/版本历史不受影响</div>
      </div>
      <div className="field">
        <label>作者</label>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="作者署名（可空）" />
      </div>
      <div className="field">
        <label>当前全局状态（季节/天气/局势等，AI 每章结算自动更新）</label>
        <textarea
          rows={2}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="如：隆冬腊月，大雪封城，京师戒严，沈夜重伤下落不明"
        />
        <div className="rules-hint">不填则沿用 AI 结算的上一章状态</div>
      </div>
      <div className="field">
        <label>章节字数范围</label>
        <RangeSlider
          min={100}
          max={20000}
          value={[Number(minWords) || 800, Number(maxWords) || 1600]}
          unit=" 字"
          onChange={(v) => {
            setMinWords(String(v[0]));
            setMaxWords(String(v[1]));
          }}
        />
      </div>
      <div className="field">
        <label>设定遵循模式</label>
        {radio("mode", ["历史真实", "架空", "混合"], mode, setMode as never)}
        <div className="rules-hint">历史真实：自动考据史实；具体条目在下方细则中逐条指定</div>
      </div>
      <div className="field">
        <label>遵循设定细则（逐条指定：该内容遵循史实还是架空处理）</label>
        {rules.map((r, i) => (
          <div style={{ display: "flex", gap: "0.3rem", marginBottom: "0.3rem" }} key={i}>
            <input
              placeholder="如：官职体系 / 武功内力 / 科举制度…"
              value={r.content}
              onChange={(e) => setRule(i, { content: e.target.value })}
            />
            <select value={r.follow} onChange={(e) => setRule(i, { follow: e.target.value === "史实" ? "史实" : "架空" })}>
              <option value="史实">遵循史实</option>
              <option value="架空">架空处理</option>
            </select>
            <button className="btn-save" style={{ marginTop: "0" }} onClick={() => removeRule(i)}>
              删
            </button>
          </div>
        ))}
        <button className="btn" onClick={addRule}>＋ 添加条目</button>
      </div>
      <div className="field">
        <label>叙述视角</label>
        {radio("pov", ["第一人称", "第三人称", "第二人称"], pov, setPov as never)}
      </div>
      <div className="field">
        <label>模型温度（0-2）</label>
        <input type="number" min={0} max={2} step={0.1} value={temp} onChange={(e) => setTemp(e.target.value)} />
      </div>
      <div className="field">
        <label>审查严格度</label>
        {radio("strict", ["宽松", "标准", "严格"], strict, setStrict as never)}
        <div className="rules-hint">宽松：地板 4 分/重写 1 次；标准：6/2 次；严格：7/3 次</div>
      </div>
      <div className="field">
        <label>每章新伏笔上限（0-4）</label>
        <input type="number" min={0} max={4} value={maxFs} onChange={(e) => setMaxFs(e.target.value)} />
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={hook} onChange={(e) => setHook(e.target.checked)} /> 强制章节结尾钩子
        </label>
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 每章推进前自动抽卡
        </label>
      </div>
      <div className="field">
        <label title="开启后：推进剧情审查通过的章节先进暂存区，由你确认后才作为新版本入册（连载不受影响，始终自动入册）">
          <input type="checkbox" checked={confirmCommit} onChange={(e) => setConfirmCommit(e.target.checked)} /> 推进剧情需人工确认后入册（关闭 = 审查通过直接作为新版本提交）
        </label>
      </div>
      <div className="field">
        <label>风格仿写（可选：贴入喜欢的样章，提取风格指纹后全书遵循）</label>
        {g.styleFingerprint && (
          <div className="rules-hint" style={{ marginBottom: "0.4rem", color: "var(--seal)" }}>✓ 已生效指纹：{g.styleFingerprint.slice(0, 120)}…</div>
        )}
        <textarea
          placeholder="贴入 100 字以上的样章（你喜欢的外部作品或自己的旧作），提取后注入后续全部写作…"
          value={styleSample}
          onChange={(e) => setStyleSample(e.target.value)}
        />
        <button
          className="btn"
          disabled={styleBusy || styleSample.trim().length < 100 || p.taskActive}
          title={p.taskActive ? "任务运行中已禁止（风格仿写属编辑类）" : undefined}
          onClick={async () => {
            if (p.taskActive) { setMsg("任务运行中，风格仿写已禁止——请先取消任务。"); return; }
            setStyleBusy(true);
            setMsg("风格指纹提取中…");
            try {
              const res = await fetch("/api/novel/style", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: p.world.title, sample: styleSample.trim() }),
              });
              const data = (await res.json()) as { ok?: boolean; fingerprint?: string; error?: string };
              if (!data.ok || !data.fingerprint) throw new Error(data.error ?? "提取失败");
              setMsg("风格指纹已生效，后续写作将遵循。");
              setStyleSample("");
            } catch (e) {
              setMsg("提取失败: " + (e as Error).message);
            } finally {
              setStyleBusy(false);
            }
          }}
        >
          {styleBusy ? "提取中…" : "提取风格指纹"}
        </button>
      </div>
      <div className="field">
        <label>书籍封面</label>
        {p.world.cover && (
          <img
            src={`/api/novel/asset?title=${encodeURIComponent(p.world.title)}&path=${encodeURIComponent(p.world.cover)}`}
            alt="封面"
            style={{ width: "120px", border: "1px solid var(--line-strong)", marginBottom: "0.4rem", display: "block", aspectRatio: "768 / 1086", background: "var(--paper-dark)", objectFit: "cover" }}
          />
        )}
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <button
            className="btn"
            disabled={imgBusy}
            onClick={async () => {
              // 防连点：生成期间禁用（全局 busy 遮罩由 Home.imageAction 统一管理）
              setImgBusy(true);
              setMsg("封面生成中…");
              try {
                const r = await p.onImage("cover");
                setMsg(r?.path ? "封面已生成" : "封面生成失败（请检查本地 z-image-turbo 服务）");
              } finally {
                setImgBusy(false);
              }
            }}
          >
            <Wand2 size={13} /> {imgBusy ? "生成中…" : "AI 生成封面"}
          </button>
          <label className="btn" style={{ cursor: imgBusy ? "not-allowed" : "pointer", opacity: imgBusy ? "0.45" : "1" }} onClick={(e) => { if (imgBusy) e.preventDefault(); }}>
            <Upload size={13} /> 上传封面
            <input
              type="file"
              accept="image/png,image/jpeg"
              hidden
              disabled={imgBusy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async () => {
                  setImgBusy(true);
                  setMsg("上传中…");
                  try {
                    const r = await p.onImage("cover", { dataUrl: String(reader.result) });
                    setMsg(r?.path ? "封面已上传" : "上传失败");
                  } finally {
                    setImgBusy(false);
                  }
                };
                reader.readAsDataURL(file);
              }}
            />
          </label>
        </div>
      </div>
      </div>
      <div className="settings-footer">
        <button className="btn btn-primary" onClick={save}>保存全局设置</button>
        {msg && <div className="form-msg">{msg}</div>}
      </div>
    </div>
  );
};

// —— 章节级设置（覆盖全局） ——
const ChapterSettings: React.FC<{ world: WorldState; onSave: Props["onSave"]; onWorldUpdate?: (w: WorldState) => void; taskActive?: boolean }> = (p) => {
  const chapters = p.world.chapters;
  const [sel, setSel] = useState<number>(chapters[chapters.length - 1]?.index ?? 1);
  const current = p.world.chapterGen?.[sel] ?? {};
  const [titleDraft, setTitleDraft] = useState<string>(() => chapters.find((c) => c.index === (chapters[chapters.length - 1]?.index ?? 1))?.title ?? "");
  const [words, setWords] = useState<[number, number]>([
    current.minWords ?? 0,
    current.maxWords ?? 0,
  ]);
  const [strict, setStrict] = useState<string>(current.reviewStrictness ?? "");
  const [pov, setPov] = useState<string>(current.pov ?? "");
  const [hook, setHook] = useState<string>(current.forceHook == null ? "" : String(current.forceHook));
  const [msg, setMsg] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  // 删章两阶段：delState 非空 → 影响评估弹窗（二次确认）
  const [delState, setDelState] = useState<{ index: number; title: string; report: IntegrityReportView; busy: boolean } | null>(null);

  function pick(i: number) {
    setSel(i);
    const c = p.world.chapterGen?.[i] ?? {};
    setTitleDraft(p.world.chapters.find((x) => x.index === i)?.title ?? "");
    setWords([c.minWords ?? 0, c.maxWords ?? 0]);
    setStrict(c.reviewStrictness ?? "");
    setPov(c.pov ?? "");
    setHook(c.forceHook == null ? "" : String(c.forceHook));
  }

  async function save() {
    const cur = p.world.chapterGen?.[sel] ?? {}; // 该章节已有覆盖
    // 仅发送变化字段：归零/置空且原覆盖存在 → null（per-key 删除）；否则 undefined（不发送）
    const patch: WorldPatch = {
      chapterGen: {
        // null 为 per-key 删除语义，与 Partial<GenProfile> 类型不兼容，整体断言透传
        [sel]: {
          minWords: words[0] === 0 ? (cur.minWords != null ? null : undefined) : words[0],
          maxWords: words[1] === 0 ? (cur.maxWords != null ? null : undefined) : words[1],
          reviewStrictness: strict === "" ? (cur.reviewStrictness ? null : undefined) : strict,
          pov: pov === "" ? (cur.pov ? null : undefined) : pov,
          forceHook: hook === "" ? (cur.forceHook != null ? null : undefined) : hook === "true",
        } as never,
      },
    };
    // 章节标题修改：标题变化时随补丁一起提交（服务端留版本快照）
    const ch = p.world.chapters.find((c) => c.index === sel);
    const t = titleDraft.trim();
    if (ch && t && t !== ch.title) patch.chapterTitle = [{ index: sel, title: t }];
    const ok = await p.onSave(patch);
    setMsg(ok ? "章节设置已保存（滑杆归零 = 跟随全局）" : "保存失败");
  }

  async function clearOverride() {
    const ok = await p.onSave({ chapterGen: { [sel]: null } });
    setMsg(ok ? "已清除该章节覆盖" : "操作失败");
  }

  /** 删章第一步：影响预览（确定性危险项 + 删中间章时服务端附带 LLM 冲突评估） */
  async function requestDeleteChapter(index: number) {
    if (p.taskActive) { setMsg("任务运行中，删章已禁止——请先取消任务。"); return; } // 运行锁
    const c = p.world.chapters.find((x) => x.index === index);
    if (!c) return;
    setDelState({ index, title: c.title, report: { autoFixed: [], findings: [], orphanMedia: [] }, busy: true });
    try {
      const res = await fetch("/api/novel/chapter/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: p.world.title, chapterIndex: index }),
      });
      const data = (await res.json()) as { ok?: boolean; report?: IntegrityReportView; error?: string };
      if (!data.ok || !data.report) throw new Error(data.error ?? "评估失败");
      setDelState({ index, title: c.title, report: data.report, busy: false });
    } catch (e) {
      setDelState(null);
      setMsg("删章评估失败: " + (e as Error).message);
    }
  }

  /** 删章第二步：二次确认后级联删除（允许空洞不重排章号），成功后同步父级世界 */
  async function confirmDeleteChapter() {
    if (!delState) return;
    if (p.taskActive) { setMsg("任务运行中，删章已禁止——请先取消任务。"); return; } // 运行锁
    const { index } = delState;
    setDelState({ ...delState, busy: true });
    try {
      const res = await fetch("/api/novel/chapter/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: p.world.title, chapterIndex: index, strategy: "merge" }),
      });
      const data = (await res.json()) as { ok?: boolean; world?: WorldState; error?: string };
      if (!data.ok || !data.world) throw new Error(data.error ?? "删除失败");
      p.onWorldUpdate?.(data.world);
      setDelState(null);
      setMsg(`第 ${index} 章已删除`);
      // 选中后续章节（删除后章号可能空号，取剩余最后一章）
      const rest = data.world.chapters;
      const next = rest[rest.length - 1];
      if (next) {
        setSel(next.index);
        const c = data.world.chapterGen?.[next.index] ?? {};
        setTitleDraft(next.title);
        setWords([c.minWords ?? 0, c.maxWords ?? 0]);
        setStrict(c.reviewStrictness ?? "");
        setPov(c.pov ?? "");
        setHook(c.forceHook == null ? "" : String(c.forceHook));
      }
    } catch (e) {
      setMsg("删除章节失败: " + (e as Error).message);
      setDelState((d) => (d ? { ...d, busy: false } : d));
    }
  }

  return (
    <div className="settings-tab-root">
      <div className="chapter-settings">
      <div className="chapter-list">
        {chapters.map((c) => (
          <div className={`chapter-list-item ${sel === c.index ? "active" : ""}`} role="button" onClick={() => pick(c.index)} key={c.index}>
            <span className="chapter-item-title">第 {c.index} 章 {c.title}</span>
            <button
              className="chapter-del-btn"
              title={p.taskActive ? "任务运行中已禁止删章" : "删除本章（需二次确认）"}
              disabled={p.taskActive}
              onClick={(e) => { e.stopPropagation(); requestDeleteChapter(c.index); }}
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
      <div className="settings-right">
        <div className="settings-page">
        <div className="rules-hint" style={{ marginBottom: "0.5rem" }}>滑杆归零 / 留空 = 跟随全局</div>
        <div className="field">
          <label>章节标题</label>
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="章节标题（修改后同步版本历史，可回滚）"
            maxLength={60}
          />
        </div>
        <div className="field">
          <label>字数范围（差异化覆盖）</label>
          <RangeSlider
            min={0}
            max={20000}
            value={words}
            unit=" 字"
            onChange={(v) => setWords(v)}
          />
        </div>
        <div className="field">
          <label>审查严格度</label>
          <select value={strict} onChange={(e) => setStrict(e.target.value)}>
            <option value="">跟随全局</option>
            <option value="宽松">宽松</option>
            <option value="标准">标准</option>
            <option value="严格">严格</option>
          </select>
        </div>
        <div className="field">
          <label>叙述视角</label>
          <select value={pov} onChange={(e) => setPov(e.target.value)}>
            <option value="">跟随全局</option>
            <option value="第一人称">第一人称</option>
            <option value="第三人称">第三人称</option>
            <option value="第二人称">第二人称</option>
          </select>
        </div>
        <div className="field">
          <label>结尾钩子（三态）</label>
          <select value={hook} onChange={(e) => setHook(e.target.value)}>
            <option value="">跟随全局</option>
            <option value="true">强制钩子</option>
            <option value="false">不强制</option>
          </select>
        </div>
        </div>
        <div className="settings-footer">
          <button className="btn btn-primary" onClick={save}>保存章节设置</button>
          {confirmClear ? (
            <div className="inline-confirm">
              <span>确定清除？</span>
              <button className="btn btn-danger-sm" onClick={async () => { await clearOverride(); setConfirmClear(false); }}>确认</button>
              <button className="btn" onClick={() => setConfirmClear(false)}>取消</button>
            </div>
          ) : (
            <button className="btn" onClick={() => setConfirmClear(true)}>清除覆盖</button>
          )}
          {msg && <div className="form-msg">{msg}</div>}
        </div>
      </div>
      </div>

      {/* 删章影响评估 + 二次确认弹窗 */}
      {delState && (
        <IntegrityModal
          mode="confirm"
          title={`删除第 ${delState.index} 章《${delState.title}》 · 影响评估`}
          desc="删除后不可恢复：本章正文、媒体（插画/视频）、版本历史及账本记录将一并移除；章号将出现空号。请知悉影响后确认删除。"
          report={delState.report}
          busy={delState.busy}
          onConfirm={confirmDeleteChapter}
          onClose={() => setDelState(null)}
        />
      )}
    </div>
  );
};

// —— 设定面板：基础设定与自定义统一编辑（左右栏布局） ——
type SubTab = "基础" | "自定义";
const SUB_TABS: SubTab[] = ["基础", "自定义"];

const SettingPanel: React.FC<{ world: WorldState; onSave: Props["onSave"]; onLore: Props["onLore"] }> = (p) => {
  const [sub, setSub] = useState<SubTab>("基础");
  // 基础草稿：（编辑草稿不随 world 刷新，初始值只在挂载时读取一次）
  const [premise, setPremise] = useState(p.world.premise);
  const [time, setTime] = useState(p.world.setting.time);
  const [place, setPlace] = useState(p.world.setting.place);
  const [tone, setTone] = useState(p.world.setting.tone);
  const [rules, setRules] = useState(p.world.setting.rules.join("\n"));
  // 自定义草稿
  const [entries, setEntries] = useState<LoreEntry[]>(p.world.lore ?? []);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [loreBusy, setLoreBusy] = useState(false);

  function setEntry(i: number, patch: Partial<LoreEntry>) {
    setEntries((arr) => arr.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }
  function removeEntry(i: number) {
    setEntries((arr) => arr.filter((_, idx) => idx !== i));
  }

  /** 自动生成自定义条目：直接落库（惰性重建），成功后同步草稿 */
  async function autoLore() {
    setLoreBusy(true);
    setMsg("自动生成中…");
    const out = await p.onLore("auto");
    if (out) setEntries(out);
    setMsg(out ? `已生成 ${out.length} 条设定条目` : "生成失败");
    setLoreBusy(false);
  }

  /** 统一保存：单接口一次提交（基础 + 手动自定义条目，保留 L2 干预流程）
   * auto 条目按基础设定/人物派生，保存时过滤，由服务端自动重建（不固化过期快照） */
  async function save() {
    setSaving(true);
    const ok = await p.onSave({
      premise,
      setting: {
        time,
        place,
        tone,
        rules: rules.split("\n").map((s) => s.trim()).filter(Boolean),
      },
      lore: entries.filter((e) => !e.auto),
    });
    setMsg(ok ? "设定已保存" : "保存失败");
    setSaving(false);
  }

  return (
    <div className="settings-tab-root">
      <div className="settings-split">
      {/* 左栏：二级 tab 列表 */}
      <div className="settings-nav">
        {SUB_TABS.map((t) => (
          <button className={`settings-nav-item ${sub === t ? "active" : ""}`} onClick={() => setSub(t)} key={t}>
            {t}
          </button>
        ))}
      </div>

      {/* 右栏：二级页（滚动区）+ 底部保存按钮（固定区） */}
      <div className="settings-right">
        <div className="settings-page">
          {sub === "基础" && (
            <div>
              <h3 className="col-title">基础设定</h3>
              <div className="field">
                <label>故事梗概（一句话/一段话）</label>
                <textarea value={premise} onChange={(e) => setPremise(e.target.value)} />
              </div>

              <div className="field">
                <label>时代</label>
                <input value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
              <div className="field">
                <label>地点</label>
                <input value={place} onChange={(e) => setPlace(e.target.value)} />
              </div>
              <div className="field">
                <label>文风基调</label>
                <input value={tone} onChange={(e) => setTone(e.target.value)} />
              </div>
              <div className="field">
                <label>世界规则（每行一条：能力体系 / 社会规则 / 禁忌等）</label>
                <textarea value={rules} onChange={(e) => setRules(e.target.value)} />
              </div>
            </div>
          )}

          {sub === "自定义" && (
            <div>
              <h3 className="col-title">设定库</h3>
              <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem" }}>
                <button className="btn" onClick={autoLore} disabled={loreBusy}>
                  {loreBusy ? "处理中…" : (<><Sparkles size={13} /> 自动生成条目</>)}
                </button>
              </div>
              <div className="rules-hint" style={{ marginBottom: "0.5rem" }}>
                写作时自动注入这些设定，导演不得违背；关键词仅作标识。
                <br />「自动」条目按基础设定/人物自动生成，保存时自动重建，不可编辑；下方条目为手动定制。
              </div>
              {entries.map((e, i) => (
                <div style={{ border: "1px solid var(--line)", padding: "0.4rem", marginBottom: "0.4rem" }} key={e.id}>
                  <div className="field" style={{ marginBottom: "0.3rem" }}>
                    <label>
                      关键词{e.auto && <span className="settings-auto-tag">自动</span>}
                    </label>
                    <input
                      value={e.keywords.join("、")}
                      readOnly={e.auto}
                      onChange={(ev) => setEntry(i, { keywords: ev.target.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 4) })}
                    />
                  </div>
                  <div className="field" style={{ marginBottom: "0.3rem" }}>
                    <label>内容</label>
                    <textarea value={e.content} readOnly={e.auto} onChange={(ev) => setEntry(i, { content: ev.target.value })} />
                  </div>
                  <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                    <label style={{ fontSize: "0.72rem", fontFamily: "var(--sans)" }}>
                      <input type="checkbox" checked={e.enabled} disabled={e.auto} onChange={(ev) => setEntry(i, { enabled: ev.target.checked })} /> 启用
                    </label>
                    {!e.auto && (
                      <button className="btn-save" style={{ marginTop: "0" }} onClick={() => removeEntry(i)}>
                        删除
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {entries.length === 0 && (
                <div style={{ fontSize: "0.78rem", color: "var(--ink-soft)" }}>（暂无条目，点击「自动生成条目」从基础设定/人物/规则生成）</div>
              )}
            </div>
          )}
        </div>

        <div className="settings-footer">
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存设定"}
          </button>
          {msg && <div className="form-msg" style={{ margin: 0 }}>{msg}</div>}
        </div>
      </div>
    </div>
    </div>
  );
};

// —— 角色编辑器 ——
const CharacterEditor: React.FC<{ world: WorldState; onSave: Props["onSave"]; onImage: Props["onImage"]; onToggleLock?: Props["onToggleLock"]; onViewPortrait?: Props["onViewPortrait"]; taskActive?: boolean }> = (p) => {
  // 默认选中第一个角色（表单字段随选中初始化）
  const first = p.world.characters[0] ?? null;
  const [selId, setSelId] = useState<string | null>(first?.id ?? null);
  const [imgBusy, setImgBusy] = useState(false);
  const selected = p.world.characters.find((c) => c.id === selId) ?? null;
  const [name, setName] = useState(first?.name ?? "");
  const [role, setRole] = useState(first?.role ?? "");
  const [gender, setGender] = useState(first?.gender ?? "");
  const [age, setAge] = useState(first?.age ?? "");
  const [identity, setIdentity] = useState(first?.identity ?? "");
  const [look, setLook] = useState(first?.look ?? "");
  const [traits, setTraits] = useState(first ? first.traits.join("、") : "");
  const [motivation, setMotivation] = useState(first?.motivation ?? "");
  const [voice, setVoice] = useState(first?.voice ?? "");
  const [status, setStatus] = useState(first?.status ?? "");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  function pick(c: Character) {
    setSelId(c.id);
    setName(c.name);
    setRole(c.role);
    setGender(c.gender ?? "");
    setAge(c.age ?? "");
    setIdentity(c.identity ?? "");
    setLook(c.look ?? "");
    setTraits(c.traits.join("、"));
    setMotivation(c.motivation);
    setVoice(c.voice ?? "");
    setStatus(c.status);
    setMsg("");
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    const ok = await p.onSave({
      characters: [
        {
          id: selected.id,
          name,
          role,
          gender: gender.trim() || undefined,
          age: age.trim() || undefined,
          identity: identity.trim() || undefined,
          look: look.trim() || undefined,
          traits: traits.split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
          motivation,
          voice: voice.trim() || undefined,
          status,
        },
      ],
    });
    setMsg(ok ? "已保存" : "保存失败");
    setSaving(false);
  }

  async function deleteChar(id: string) {
    if (p.taskActive) { setMsg("任务运行中，角色编辑已禁止——请先取消任务。"); return; } // 运行锁
    setSaving(true);
    const ok = await p.onSave({ removeCharacterIds: [id] });
    setMsg(ok ? "角色已删除" : "删除失败（已登场角色不可删除）");
    if (ok && selId === id) {
      const rest = p.world.characters.filter((c) => c.id !== id);
      if (rest[0]) pick(rest[0]);
      else setSelId(null);
    }
    setConfirmDelete(null);
    setSaving(false);
  }

  return (
    <div className="settings-tab-root">
      <div className="character-settings">
      {/* 左栏：角色列表（同章节面板左右布局） */}
      <div className="chapter-list">
        {p.world.characters.length === 0 && (
          <div style={{ fontSize: "0.72rem", color: "var(--ink-soft)" }}>（暂无角色）</div>
        )}
        {p.world.characters.map((c) => (
          <div className={`char-list-item ${selId === c.id ? "active" : ""}`} onClick={() => pick(c)} key={c.id}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
              {(c.image ?? c.portrait?.path) && (
                <img
                  src={`/api/novel/asset?title=${encodeURIComponent(p.world.title)}&path=${encodeURIComponent(c.image ?? c.portrait!.path)}`}
                  alt={`${c.name}头像`}
                  title="头像（点击查看全局立绘）"
                  style={{ width: "36px", flexShrink: 0, aspectRatio: "1", objectFit: "cover", border: "1px solid var(--line-strong)", cursor: "pointer" }}
                  onClick={(e) => { e.stopPropagation(); p.onViewPortrait?.(c); }}
                />
              )}
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="panel-name">{c.name}</span> <span className="panel-tag tag-seal">{c.role}</span>
                {(c.gender || c.age || c.identity) && (
                  <div className="char-item-sub">
                    {[c.gender, c.age, c.identity].filter(Boolean).join(" · ")}
                  </div>
                )}
              </span>
              {selId === c.id && (
                <button className="char-del-btn" title="删除角色" onClick={(e) => { e.stopPropagation(); setConfirmDelete(c.id); }}>
                  <X size={15} />
                </button>
              )}
            </div>
            {/* 删除确认 */}
            {confirmDelete === c.id && (
              <div className="char-del-confirm" onClick={(e) => e.stopPropagation()}>
                <span>确定删除「{c.name}」？</span>
                <span style={{ display: "inline-flex", gap: "0.3rem" }}>
                  <button className="btn btn-danger-sm" onClick={() => deleteChar(c.id)}>确认</button>
                  <button className="btn" onClick={() => setConfirmDelete(null)}>取消</button>
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
      {/* 右栏：编辑表单（滚动区）+ 底部保存按钮（固定区） */}
      <div className="settings-right">
      <div className="settings-page">
      {selected ? (
        <>
          {selected.image && (
            <img
              src={`/api/novel/asset?title=${encodeURIComponent(p.world.title)}&path=${encodeURIComponent(selected.image)}`}
              alt={selected.name}
              style={{ width: "72px", border: "1px solid var(--line-strong)", marginBottom: "0.4rem", display: "block", aspectRatio: "1", background: "var(--paper-dark)", objectFit: "cover" }}
            />
          )}
          <button
            className="btn"
            style={{ marginBottom: "0.5rem" }}
            disabled={imgBusy}
            onClick={async () => {
              // 防连点：生成期间按钮禁用并显示进度（全局 busy 遮罩由 Home.imageAction 统一管理）
              setImgBusy(true);
              try {
                await p.onImage("character", { characterId: selected.id });
              } finally {
                setImgBusy(false);
              }
            }}
          >
            <Wand2 size={13} /> {imgBusy ? "生成中…" : "AI 生成头像"}
          </button>
          <button
            className="btn"
            style={{ marginBottom: "0.5rem", marginLeft: "0.4rem" }}
            onClick={() => p.onViewPortrait?.(selected)}
          >
            <Sparkles size={13} /> 查看/生成全局立绘
          </button>
          <div className="field">
            <label>姓名</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>定位（枚举）</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {/* 存量数据中的非枚举值保留显示，避免静默丢值 */}
              {!["主角", "反派", "配角", "关键人物", "待登场", "其他"].includes(role) && (
                <option value={role}>{role}（保留）</option>
              )}
              <option value="主角">主角</option>
              <option value="反派">反派</option>
              <option value="配角">配角</option>
              <option value="关键人物">关键人物</option>
              <option value="待登场">待登场</option>
              <option value="其他">其他</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <div className="field" style={{ flex: 1 }}>
              <label>性别</label>
              <select value={gender} onChange={(e) => setGender(e.target.value)}>
                {/* 只有男/女可选；存量数据未设置性别的角色显示不可选占位，保存前必须选择 */}
                {!gender && <option value="" disabled>（未设置，请选择）</option>}
                <option value="男">男</option>
                <option value="女">女</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>年龄</label>
              <input value={age} placeholder="如：二十出头" onChange={(e) => setAge(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>身份（社会身份/职业，如：东厂提督）</label>
            <input value={identity} onChange={(e) => setIdentity(e.target.value)} />
          </div>
          <div className="field">
            <label>特质（顿号分隔）</label>
            <input value={traits} onChange={(e) => setTraits(e.target.value)} />
          </div>
          <div className="field">
            <label>动机</label>
            <textarea value={motivation} onChange={(e) => setMotivation(e.target.value)} />
          </div>
          <div className="field">
            <label>声线（说话风格，如：简短冷峻爱用反问）</label>
            <input value={voice} onChange={(e) => setVoice(e.target.value)} />
          </div>
          <div className="field">
            <label>当前状态</label>
            <input value={status} onChange={(e) => setStatus(e.target.value)} />
            {/* P3.5 字段锁：手改 status 后自动上锁，AI 记账不再覆盖；可手动解锁 */}
            {selected && (() => {
              const locked = (p.world.lockedFields ?? []).some((l) => l.characterId === selected.id && l.field === "status");
              return (
                <div className="rules-hint" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  {locked ? "🔒 已锁定：AI 不会自动覆盖此字段" : "修改保存后将自动上锁（AI 不再覆盖）"}
                  {p.onToggleLock && (
                    <button className="btn btn-xs" onClick={async () => { if (selected && p.onToggleLock) await p.onToggleLock(selected.id, "status", !locked); }}>
                      {locked ? "解锁" : "上锁"}
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
          {/* 登场章节：只读展示（由正文自动记账，左侧列表不再显示） */}
          <div className="char-readonly-row">
            <label>登场章节</label>
            <span>
              {(selected.appearedIn?.length ?? 0) > 0
                ? `第 ${selected.appearedIn!.join("、")} 章`
                : "尚未登场（AI 在正文中写入该角色后自动登记）"}
            </span>
          </div>
          <div className="field">
            <label>当前形象（容貌/装扮/伤情等动态变化，如：右臂缠绷带）</label>
            <input value={look} onChange={(e) => setLook(e.target.value)} />
            {/* 字段锁：手改 look 后自动上锁，AI 记账不再覆盖；可手动解锁 */}
            {selected && (() => {
              const locked = (p.world.lockedFields ?? []).some((l) => l.characterId === selected.id && l.field === "look");
              return (
                <div className="rules-hint" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  {locked ? "🔒 已锁定：AI 不会自动覆盖此字段" : "修改保存后将自动上锁（AI 不再覆盖）"}
                  {p.onToggleLock && (
                    <button className="btn btn-xs" onClick={async () => { if (selected && p.onToggleLock) await p.onToggleLock(selected.id, "look", !locked); }}>
                      {locked ? "解锁" : "上锁"}
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        </>
      ) : (
        <div style={{ fontSize: "0.8rem", color: "var(--ink-soft)", padding: "0.8rem 0" }}>
          在左侧选择一个角色进行编辑
        </div>
      )}
      </div>
      <div className="settings-footer">
        {selected && (
          <>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
            {msg && <div className="form-msg" style={{ margin: 0 }}>{msg}</div>}
          </>
        )}
      </div>
      </div>
      </div>
    </div>
  );
};

// —— 大纲编辑器 ——
const OutlineEditor: React.FC<{
  world: WorldState;
  onSave: Props["onSave"];
  onGenerate: Props["onGenerateOutline"];
  busy: boolean;
}> = (p) => {
  const [items, setItems] = useState<string[]>([...(p.world.outline ?? [])]);
  const [hint, setHint] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  function setItem(i: number, v: string) {
    setItems((arr) => arr.map((x, idx) => (idx === i ? v : x)));
  }
  function remove(i: number) {
    setItems((arr) => arr.filter((_, idx) => idx !== i));
  }
  function add() {
    setItems((arr) => [...arr, ""]);
  }
  async function save() {
    setSaving(true);
    const ok = await p.onSave({ outline: items.map((s) => s.trim()).filter(Boolean) });
    setMsg(ok ? "已保存" : "保存失败");
    setSaving(false);
  }
  async function generate() {
    setMsg("");
    const outline = await p.onGenerate(hint || undefined);
    if (outline) setItems(outline);
  }

  return (
    <div className="settings-tab-root">
      <div className="settings-page">
      <h3 className="col-title">大纲 · 叙事规划</h3>
      <div className="field">
        <label>创作意图（可选，告诉 AI 往哪走）</label>
        <input placeholder="例如：让主角发现凶手的身份线索" value={hint} onChange={(e) => setHint(e.target.value)} />
      </div>
      <button className="btn" onClick={generate} disabled={p.busy}>
        {p.busy ? "规划中…" : (<><Sparkles size={13} /> AI 生成大纲</>)}
      </button>
      <div style={{ height: "0.5rem" }} />
      {items.map((item, i) => (
        <div className="outline-item" key={i}>
          <span className="idx">{i + 1}</span>
          <textarea value={item} onChange={(e) => setItem(i, e.target.value)} />
          <button className="btn-save" onClick={() => remove(i)} style={{ marginTop: "0" }}>
            删
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
        <button className="btn" onClick={add}>＋ 添加要点</button>
      </div>
      <div className="rules-hint" style={{ marginTop: "0.4rem" }}>
        写作时会按大纲推进；大纲为空时导演自由发挥。
      </div>
      </div>
      <div className="settings-footer">
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "保存大纲"}
        </button>
        {msg && <div className="form-msg" style={{ margin: 0 }}>{msg}</div>}
      </div>
    </div>
  );
};



// —— 导出 ——
const ExportTab: React.FC<{ onExport: Props["onExport"] }> = (p) => (
  <div className="settings-tab-root">
    <div className="settings-page">
    <h3 className="col-title">导出作品</h3>
    <div className="rules-hint" style={{ marginBottom: "0.8rem" }}>
      将全书正文导出为 Markdown 或 EPUB 文件（含章节标题，不含审查记录）。
    </div>
    <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
      <button className="btn" onClick={() => p.onExport()}>
        <FileText size={14} /> 导出 Markdown
      </button>
      <button className="btn" onClick={() => p.onExport("epub")}>
        <BookMarked size={14} /> 导出 EPUB
      </button>
    </div>
  </div>
  </div>
);
