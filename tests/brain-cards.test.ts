// 中枢对话卡片（brain-cards）渲染回归：
// browse(proposal) 卡渲染推荐原因 + 确认/拒绝可交互按钮，点击回调携带正确 action
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrainCardView, type BrowseCard } from "../src/components/brain-cards";

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

test("form 卡：渲染字段（text/textarea/select）与提交按钮，提交携带填写值", async () => {
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
  const statusInput = mount.querySelector("input.bc-form-input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set;
  setter!.call(statusInput, "负伤");
  statusInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30)); // 等 React 19 并发调度 flush 受控值
  const submitBtn = [...mount.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("保存角色"));
  expect(submitBtn).toBeTruthy();
  submitBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  expect(calls.length).toBe(1);
  expect(calls[0].values.status).toBe("负伤");
  expect(calls[0].values.motivation).toBe("查明真相");
  root.unmount();
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
