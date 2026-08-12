// 中枢对话卡片（brain-cards）渲染回归：
// browse(proposal) 卡渲染推荐原因 + 确认/拒绝可交互按钮，点击回调携带正确 action
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrainCardView, type BrowseCard } from "../src/components/brain-cards";
import { flattenFormValues } from "../src/api/brain-chat";

let win: Window;
beforeAll(() => {
  win = new Window({ url: "http://localhost/" });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.navigator = win.navigator as unknown as Navigator;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
});
afterAll(() => {
  win.happyDOM.close();
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const proposalCard = (): BrowseCard => ({
  kind: "browse",
  title: "新角色提案（1 项）",
  browseType: "proposal",
  data: {
    list: [
      {
        id: "cp1",
        name: "小翠",
        role: "掌柜",
        reason: "与主角身世成谜呼应",
        motivation: "查清身世",
        source: "writer",
        actions: [
          { label: "确认入册", action: { endpoint: "/api/novel/proposal", method: "POST", body: { proposalId: "cp1", action: "confirm" } } },
          { label: "拒绝", danger: true, action: { endpoint: "/api/novel/proposal", method: "POST", body: { proposalId: "cp1", action: "reject" } } },
        ],
      },
    ],
  },
});

test("browse(proposal) 卡：默认折叠为标题行（可展开），展开后渲染推荐原因 + 确认/拒绝按钮", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  // 真实场景（BrainCabin）总传 onExecute；无回调时操作按钮不渲染
  root.render(React.createElement(BrainCardView, { card: proposalCard(), onExecute: () => {} }));
  await tick();
  // 默认折叠：标题 + 折叠提示可见，内容与操作隐藏
  let t = mount.textContent ?? "";
  expect(t).toContain("新角色提案（1 项）");
  expect(t).toContain("已折叠");
  expect(t).not.toContain("推荐原因：与主角身世成谜呼应");
  const toggle = mount.querySelector(".bc-fold-toggle") as HTMLButtonElement | null;
  expect(toggle).toBeTruthy();
  toggle!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  // 展开后：内容 + 操作按钮可见，折叠提示消失
  t = mount.textContent ?? "";
  expect(t).toContain("推荐原因：与主角身世成谜呼应");
  expect(t).toContain("动机：查清身世");
  expect(t).not.toContain("已折叠");
  const buttons = [...mount.querySelectorAll("button")].map((b) => b.textContent ?? "");
  expect(buttons).toContain("确认入册");
  expect(buttons).toContain("拒绝");
  root.unmount();
});

test("点击「确认入册」→ onExecute 携带对应 action（endpoint + body）", async () => {
  const calls: { card: BrowseCard; action?: { endpoint: string; method?: string; body: Record<string, unknown> } }[] = [];
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: proposalCard(),
      onExecute: (card, action) => calls.push({ card: card as BrowseCard, action }),
    }),
  );
  await tick();
  // 默认折叠：先展开再操作
  const toggle = mount.querySelector(".bc-fold-toggle") as HTMLButtonElement | null;
  expect(toggle).toBeTruthy();
  toggle!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  const confirmBtn = [...mount.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("确认入册"));
  expect(confirmBtn).toBeTruthy();
  confirmBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  expect(calls.length).toBe(1);
  expect(calls[0].action?.endpoint).toBe("/api/novel/proposal");
  expect(calls[0].action?.body).toEqual({ proposalId: "cp1", action: "confirm" });
  root.unmount();
});

