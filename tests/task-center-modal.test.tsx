import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TaskCenterModal } from "../src/components/TaskCenterModal";
import type { AutoSessionView } from "../src/components/AutoRunPanel";

let win: Window;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  win = new Window({ url: "http://localhost/" });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.navigator = win.navigator;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  win.happyDOM.close();
});

test("running restored auto session keeps pause/cancel controls without a local SSE reader", async () => {
  const session: AutoSessionView = {
    status: "running",
    target: 1,
    written: 0,
    phase: "第 1 章重试中（上一稿审查未过）",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  await act(() => root.render(React.createElement(TaskCenterModal, {
    title: "恢复控制测试",
    session,
    pending: null,
    advancePhase: "",
    advanceBusy: false,
    buildingStage: null,
    pendingCommitIdx: null,
    onClose: () => {}, onPause: () => {}, onResume: () => {}, onRemove: () => {},
    onCancelAdvance: () => {}, onConfirmPending: () => {}, onRejectPending: () => {}, onOpenAutoPanel: () => {},
  })));
  expect([...mount.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(expect.arrayContaining(["暂停", "取消任务"]));
  expect(mount.textContent).toContain("第 1 章重试中");
  await act(() => root.unmount());
  mount.remove();
});
