// ⚙️ 设置面板：小说级 / 章节级设定统一管控
// Tab：全局生成参数 / 章节覆盖 / 世界观 / 设定 / 角色 / 大纲 / 世界书 / 导出
import { useState } from "react";
import { BookMarked, FileText, Settings, Upload, Wand2, X, Sparkles } from "../components/icons";
import { DEFAULT_GEN, type Character, type FidelityRule, type GenProfile, type LoreEntry, type WorldState, type WorldPatch } from "../api/world";
import { RangeSlider } from "./RangeSlider";

type Tab = "全局" | "章节" | "世界观" | "设定" | "角色" | "大纲" | "世界书" | "导出";

const TABS: Tab[] = ["全局", "章节", "世界观", "设定", "角色", "大纲", "世界书", "导出"];

type Props = {
  world: WorldState;
  onSave: (patch: WorldPatch) => Promise<boolean>;
  onImage: (kind: "cover" | "character" | "chapter", args?: Record<string, unknown>) => Promise<{ path?: string } | null>;
  onLore: (action: "auto" | "save", entries?: LoreEntry[]) => Promise<LoreEntry[] | null>;
  onGenerateOutline: (hint?: string) => Promise<void>;
  outlineBusy: boolean;
  onExport: (format?: "epub") => void;
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
          {tab === "全局" && <GlobalSettings world={p.world} onSave={p.onSave} onImage={p.onImage} />}
          {tab === "章节" && <ChapterSettings world={p.world} onSave={p.onSave} />}
          {tab === "世界观" && <PremiseEditor world={p.world} onSave={p.onSave} />}
          {tab === "设定" && <SettingEditor world={p.world} onSave={p.onSave} />}
          {tab === "角色" && <CharacterEditor world={p.world} onSave={p.onSave} onImage={p.onImage} />}
          {tab === "大纲" && <OutlineEditor world={p.world} onSave={p.onSave} onGenerate={p.onGenerateOutline} busy={p.outlineBusy} />}
          {tab === "世界书" && <LoreEditor world={p.world} onLore={p.onLore} />}
          {tab === "导出" && <ExportTab onExport={p.onExport} />}
        </div>
      </div>
    </div>
  );
};

// —— 全局设置 ——
const GlobalSettings: React.FC<{ world: WorldState; onSave: Props["onSave"]; onImage: Props["onImage"] }> = (p) => {
  const g = { ...DEFAULT_GEN, ...p.world.gen };
  const [minWords, setMinWords] = useState(String(g.minWords));
  const [maxWords, setMaxWords] = useState(String(g.maxWords));
  const [mode, setMode] = useState<GenProfile["settingMode"]>(g.settingMode);
  const [pov, setPov] = useState<GenProfile["pov"]>(g.pov);
  const [temp, setTemp] = useState(String(g.temperature));
  const [strict, setStrict] = useState<GenProfile["reviewStrictness"]>(g.reviewStrictness);
  const [maxFs, setMaxFs] = useState(String(g.maxForeshadowPerChapter));
  const [hook, setHook] = useState(g.forceHook);
  const [auto, setAuto] = useState(g.autoGacha);
  const [rules, setRules] = useState<FidelityRule[]>([...(g.fidelityRules ?? [])]);
  const [msg, setMsg] = useState("");
  const [imgBusy, setImgBusy] = useState(false);

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
    const ok = await p.onSave({
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
        fidelityRules: rules.filter((r) => r.content.trim()),
      },
    });
    setMsg(ok ? "已保存，下一节生效" : "保存失败");
  }

  return (
    <div>
      <div className="field">
        <label>章节字数范围</label>
        <RangeSlider
          min={100}
          max={20000}
          value={[Number(minWords) || 300, Number(maxWords) || 500]}
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
        <button className="btn-save" onClick={addRule}>＋ 添加条目</button>
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
        <label>每节新伏笔上限（0-4）</label>
        <input type="number" min={0} max={4} value={maxFs} onChange={(e) => setMaxFs(e.target.value)} />
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={hook} onChange={(e) => setHook(e.target.checked)} /> 强制章节结尾钩子
        </label>
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 每节推进前自动抽卡
        </label>
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
            className="btn-save"
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
          <label className="btn-save" style={{ cursor: imgBusy ? "not-allowed" : "pointer", opacity: imgBusy ? "0.45" : "1" }} onClick={(e) => { if (imgBusy) e.preventDefault(); }}>
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
      <button className="btn btn-primary" onClick={save}>保存全局设置</button>
      {msg && <div className="form-msg">{msg}</div>}
    </div>
  );
};