test("browse(proposal) 卡 completedItems：已处理项按钮替换为 ✓ 已处理，未含项仍可操作", async () => {
  const twoCard: BrowseCard = {
    kind: "browse",
    title: "新角色提案（2 项）",
    browseType: "proposal",
    data: {
      list: [
        { id: "cp1", name: "小翠", role: "掌柜", source: "writer", actions: [{ label: "确认入册", action: { endpoint: "/api/novel/proposal", method: "POST", body: { proposalId: "cp1", action: "confirm" } } }] },
        { id: "cp2", name: "阿福", role: "马夫", source: "writer", actions: [{ label: "确认入册", action: { endpoint: "/api/novel/proposal", method: "POST", body: { proposalId: "cp2", action: "confirm" } } }] },
      ],
    },
  };
  const calls: { action?: { endpoint: string; method?: string; body: Record<string, unknown> } }[] = [];
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: twoCard,
      onExecute: (_c, a) => calls.push({ action: a }),
      completedItems: new Set(["cp1"]),
    }),
  );
  await tick();
  // 默认折叠：先展开
  const toggle = mount.querySelector(".bc-fold-toggle") as HTMLButtonElement | null;
  expect(toggle).toBeTruthy();
  toggle!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  const t = mount.textContent ?? "";
  // 已处理项就地反馈（✓ 已处理），cp2 按钮仍在
  expect(t).toContain("已处理");
  expect(mount.querySelector(".bc-done-tag")).toBeTruthy();
  const confirmBtns = [...mount.querySelectorAll("button")].map((b) => b.textContent ?? "").filter((x) => x.includes("确认入册"));
  expect(confirmBtns.length).toBe(1);
  // 点击未处理项（cp2）仍触发 onExecute，body 携带对应 proposalId
  const btn = [...mount.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("确认入册"))!;
  btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  expect(calls.length).toBe(1);
  expect(calls[0].action?.body).toEqual({ proposalId: "cp2", action: "confirm" });
  root.unmount();
});

test("卡片 image 字段：渲染在卡片内容上方（browse/result 均可）", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: { ...proposalCard(), image: { src: "data:image/png;base64,AAA", alt: "小翠立绘" } },
      onExecute: () => {},
    }),
  );
  await tick();
  const img = mount.querySelector("img.brain-card-image");
  expect(img).toBeTruthy();
  expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAA");
  expect(img?.getAttribute("alt")).toBe("小翠立绘");
  expect(img?.getAttribute("loading")).toBe("lazy");
  // 卡片正文仍在（附图不覆盖内容）
  expect(mount.textContent ?? "").toContain("新角色提案（1 项）");
  root.unmount();
});

test("无 image 字段：不渲染附图容器", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(React.createElement(BrainCardView, { card: proposalCard(), onExecute: () => {} }));
  await tick();
  expect(mount.querySelector("img.brain-card-image")).toBeNull();
  root.unmount();
});

test("plan 卡：渲染计划选项（含动作与纯说明）", async () => {
  const calls: { option: { label: string; action?: { endpoint: string } } }[] = [];
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: {
        kind: "plan",
        title: "计划选项",
        summary: "给你三个方向",
        options: [
          { label: "推进一章", description: "写下一章", action: { endpoint: "/api/novel/step", method: "POST", body: {} } },
          { label: "查看现状", description: "看进度" },
        ],
      },
      onOption: (o) => calls.push({ option: o as { label: string; action?: { endpoint: string } } }),
    }),
  );
  await tick();
  const t = mount.textContent ?? "";
  expect(t).toContain("计划选项");
  expect(t).toContain("推进一章");
  const btn = [...mount.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("推进一章"));
  expect(btn).toBeTruthy();
  btn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  expect(calls.length).toBe(1);
  expect(calls[0].option.action?.endpoint).toBe("/api/novel/step");
  root.unmount();
});

test("opinion 卡：标记「请选择」并渲染选项", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: { kind: "opinion", title: "意见征询", options: [{ label: "保持现状", description: "继续当前节奏" }] },
    }),
  );
  await tick();
  expect(mount.textContent ?? "").toContain("请选择");
  expect(mount.textContent ?? "").toContain("保持现状");
  root.unmount();
});

// —— Phase 2：表单卡（FormCard）渲染与提交 ——

