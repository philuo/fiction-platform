// MarkdownView 渲染测试：文本/表格/图片/列表 + 流式增量（未闭合表格容错）
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownView } from "../src/components/MarkdownView";

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

function render(text: string): { root: Root; mount: HTMLElement } {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  root.render(<MarkdownView text={text} />);
  return { root, mount };
}

test("文本段落 + 粗体渲染", async () => {
  const { root, mount } = render("**中枢**回复了\n\n第二段");
  await tick();
  expect(mount.querySelector("strong")?.textContent).toBe("中枢");
  expect(mount.querySelectorAll("p").length).toBe(2);
  root.unmount();
});

test("表格渲染（remark-gfm）", async () => {
  const { root, mount } = render("| 角色 | 状态 |\n| --- | --- |\n| 林墨 | 调查中 |");
  await tick();
  const table = mount.querySelector("table");
  expect(table).toBeTruthy();
  expect(mount.querySelectorAll("th").length).toBe(2);
  expect(mount.querySelector("td")?.textContent).toBe("林墨");
  root.unmount();
});

test("图片渲染为 <img>（alt/loading 属性）", async () => {
  const { root, mount } = render("![封面](https://x.test/a.png)");
  await tick();
  const img = mount.querySelector("img");
  expect(img).toBeTruthy();
  expect(img?.getAttribute("src")).toBe("https://x.test/a.png");
  expect(img?.getAttribute("alt")).toBe("封面");
  expect(img?.getAttribute("loading")).toBe("lazy");
  root.unmount();
});

test("列表渲染", async () => {
  const { root, mount } = render("- 方案 A\n- 方案 B");
  await tick();
  expect(mount.querySelectorAll("li").length).toBe(2);
  root.unmount();
});

test("流式增量容错：未闭合表格不抛错", async () => {
  const partial = "| 角色 | 状态 |\n| --- | --- |\n| 林墨 |"; // 表格行未闭合（生成中途）
  const { root, mount } = render(partial);
  await tick();
  expect(() => mount.querySelector("table")).not.toThrow();
  root.unmount();
});

test("空文本不渲染", async () => {
  const { root, mount } = render("   ");
  await tick();
  expect(mount.childElementCount).toBe(0);
  root.unmount();
});