// —— 章节级设置（覆盖全局） ——
const ChapterSettings: React.FC<{ world: WorldState; onSave: Props["onSave"] }> = (p) => {
  const chapters = p.world.chapters;
  const [sel, setSel] = useState<number>(chapters[chapters.length - 1]?.index ?? 1);
  const current = p.world.chapterGen?.[sel] ?? {};
  const [words, setWords] = useState<[number, number]>([
    current.minWords ?? 0,
    current.maxWords ?? 0,
  ]);
  const [strict, setStrict] = useState<string>(current.reviewStrictness ?? "");
  const [pov, setPov] = useState<string>(current.pov ?? "");
  const [hook, setHook] = useState<string>(current.forceHook == null ? "" : String(current.forceHook));
  const [msg, setMsg] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  function pick(i: number) {
    setSel(i);
    const c = p.world.chapterGen?.[i] ?? {};
    setWords([c.minWords ?? 0, c.maxWords ?? 0]);
    setStrict(c.reviewStrictness ?? "");
    setPov(c.pov ?? "");
    setHook(c.forceHook == null ? "" : String(c.forceHook));
  }

  async function save() {
    const cur = p.world.chapterGen?.[sel] ?? {}; // 该章节已有覆盖
    // 仅发送变化字段：归零/置空且原覆盖存在 → null（per-key 删除）；否则 undefined（不发送）
    const patch: Record<number, Record<string, unknown>> = {
      [sel]: {
        minWords: words[0] === 0 ? (cur.minWords != null ? null : undefined) : words[0],
        maxWords: words[1] === 0 ? (cur.maxWords != null ? null : undefined) : words[1],
        reviewStrictness: strict === "" ? (cur.reviewStrictness ? null : undefined) : strict,
        pov: pov === "" ? (cur.pov ? null : undefined) : pov,
        forceHook: hook === "" ? (cur.forceHook != null ? null : undefined) : hook === "true",
      },
    };
    const ok = await p.onSave({ chapterGen: patch });
    setMsg(ok ? "章节设置已保存（滑杆归零 = 跟随全局）" : "保存失败");
  }

  async function clearOverride() {
    const ok = await p.onSave({ chapterGen: { [sel]: null } });
    setMsg(ok ? "已清除该章节覆盖" : "操作失败");
  }

  return (
    <div className="chapter-settings">
      <div className="chapter-list">
        {chapters.map((c) => (
          <button className={`chapter-list-item ${sel === c.index ? "active" : ""}`} onClick={() => pick(c.index)} key={c.index}>
            第 {c.index} 节 {c.title}
          </button>
        ))}
      </div>
      <div>
        <div className="rules-hint" style={{ marginBottom: "0.5rem" }}>滑杆归零 / 留空 = 跟随全局</div>
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
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button className="btn btn-primary" onClick={save}>保存章节设置</button>
          {confirmClear ? (
            <div className="inline-confirm">
              <span>确定清除？</span>
              <button className="btn-save btn-danger-sm" onClick={async () => { await clearOverride(); setConfirmClear(false); }}>确认</button>
              <button className="btn-save" onClick={() => setConfirmClear(false)}>取消</button>
            </div>
          ) : (
            <button className="btn" onClick={() => setConfirmClear(true)}>清除覆盖</button>
          )}
        </div>
        {msg && <div className="form-msg">{msg}</div>}
      </div>
    </div>
  );
};