test("form 卡：渲染字段（text/textarea/select）与提交按钮，提交携带受控初始值", async () => {
  const calls: { card: { title: string }; values: Record<string, unknown> }[] = [];
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: {
        kind: "form",
        title: "编辑角色「林墨」",
        commandId: "CMD-W12",
        level: "L2",
        summary: "修改林墨的信息",
        fields: [
          { key: "status", label: "当前状态", type: "text", value: "调查中" },
          { key: "motivation", label: "动机", type: "textarea", value: "查明真相" },
          { key: "gender", label: "性别", type: "select", value: "男", options: [{ label: "男", value: "男" }, { label: "女", value: "女" }] },
        ],
        action: { endpoint: "/api/novel/world", method: "POST", body: { characters: [{ id: "c1" }] } },
        submitLabel: "保存角色",
        confirmRequired: true,
      },
      onFormSubmit: (card, values) => calls.push({ card: card as { title: string }, values }),
    }),
  );
  await tick();
  const t = mount.textContent ?? "";
  expect(t).toContain("编辑角色「林墨」");
  expect(t).toContain("当前状态");
  expect(t).toContain("需确认");
  // 受控表单初始值来自 card.fields[].value：验证渲染后 DOM 值正确（text/textarea/select 三类）
  const statusInput = mount.querySelector("input.bc-form-input") as HTMLInputElement;
  const motivationInput = mount.querySelector("textarea.bc-form-input") as HTMLTextAreaElement;
  const genderSelect = mount.querySelector("select.bc-form-input") as HTMLSelectElement;
  expect(statusInput?.value).toBe("调查中");
  expect(motivationInput?.value).toBe("查明真相");
  expect(genderSelect?.value).toBe("男");
  // 提交按钮点击 → onFormSubmit 携带受控初始值（happy-dom 下 React 的 input 合成事件不触发，
  // 故无法模拟「键入后提交新值」；值变换核心逻辑由 flattenFormValues 纯函数单测覆盖（见下））
  const submitBtn = [...mount.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("保存角色"));
  expect(submitBtn).toBeTruthy();
  submitBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  expect(calls.length).toBe(1);
  expect(calls[0].values.status).toBe("调查中");
  expect(calls[0].values.motivation).toBe("查明真相");
  expect(calls[0].values.gender).toBe("男");
  root.unmount();
});

test("form 提交值变换（flattenFormValues 纯函数）：点路径扁平化 / textarea 数组拆分 / number 转换 / bool 转换", () => {
  // 与 src/api/brain-chat.ts flattenFormValues 对齐：field.key 支持点路径，array 字段按行拆分，transform:"bool" 转布尔
  const flat = flattenFormValues(
    [
      { key: "setting.time", label: "时代", type: "text", value: "唐朝" },
      { key: "rules", label: "规则", type: "textarea", value: "a\nb", array: true },
      { key: "chapterGen.1.temperature", label: "温度", type: "number", value: "0.7" },
      { key: "autoGacha", label: "自动抽卡", type: "select", value: "开", transform: "bool" },
    ],
    { "setting.time": "宋朝", rules: "规则一\n规则二", "chapterGen.1.temperature": "0.9", autoGacha: "开" },
  );
  expect(flat).toEqual({
    setting: { time: "宋朝" },
    rules: ["规则一", "规则二"],
    chapterGen: { 1: { temperature: 0.9 } },
    autoGacha: true,
  });
  // 空字符串数字字段跳过（未修改语义）；bool 假值
  const flat2 = flattenFormValues(
    [{ key: "count", label: "数", type: "number", value: "1" }, { key: "enabled", label: "启用", type: "select", value: "关", transform: "bool" }],
    { count: "", enabled: "关" },
  );
  expect(flat2).toEqual({ enabled: false });
});

test("form 卡：required 字段为空时阻止提交", async () => {
  let submitted = false;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: {
        kind: "form",
        title: "新增伏笔",
        fields: [{ key: "text", label: "伏笔内容", type: "textarea", required: true }],
        action: { endpoint: "/api/novel/foreshadow", method: "POST", body: { action: "add" } },
        submitLabel: "登记伏笔",
      },
      onFormSubmit: () => { submitted = true; },
    }),
  );
  await tick();
  const submitBtn = [...mount.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("登记伏笔"));
  submitBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  expect(submitted).toBe(false); // required 未填 → 不提交
  root.unmount();
});

