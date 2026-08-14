import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { emptyWorld } from "../src/api/world";
import { RelationshipModal } from "../src/components/RelationshipModal";

let win: Window;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  win = new Window({ url: "http://localhost/" });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.navigator = win.navigator as unknown as Navigator;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  win.happyDOM.close();
});

test("relationship panel can open directly on the read-only graph tab", async () => {
  const world = emptyWorld();
  world.characters = [
    { id: "c1", name: "林墨", role: "主角", traits: [], motivation: "调查", status: "在场", introducedAt: 1, relations: { 沈夜: "宿敌" } },
    { id: "c2", name: "沈夜", role: "反派", traits: [], motivation: "阻止调查", status: "在场", introducedAt: 1, relations: { 林墨: "宿敌" } },
  ];
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);

  await act(() => root.render(React.createElement(RelationshipModal, {
    world,
    readOnly: true,
    initialTab: "关系图",
    onClose: () => {},
  })));

  const tabs = [...mount.querySelectorAll(".panel-tab")];
  expect(tabs.find((tab) => tab.textContent === "关系图")?.classList.contains("active")).toBe(true);
  expect(mount.querySelector('[role="img"][aria-label="人物关系只读图"]')).not.toBeNull();
  expect(mount.textContent).not.toContain("新增连线");
  expect(mount.textContent).not.toContain("保存关系到世界");

  await act(() => root.unmount());
  mount.remove();
});

test("manual relationship entry still defaults to the character tab", async () => {
  const world = emptyWorld();
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);

  await act(() => root.render(React.createElement(RelationshipModal, {
    world,
    readOnly: false,
    onClose: () => {},
  })));

  const tabs = [...mount.querySelectorAll(".panel-tab")];
  expect(tabs.find((tab) => tab.textContent === "角色")?.classList.contains("active")).toBe(true);
  expect(mount.querySelector('[role="img"][aria-label="人物关系只读图"]')).toBeNull();

  await act(() => root.unmount());
  mount.remove();
});
