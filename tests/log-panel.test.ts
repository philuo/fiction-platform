// 操作日志面板（MemoryAuditModal）中枢字段渲染回归
// 覆盖：commandId 徽章（含指令名 title）、level 徽章（L0-L3 文本）、reason 中枢结论行
// 说明：MemoryAuditModal 是交互式弹窗，操作日志内容仅在「操作日志」tab 内渲染，
// 因此需真实挂载 + 点击 tab 后再断言（SSR 静态渲染无法覆盖交互态）。
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { MemoryAuditModal } from "../src/components/MemoryAuditModal";
import { emptyWorld, type ChangeLogEntry, type WorldState } from "../src/api/world";

let win: Window;
const origFetch = globalThis.fetch;
beforeAll(() => {
  win = new Window({ url: "http://localhost/" });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.navigator = win.navigator as unknown as Navigator;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  // 组件挂载时 fetch /api/novel/changelog 拉权威日志；测试返回无 entries 的空对象，
  // 使组件保持 world.changeLog 初始快照（entries 字段缺失时 Array.isArray 为 false，不覆盖）
  globalThis.fetch = (async () => ({ json: async () => ({}) })) as unknown as typeof fetch;
});
afterAll(() => {
  // 恢复全局 fetch：bun test 默认同进程并发跑文件，永久覆盖会污染其他测试文件（如 agnes 重试测试）
  globalThis.fetch = origFetch;
});

function mkWorld(entries: ChangeLogEntry[]): WorldState {
  const w = emptyWorld();
  w.title = "log-panel-test";
  w.changeLog = entries;
  return w;
}

/** 挂载 MemoryAuditModal 并切换到「操作日志」tab，返回容器 */
async function mountLogTab(world: WorldState) {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  await act(() => {
    root.render(React.createElement(MemoryAuditModal, { world, onClose: () => {} }));
  });
  const btn = [...mount.querySelectorAll(".mem-tab")].find((b) => b.textContent === "操作日志");
  expect(btn).toBeTruthy();
  await act(() => {
    btn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  return { mount, root };
}

const text = (mount: HTMLElement) => mount.textContent ?? "";

describe("操作日志面板中枢字段", () => {
  test("commandId 徽章渲染指令 ID 且 title 带指令名", async () => {
    const w = mkWorld([
      { at: "2026-01-01T00:00:00Z", chapter: 2, actor: "user", kind: "chapter-edit", detail: "编辑第 2 章", commandId: "CMD-N06", level: "L2" },
    ]);
    const { mount, root } = await mountLogTab(w);
    expect(text(mount)).toContain("CMD-N06");
    // 指令名渲染在徽章 title 属性（悬浮提示），用属性断言而非文本
    const badge = mount.querySelector(".mem-badge-cmd");
    expect(badge?.getAttribute("title")).toContain("手动编辑章节"); // getCommand("CMD-N06").name
    root.unmount();
    mount.remove();
  });

  test("level 徽章显示中文分级文案（L0/L1/L2/L3）", async () => {
    const w = mkWorld([
      { at: "2026-01-01T00:00:00Z", chapter: 1, actor: "user", kind: "chapter-delete", detail: "删章", commandId: "CMD-N08", level: "L3" },
    ]);
    const { mount, root } = await mountLogTab(w);
    expect(text(mount)).toContain("L3·不可逆");
    root.unmount();
    mount.remove();
  });

  test("reason 中枢结论行渲染", async () => {
    const w = mkWorld([
      { at: "2026-01-01T00:00:00Z", chapter: 1, actor: "brain", kind: "brain-review", detail: "章末审查", commandId: "CMD-L01", reason: "brain_unavailable" },
    ]);
    const { mount, root } = await mountLogTab(w);
    expect(text(mount)).toContain("中枢");
    expect(text(mount)).toContain("brain_unavailable");
    root.unmount();
    mount.remove();
  });

  test("actor=brain 显示「中枢」徽章", async () => {
    const w = mkWorld([
      { at: "2026-01-01T00:00:00Z", chapter: 1, actor: "brain", kind: "brain-gate", detail: "闸门" },
    ]);
    const { mount, root } = await mountLogTab(w);
    expect(text(mount)).toContain("中枢");
    root.unmount();
    mount.remove();
  });
});