test("form 卡：无字段（纯确认操作）渲染说明文案", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: {
        kind: "form",
        title: "确认草稿入册",
        fields: [],
        action: { endpoint: "/api/novel/chapter/confirm", method: "POST", body: {} },
        submitLabel: "确认入册",
        confirmRequired: true,
      },
      onFormSubmit: () => {},
    }),
  );
  await tick();
  expect(mount.textContent ?? "").toContain("无需填写字段");
  root.unmount();
});

// —— Phase 3：卡片完成态（completed：preview/form/confirm 已执行后禁用并显示完成标记，防重复提交） ——

test("preview 卡 completed：显示 ✓ 已执行，不再渲染执行按钮", async () => {
  let executed = false;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: {
        kind: "preview",
        title: "推进剧情（写一章）",
        commandId: "CMD-N02",
        level: "L2",
        summary: "将影响已写内容",
        confirmRequired: true,
        action: { endpoint: "/api/novel/step", method: "POST", body: {} },
      },
      onExecute: () => { executed = true; },
      completed: true,
    }),
  );
  await tick();
  const t = mount.textContent ?? "";
  expect(t).toContain("已执行");
  // 原按钮文案「执行」不再出现，确认标记「需确认」也隐藏
  const btns = [...mount.querySelectorAll("button")].map((b) => b.textContent ?? "");
  expect(btns).not.toContain("执行");
  expect(t).not.toContain("需确认");
  // 完成态卡片点击不到执行按钮（无按钮可点）
  expect(mount.querySelector("button")).toBeNull();
  expect(executed).toBe(false);
  root.unmount();
});

test("confirm 卡 completed：显示 ✓ 已处理，三选一按钮不再渲染", async () => {
  let chosen = false;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: {
        kind: "confirm",
        title: "推进剧情 · 确认",
        level: "L2",
        impact: "影响 2 个已写章节",
        options: ["merge", "rewrite", "abort"],
      },
      onConfirmChoose: () => { chosen = true; },
      completed: true,
    }),
  );
  await tick();
  const t = mount.textContent ?? "";
  expect(t).toContain("已处理");
  expect(t).not.toContain("正向弥合");
  expect(mount.querySelector("button")).toBeNull();
  expect(chosen).toBe(false);
  root.unmount();
});

test("form 卡 completed：提交按钮替换为 ✓ 已执行，无法再提交", async () => {
  let submitted = false;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(
    React.createElement(BrainCardView, {
      card: {
        kind: "form",
        title: "编辑设定",
        fields: [{ key: "premise", label: "梗概", type: "textarea" }],
        action: { endpoint: "/api/novel/world", method: "POST", body: {} },
        submitLabel: "保存",
      },
      onFormSubmit: () => { submitted = true; },
      completed: true,
    }),
  );
  await tick();
  const t = mount.textContent ?? "";
  expect(t).toContain("已执行");
  expect(t).not.toContain("保存");
  expect(mount.querySelector("button")).toBeNull();
  expect(submitted).toBe(false);
  root.unmount();
});