// —— 世界观（梗概）编辑器 ——
const PremiseEditor: React.FC<{ world: WorldState; onSave: Props["onSave"] }> = (p) => {
  const [draft, setDraft] = useState(p.world.premise);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    const ok = await p.onSave({ premise: draft });
    setMsg(ok ? "已保存" : "保存失败");
    setSaving(false);
  }
  return (
    <div>
      <h3 className="col-title">世界观 · 梗概</h3>
      <div className="field">
        <label>故事梗概（一句话/一段话）</label>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
      </div>
      <button className="btn-save" onClick={save} disabled={saving}>
        {saving ? "保存中…" : "保存"}
      </button>
      {msg && <div className="form-msg">{msg}</div>}
    </div>
  );
};

// —— 设定编辑器 ——
const SettingEditor: React.FC<{ world: WorldState; onSave: Props["onSave"] }> = (p) => {
  // 编辑草稿不随 world 刷新（初始值只在挂载时读取一次）
  const [time, setTime] = useState(p.world.setting.time);
  const [place, setPlace] = useState(p.world.setting.place);
  const [tone, setTone] = useState(p.world.setting.tone);
  const [rules, setRules] = useState(p.world.setting.rules.join("\n"));
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    const ok = await p.onSave({
      setting: {
        time,
        place,
        tone,
        rules: rules.split("\n").map((s) => s.trim()).filter(Boolean),
      },
    });
    setMsg(ok ? "已保存" : "保存失败");
    setSaving(false);
  }
  return (
    <div>
      <h3 className="col-title">设定</h3>
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
        <label>世界规则 / 禁忌</label>
        <textarea value={rules} onChange={(e) => setRules(e.target.value)} />
        <div className="rules-hint">每行一条（能力体系 / 社会规则 / 禁忌）</div>
      </div>
      <button className="btn-save" onClick={save} disabled={saving}>
        {saving ? "保存中…" : "保存"}
      </button>
      {msg && <div className="form-msg">{msg}</div>}
    </div>
  );
};

