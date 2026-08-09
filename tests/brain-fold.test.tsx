// 中枢聊天折叠与写作进度卡回归：
// 1) isCollapsibleMsg / msgCollapseSummary：任务/指令类消息可折叠、摘要正确（纯函数，不依赖 DOM）
// 2) ProgressCardView：running 显示阶段步骤条+流式正文+中断按钮；done 显示完成标记
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { isCollapsibleMsg, msgCollapseSummary, completedItemIdsOf, actionItemId, guardAction } from "../src/components/BrainCabin";
import { BrainCardView, type ProgressCard } from "../src/components/brain-cards";
import type { ChatMessage } from "../src/components/useBrainSession";

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

const brainMsg = (cards: ChatMessage["cards"]): ChatMessage => ({
  id: "m1", role: "brain", text: "开场回复", cards, at: new Date().toISOString(),
});

test("isCollapsibleMsg：含任务/指令类卡（preview/confirm/form/plan/opinion/result）的消息可折叠；纯文本/纯浏览不可折叠；用户消息不可折叠", () => {
  expect(isCollapsibleMsg(brainMsg([{ kind: "preview", title: "推进剧情", summary: "x", action: { endpoint: "/api/novel/step", method: "POST", body: {} } }]))).toBe(true);
  expect(isCollapsibleMsg(brainMsg([{ kind: "result", title: "已保存", success: true, detail: "ok" }]))).toBe(true);
  expect(isCollapsibleMsg(brainMsg([{ kind: "browse", title: "章节", browseType: "chapter", data: {} }]))).toBe(false);
  expect(isCollapsibleMsg(brainMsg([]))).toBe(false);
  expect(isCollapsibleMsg({ id: "u1", role: "user", text: "你好", at: new Date().toISOString() })).toBe(false);
});

test("msgCollapseSummary：优先取第一条卡 title，缺省回退卡片 kind / 文本首行", () => {
  expect(msgCollapseSummary(brainMsg([{ kind: "preview", title: "推进剧情（写一章）", summary: "x", action: { endpoint: "/api/novel/step", method: "POST", body: {} } }]))).toBe("推进剧情（写一章）");
  expect(msgCollapseSummary(brainMsg([{ kind: "result", title: "", success: true, detail: "ok" }]))).toBe("result");
  expect(msgCollapseSummary(brainMsg([]))).toBe("开场回复");
});

test("completedItemIdsOf：按 msgId:cardIndex 前缀提取某卡已完成的 itemId 集合", () => {
  const set = new Set(["m1:0", "m1:0:cp1", "m1:0:cp2", "m2:3:cp9", "m1:1:x"]);
  expect(completedItemIdsOf(set, "m1", 0)).toEqual(new Set(["cp1", "cp2"]));
  expect(completedItemIdsOf(set, "m1", 1)).toEqual(new Set(["x"]));
  expect(completedItemIdsOf(set, "m1", 2)).toEqual(new Set());
});

test("actionItemId：proposal/tasks/gacha 单卡提取 item id；gacha 全部应用等无 item 返回 undefined", () => {
  expect(actionItemId({ proposalId: "cp1", action: "confirm" })).toBe("cp1");
  expect(actionItemId({ id: "d5", action: "fix" })).toBe("d5");
  expect(actionItemId({ pick: ["c7"], action: "apply" })).toBe("c7");
  expect(actionItemId({ action: "apply", auto: true })).toBeUndefined();
  expect(actionItemId({})).toBeUndefined();
});

test("guardAction：系统忙（executing/streaming）与写作运行中均拦截写操作", () => {
  const act = { endpoint: "/api/novel/world", body: { premise: "x" } };
  expect(guardAction(act, {})).toBeNull(); // 空闲放行
  expect(guardAction(act, { executing: true })).toContain("正在运行");
  expect(guardAction(act, { streaming: true })).toContain("正在运行");
  expect(guardAction(act, { writingRunning: true })).toContain("写作任务进行中");
  // 空闲 + 资源校验正常 → 放行
  const w = { characterProposals: [{ id: "cp1", status: "pending" }], pendingCards: [{ id: "c1" }], qualityDebt: [{ id: "d1", status: "open" }] };
  expect(guardAction({ endpoint: "/api/novel/proposal", body: { proposalId: "cp1" } }, { world: w })).toBeNull();
});