test("媒体 form 卡：切换章节/张数选项后提示文案实时更新", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  const mediaForm = {
    kind: "form" as const,
    title: "生成章节插画",
    commandId: "CMD-M02",
    level: "L0" as const,
    summary: "为「第 1 章」生成 1 张插画：提交后 AI 先从正文挑选关键场景，确认后开始生成（未指定章节时默认选中章节，可改）",
    fields: [
      { key: "chapterIndex", label: "章节", type: "select" as const, value: 1, options: [
        { label: "第 1 章 · 跪尸巷", value: "1" },
        { label: "第 2 章 · 梦引", value: "2" },
      ]},
      { key: "count", label: "张数（1-3）", type: "number" as const, value: 1 },
    ],
    action: { endpoint: "/api/novel/media/plan", method: "POST", body: { title: "书", kind: "image" } },
    submitLabel: "挑选场景并生成",
  };
  root.render(React.createElement(BrainCardView, { card: mediaForm, onFormSubmit: () => {} }));
  await tick();
  let t = mount.textContent ?? "";
  // 初始文案：默认第 1 章 / 1 张
  expect(t).toContain("为「第 1 章 · 跪尸巷」生成 1 张插画");
  // 切换章节 select → 文案实时更新（React 受控 select 需原生 value setter）
  const select = mount.querySelector("select") as HTMLSelectElement | null;
  expect(select).not.toBeNull();
  Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value")!.set!.call(select, "2");
  select!.dispatchEvent(new win.Event("change", { bubbles: true }));
  await tick();
  t = mount.textContent ?? "";
  expect(t).toContain("为「第 2 章 · 梦引」生成 1 张插画");
  expect(t).not.toContain("为「第 1 章 · 跪尸巷」生成");
  root.unmount();
  // 张数影响文案（happy-dom 受控 number input 事件受限，用初始值渲染验证动态计算）
  const m2 = document.createElement("div");
  document.body.appendChild(m2);
  const r2: Root = createRoot(m2);
  r2.render(React.createElement(BrainCardView, {
    card: { ...mediaForm, fields: [
      { key: "chapterIndex", label: "章节", type: "select" as const, value: 2, options: [
        { label: "第 1 章 · 跪尸巷", value: "1" },
        { label: "第 2 章 · 梦引", value: "2" },
      ]},
      { key: "count", label: "张数（1-3）", type: "number" as const, value: 3 },
    ] },
    onFormSubmit: () => {},
  }));
  await tick();
  t = m2.textContent ?? "";
  expect(t).toContain("为「第 2 章 · 梦引」生成 3 张插画");
  r2.unmount();
});

test("preview 卡：异步任务状态（生成中/失败/完成）就地呈现", async () => {
  const base = {
    kind: "preview" as const,
    title: "生成第 1 章插画（1 张）",
    commandId: "CMD-M02",
    level: "L0" as const,
    summary: "已从第 1 章正文挑选 1 个关键场景，确认后开始生成。",
    action: { endpoint: "/api/novel/media/generate", method: "POST" as const, body: { chapterIndex: 1, kind: "image" } },
    cardId: "pv-1",
  };
  // running：显示「生成中」+ 按钮禁用
  const m1 = document.createElement("div");
  document.body.appendChild(m1);
  const r1: Root = createRoot(m1);
  r1.render(React.createElement(BrainCardView, { card: { ...base, status: "running" as const, detail: "生成任务已提交，正在生成…" }, onExecute: () => {} }));
  await tick();
  let t = m1.textContent ?? "";
  expect(t).toContain("生成中");
  expect(t).toContain("生成任务已提交");
  expect((m1.querySelector("button") as HTMLButtonElement | null)?.disabled).toBe(true);
  r1.unmount();
  // failed：显示「生成失败」+ 按钮保留（可重试）
  const m2 = document.createElement("div");
  document.body.appendChild(m2);
  const r2: Root = createRoot(m2);
  r2.render(React.createElement(BrainCardView, { card: { ...base, status: "failed" as const, detail: "生图失败：429" }, onExecute: () => {} }));
  await tick();
  t = m2.textContent ?? "";
  expect(t).toContain("生成失败");
  expect(t).toContain("生图失败：429");
  expect((m2.querySelector("button") as HTMLButtonElement | null)?.disabled).toBe(false);
  r2.unmount();
  // done：显示「已完成」
  const m3 = document.createElement("div");
  document.body.appendChild(m3);
  const r3: Root = createRoot(m3);
  r3.render(React.createElement(BrainCardView, { card: { ...base, status: "done" as const, detail: "已完成 1 项" }, onExecute: () => {} }));
  await tick();
  t = m3.textContent ?? "";
  expect(t).toContain("已完成");
  r3.unmount();
});

