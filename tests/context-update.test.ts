// 左栏「脉络」随章节操作更新的回归测试（客户端渲染层）
// 覆盖：切换章节 / 内容变更 / 删除章节 后，脉络「出场角色」必须跟随当前章节与最新 world 刷新
import { test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { LeftPanel } from "../src/components/LeftPanel";
import type { WorldState, Character, Chapter } from "../src/api/world";

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

const mkChar = (id: string, name: string): Character =>
  ({ id, name, role: "配角", traits: [], motivation: "", secret: "", status: "", relations: {}, voice: "", introducedAt: 1 }) as Character;

const mkCh = (index: number, title: string, text: string): Chapter =>
  ({ index, title, text, review: null, versions: [], media: [] }) as Chapter;

const mkWorld = (): WorldState =>
  ({
    title: "脉络更新回归",
    genre: "",
    premise: "",
    setting: { time: "", place: "", rules: [], tone: "" },
    characters: [mkChar("c1", "沈青梧"), mkChar("c2", "魏无踪"), mkChar("c3", "温雪见")],
    foreshadowing: [],
    timeline: [],
    chapters: [mkCh(1, "第一章", "沈青梧在城中巡夜。"), mkCh(2, "第二章", "魏无踪出现在酒馆。"), mkCh(3, "第三章", "温雪见在医馆问诊。")],
    cards: [],
    outline: [],
    nextChapter: 4,
  }) as WorldState;

/** 渲染 LeftPanel 并切换到「脉络」tab，返回容器 */
async function mountContextTab(world: WorldState, activeChapter: number, onSelectChapter?: (i: number) => void) {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  await act(() => {
    root.render(
      React.createElement(LeftPanel, {
        world,
        activeChapter,
        onSelectChapter: onSelectChapter ?? (() => {}),
      }),
    );
  });
  const btn = [...mount.querySelectorAll(".panel-tab")].find((b) => b.textContent === "脉络");
  expect(btn).toBeTruthy();
  await act(() => {
    btn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  return { mount, root };
}

const text = (mount: HTMLElement) => mount.textContent ?? "";

test("切换章节后脉络出场角色跟随新章节", async () => {
  const { mount, root } = await mountContextTab(mkWorld(), 1);
  expect(text(mount)).toContain("沈青梧");
  expect(text(mount)).not.toContain("魏无踪");

  await act(() => {
    root.render(React.createElement(LeftPanel, { world: mkWorld(), activeChapter: 2, onSelectChapter: () => {} }));
  });
  expect(text(mount)).toContain("魏无踪");
  expect(text(mount)).not.toContain("沈青梧");

  root.unmount();
  mount.remove();
});

test("章节内容变更后脉络出场角色跟随新正文", async () => {
  const { mount, root } = await mountContextTab(mkWorld(), 1);
  expect(text(mount)).toContain("沈青梧");

  const edited = { ...mkWorld(), chapters: mkWorld().chapters.map((c) => (c.index === 1 ? { ...c, text: "温雪见在药铺独自看诊。" } : c)) };
  await act(() => {
    root.render(React.createElement(LeftPanel, { world: edited, activeChapter: 1, onSelectChapter: () => {} }));
  });
  expect(text(mount)).toContain("温雪见");
  expect(text(mount)).not.toContain("沈青梧");

  root.unmount();
  mount.remove();
});

test("删除章节后脉络跟随回退章节（不再显示被删章角色）", async () => {
  const { mount, root } = await mountContextTab(mkWorld(), 2);
  expect(text(mount)).toContain("魏无踪");

  // 模拟 deleteChapter 后 world 移除第 2 章、activeIdx 回退到第 1 章（Home.confirmDeleteChapter 行为）
  const afterDelete = { ...mkWorld(), chapters: mkWorld().chapters.filter((c) => c.index !== 2) };
  await act(() => {
    root.render(React.createElement(LeftPanel, { world: afterDelete, activeChapter: 1, onSelectChapter: () => {} }));
  });
  expect(text(mount)).toContain("沈青梧");
  expect(text(mount)).not.toContain("魏无踪");

  root.unmount();
  mount.remove();
});