test("guardAction：目标资源存在性校验（proposal / gacha / debt 已消耗则拦截）", () => {
  const w = {
    characterProposals: [{ id: "cp1", status: "pending" }, { id: "cp2", status: "confirmed" }],
    pendingCards: [{ id: "c1" }],
    qualityDebt: [{ id: "d1", status: "open" }, { id: "d2", status: "ignored" }],
  };
  // proposal：pending 放行；confirmed/不存在/缺 id 拦截
  expect(guardAction({ endpoint: "/api/novel/proposal", body: { proposalId: "cp1" } }, { world: w })).toBeNull();
  expect(guardAction({ endpoint: "/api/novel/proposal", body: { proposalId: "cp2" } }, { world: w })).toContain("已处理");
  expect(guardAction({ endpoint: "/api/novel/proposal", body: { proposalId: "cp9" } }, { world: w })).toContain("已处理");
  expect(guardAction({ endpoint: "/api/novel/proposal", body: {} }, { world: w })).toContain("缺少提案标识");
  // gacha：单卡在池放行；不在池拦截；auto 且卡池空拦截
  expect(guardAction({ endpoint: "/api/novel/gacha", body: { action: "apply", pick: ["c1"] } }, { world: w })).toBeNull();
  expect(guardAction({ endpoint: "/api/novel/gacha", body: { action: "apply", pick: ["c9"] } }, { world: w })).toContain("不在卡池");
  expect(guardAction({ endpoint: "/api/novel/gacha", body: { action: "apply", auto: true } }, { world: { ...w, pendingCards: [] } })).toContain("卡池已空");
  expect(guardAction({ endpoint: "/api/novel/gacha", body: { action: "generate" } }, { world: w })).toBeNull(); // 非 apply 放行
  // debt：open 放行；ignored/不存在/缺 id 拦截
  expect(guardAction({ endpoint: "/api/novel/debt", body: { id: "d1" } }, { world: w })).toBeNull();
  expect(guardAction({ endpoint: "/api/novel/debt", body: { id: "d2" } }, { world: w })).toContain("已处理");
  expect(guardAction({ endpoint: "/api/novel/debt", body: { id: "d9" } }, { world: w })).toContain("已处理");
  expect(guardAction({ endpoint: "/api/novel/debt", body: {} }, { world: w })).toContain("缺少质量债标识");
});

test("ProgressCardView：running 显示阶段步骤条 + 流式正文 + 中断按钮", async () => {
  const card: ProgressCard = { kind: "progress", title: "推进剧情", phase: "delta", text: "林墨走入夜色中…", status: "running" };
  let cancelled = false;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(React.createElement(BrainCardView, { card, onCancelProgress: () => { cancelled = true; } }));
  await tick();
  const t = mount.textContent ?? "";
  expect(t).toContain("推进剧情");
  expect(t).toContain("写作"); // 阶段步骤条
  expect(t).toContain("林墨走入夜色中…"); // 流式正文
  const cancelBtn = [...mount.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("中断写作"));
  expect(cancelBtn).toBeTruthy();
  cancelBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  expect(cancelled).toBe(true);
  root.unmount();
});

test("ProgressCardView：done 显示完成标记，无中断按钮", async () => {
  const card: ProgressCard = { kind: "progress", title: "推进剧情", phase: "result", text: "", status: "done", detail: "第 4 章《夜探》已完成" };
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(React.createElement(BrainCardView, { card }));
  await tick();
  const t = mount.textContent ?? "";
  expect(t).toContain("已完成");
  expect(t).toContain("第 4 章《夜探》已完成");
  expect(mount.querySelector("button")).toBeNull();
  root.unmount();
});