test("form 卡 onValuesChange：初始上报默认值，切换 select 后上报新值（驱动消息正文跟随选项）", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  const reported: Record<string, unknown>[] = [];
  const mediaForm = {
    kind: "form" as const,
    title: "生成章节插画",
    commandId: "CMD-M02",
    level: "L0" as const,
    summary: "为「第 1 章」生成 1 张插画",
    fields: [
      { key: "chapterIndex", label: "章节", type: "select" as const, value: 1, options: [
        { label: "第 1 章 · 跪尸巷", value: "1" },
        { label: "第 2 章 · 梦引", value: "2" },
      ]},
      { key: "count", label: "张数（1-3）", type: "number" as const, value: 1 },
    ],
    action: { endpoint: "/api/novel/media/plan", method: "POST", body: { title: "书", kind: "image" } },
    submitLabel: "挑选场景并生成",
  };
  root.render(React.createElement(BrainCardView, { card: mediaForm, onFormSubmit: () => {}, onFormValuesChange: (v) => reported.push({ ...v }) }));
  await tick();
  // 初始不上报（父组件用卡字段默认值兜底；无 effect 时序依赖）
  expect(reported.length).toBe(0);
  // 切换章节 select → 同步上报新值（消息正文据此实时更新）
  const select = mount.querySelector("select") as HTMLSelectElement | null;
  expect(select).not.toBeNull();
  Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value")!.set!.call(select, "2");
  select!.dispatchEvent(new win.Event("change", { bubbles: true }));
  await tick();
  expect(reported.length).toBe(1);
  expect(reported[0]).toEqual({ chapterIndex: "2", count: 1 });
  root.unmount();
});

test("preview 卡：分镜完成待自动生成态（场景列表 + 倒计时 + 立即生成）", async () => {
  const base = {
    kind: "preview" as const,
    title: "生成第 1 章插画（2 张）",
    commandId: "CMD-M02",
    level: "L0" as const,
    summary: "已从第 1 章正文挑选 2 个关键场景，3 秒后自动生成。",
    cardId: "pv-scenes",
    scenes: [
      { anchor: "沈夜负剑立于城楼，眺望远方", scene: "月色城楼，沈夜负剑而立", caption: "沈夜夜登城楼" },
      { anchor: "柳青霜提灯而来", scene: "柳青霜提灯递信", caption: "柳青霜递信" },
    ],
    countdownAt: Date.now() + 3000,
    action: { endpoint: "/api/novel/media/generate", method: "POST" as const, body: { chapterIndex: 1, kind: "image", scenes: [] } },
    actionLabel: "立即生成",
  };
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(React.createElement(BrainCardView, { card: base, onExecute: () => {} }));
  await tick();
  const t = mount.textContent ?? "";
  // 选中的分镜场景呈现给用户（caption + anchor）
  expect(t).toContain("沈夜夜登城楼");
  expect(t).toContain("沈夜负剑立于城楼，眺望远方");
  expect(t).toContain("柳青霜递信");
  // 倒计时 + 立即生成按钮
  expect(t).toContain("倒计时");
  const btn = mount.querySelector("button") as HTMLButtonElement | null;
  expect(btn?.textContent).toContain("立即生成");
  root.unmount();
});

test("preview 卡：生成完成 → 「查看插画」按钮回调跳转章节", async () => {
  const base = {
    kind: "preview" as const,
    title: "生成第 2 章插画（1 张）",
    commandId: "CMD-M02",
    level: "L0" as const,
    summary: "已完成",
    cardId: "pv-done",
    status: "done" as const,
    detail: "已完成 1 项",
    mediaId: "media-abc",
    chapterIndex: 2,
  };
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  const calls: Array<[number, string]> = [];
  root.render(React.createElement(BrainCardView, { card: base, onExecute: () => {}, onGoToMedia: (ch, mid) => calls.push([ch, mid]) }));
  await tick();
  const t = mount.textContent ?? "";
  expect(t).toContain("查看插画");
  (mount.querySelector("button") as HTMLButtonElement).click();
  await tick();
  expect(calls).toEqual([[2, "media-abc"]]);
  root.unmount();
});