// —— 角色编辑器 ——
const CharacterEditor: React.FC<{ world: WorldState; onSave: Props["onSave"]; onImage: Props["onImage"] }> = (p) => {
  const [selId, setSelId] = useState<string | null>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const selected = p.world.characters.find((c) => c.id === selId) ?? null;
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [traits, setTraits] = useState("");
  const [motivation, setMotivation] = useState("");
  const [voice, setVoice] = useState("");
  const [status, setStatus] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  function pick(c: Character) {
    setSelId(c.id);
    setName(c.name);
    setRole(c.role);
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
    setSaving(true);
    const ok = await p.onSave({ removeCharacterIds: [id] });
    setMsg(ok ? "角色已删除" : "删除失败（已登场角色不可删除）");
    if (ok && selId === id) setSelId(null);
    setConfirmDelete(null);
    setSaving(false);
  }

  return (
    <div>
      <h3 className="col-title">角色</h3>
      <ul className="panel-list">
        {p.world.characters.map((c) => (
          <li className="panel-item" style={{ cursor: "pointer" }} onClick={() => pick(c)} key={c.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                <span className="panel-name">{c.name}</span> <span className="panel-tag tag-seal">{c.role}</span>
                {(c.appearedIn?.length ?? 0) > 0 && (
                  <span style={{ fontSize: "0.62rem", color: "var(--ink-soft)" }}>·登场{c.appearedIn!.join("、")}节</span>
                )}
              </span>
              {selId === c.id && (
                <button className="btn-save btn-danger-sm" onClick={(e) => { e.stopPropagation(); setConfirmDelete(c.id); }} style={{ marginTop: "0", fontSize: "0.65rem" }}>
                  删除
                </button>
              )}
            </div>
            {selId === c.id && (
              <span style={{ fontSize: "0.66rem", color: "var(--seal)" }}>← 编辑中</span>
            )}
            {/* 删除确认 */}
            {confirmDelete === c.id && (
              <div className="inline-confirm" onClick={(e) => e.stopPropagation()}>
                <span>确定删除「{c.name}」？</span>
                <button className="btn-save btn-danger-sm" onClick={() => deleteChar(c.id)}>确认</button>
                <button className="btn-save" onClick={() => setConfirmDelete(null)}>取消</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {selected && (
        <>
          {selected.image && (
            <img
              src={`/api/novel/asset?title=${encodeURIComponent(p.world.title)}&path=${encodeURIComponent(selected.image)}`}
              alt={selected.name}
              style={{ width: "72px", border: "1px solid var(--line-strong)", marginBottom: "0.4rem", display: "block", aspectRatio: "1", background: "var(--paper-dark)", objectFit: "cover" }}
            />
          )}
          <button
            className="btn-save"
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
          </div>
          <button className="btn-save" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
          {msg && <div className="form-msg">{msg}</div>}
        </>
      )}
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
    await p.onGenerate(hint || undefined);
    setItems([...(p.world.outline ?? [])]);
  }

  return (
    <div>
      <h3 className="col-title">大纲 · 叙事规划</h3>
      <div className="field">
        <label>创作意图（可选，告诉 AI 往哪走）</label>
        <input placeholder="例如：让主角发现凶手的身份线索" value={hint} onChange={(e) => setHint(e.target.value)} />
      </div>
      <button className="btn-save" onClick={generate} disabled={p.busy}>
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
        <button className="btn-save" onClick={add}>＋ 添加要点</button>
        <button className="btn-save" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "保存大纲"}
        </button>
      </div>
      {msg && <div className="form-msg">{msg}</div>}
      <div className="rules-hint" style={{ marginTop: "0.4rem" }}>
        写作时会按大纲推进；大纲为空时导演自由发挥。
      </div>
    </div>
  );
};

// —— 世界书编辑器 ——
const LoreEditor: React.FC<{ world: WorldState; onLore: Props["onLore"] }> = (p) => {
  const [entries, setEntries] = useState<LoreEntry[]>(p.world.lore ?? []);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  function setEntry(i: number, patch: Partial<LoreEntry>) {
    setEntries((arr) => arr.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }
  function remove(i: number) {
    setEntries((arr) => arr.filter((_, idx) => idx !== i));
  }
  async function auto() {
    setBusy(true);
    setMsg("自动生成中…");
    const out = await p.onLore("auto");
    if (out) setEntries(out);
    setMsg(out ? `已生成 ${out.length} 条设定条目` : "生成失败");
    setBusy(false);
  }
  async function save() {
    setBusy(true);
    const out = await p.onLore("save", entries);
    if (out) setEntries(out);
    setMsg(out ? "世界书已保存" : "保存失败");
    setBusy(false);
  }

  return (
    <div>
      <h3 className="col-title">世界书 · 设定库</h3>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem" }}>
        <button className="btn-save" onClick={auto} disabled={busy}>
          {busy ? "处理中…" : (<><Sparkles size={13} /> 自动生成条目</>)}
        </button>
        <button className="btn-save" onClick={save} disabled={busy}>
          保存
        </button>
      </div>
      <div className="rules-hint" style={{ marginBottom: "0.5rem" }}>
        写作时自动注入这些设定，导演不得违背；关键词仅作标识。
      </div>
      {entries.map((e, i) => (
        <div style={{ border: "1px solid var(--line)", padding: "0.4rem", marginBottom: "0.4rem" }} key={e.id}>
          <div className="field" style={{ marginBottom: "0.3rem" }}>
            <label>关键词</label>
            <input value={e.keywords.join("、")} onChange={(ev) => setEntry(i, { keywords: ev.target.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 4) })} />
          </div>
          <div className="field" style={{ marginBottom: "0.3rem" }}>
            <label>内容</label>
            <textarea value={e.content} onChange={(ev) => setEntry(i, { content: ev.target.value })} />
          </div>
          <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
            <label style={{ fontSize: "0.72rem", fontFamily: "var(--sans)" }}>
              <input type="checkbox" checked={e.enabled} onChange={(ev) => setEntry(i, { enabled: ev.target.checked })} /> 启用
            </label>
            <button className="btn-save" style={{ marginTop: "0" }} onClick={() => remove(i)}>
              删除
            </button>
          </div>
        </div>
      ))}
      {entries.length === 0 && (
        <div style={{ fontSize: "0.78rem", color: "var(--ink-soft)" }}>（暂无条目，点击「自动生成条目」从世界观/人物/规则生成）</div>
      )}
      {msg && <div className="form-msg">{msg}</div>}
    </div>
  );
};

// —— 导出 ——
const ExportTab: React.FC<{ onExport: Props["onExport"] }> = (p) => (
  <div>
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
);