test("媒体 form 卡：mediaQuota 动态张数下拉（切换章节后 options 跟随剩余额度）", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  // 第 1 章剩余 1 张、第 2 章剩余 3 张
  const quota = (ch: number) => (ch === 1 ? 1 : 3);
  const mediaForm = {
    kind: "form" as const,
    title: "生成章节插画",
    commandId: "CMD-M02",
    level: "L0" as const,
    summary: "为「第 1 章」生成 1 张插画",
    fields: [
      { key: "chapterIndex", label: "章节", type: "select" as const, value: 1, options: [
        { label: "第 1 章", value: "1" },
        { label: "第 2 章", value: "2" },
      ]},
      { key: "count", label: "张数", type: "select" as const, value: 1, options: [
        { label: "1 张", value: "1" }, { label: "2 张", value: "2" }, { label: "3 张", value: "3" },
      ]},
    ],
    action: { endpoint: "/api/novel/media/plan", method: "POST", body: { title: "书", kind: "image" } },
    submitLabel: "挑选场景并生成",
  };
  root.render(React.createElement(BrainCardView, { card: mediaForm, onFormSubmit: () => {}, mediaQuota: quota }));
  await tick();
  const selects = mount.querySelectorAll("select") as NodeListOf<HTMLSelectElement>;
  expect(selects.length).toBe(2);
  const countSelect = selects[1];
  // 第 1 章：剩余 1 张 → 仅「1 张」选项 + label 显示剩余
  expect(countSelect.options.length).toBe(1);
  expect(countSelect.options[0].value).toBe("1");
  expect(mount.textContent ?? "").toContain("还可生成 1 张");
  // 切换章节到第 2 章 → 剩余 3 张 → 选项变为 1/2/3
  Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value")!.set!.call(selects[0], "2");
  selects[0]!.dispatchEvent(new win.Event("change", { bubbles: true }));
  await tick();
  expect(countSelect.options.length).toBe(3);
  expect(mount.textContent ?? "").toContain("还可生成 3 张");
  root.unmount();
});

test("媒体 form 卡：WS/world 更新额度后扩展选项，并把超额旧值收敛到新额度", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  let remaining = 3;
  const reported: Record<string, unknown>[] = [];
  const mediaForm = {
    kind: "form" as const,
    title: "生成章节插画",
    fields: [
      { key: "chapterIndex", label: "章节", type: "select" as const, value: 1, options: [{ label: "第 1 章", value: "1" }] },
      { key: "count", label: "张数", type: "select" as const, value: 3, options: [
        { label: "1 张", value: "1" }, { label: "2 张", value: "2" }, { label: "3 张", value: "3" },
      ] },
    ],
    action: { endpoint: "/api/novel/media/plan", method: "POST", body: { title: "书", kind: "image" } },
  };
  const render = () => root.render(React.createElement(BrainCardView, {
    card: mediaForm,
    onFormSubmit: () => {},
    onFormValuesChange: (v) => reported.push({ ...v }),
    mediaQuota: () => remaining,
  }));
  render();
  await tick();
  let count = mount.querySelectorAll("select")[1] as HTMLSelectElement;
  expect(count.options.length).toBe(3);
  expect(count.value).toBe("3");

  remaining = 1;
  render();
  await tick();
  count = mount.querySelectorAll("select")[1] as HTMLSelectElement;
  expect(count.options.length).toBe(1);
  expect(count.value).toBe("1");
  expect(reported.at(-1)?.count).toBe(1);

  remaining = 2;
  render();
  await tick();
  expect((mount.querySelectorAll("select")[1] as HTMLSelectElement).options.length).toBe(2);
  root.unmount();
});
