import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { emptyWorld, type WorldState } from "../src/api/world";
import { ForeshadowModal } from "../src/components/ForeshadowModal";

let win: Window;
const originalFetch = globalThis.fetch;
const requests: { action?: string; id?: string }[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  win = new Window({ url: "http://localhost/" });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.navigator = win.navigator as unknown as Navigator;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  win.happyDOM.close();
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("已回收伏笔需要可达的二次确认后才调用删除接口", async () => {
  const world: WorldState = emptyWorld();
  world.title = "foreshadow-modal-test";
  world.nextChapter = 2;
  world.foreshadowing = [{ id: "fs-1", text: "午夜少敲一次", plantedAt: 1, resolvedAt: 1, status: "resolved" }];
  requests.length = 0;
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as { action?: string; id?: string });
    return new Response(JSON.stringify({ ok: true, foreshadowing: [], world: { ...world, foreshadowing: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  await act(() => {
    root.render(React.createElement(ForeshadowModal, {
      world,
      onClose: () => {},
      onWorldUpdate: () => {},
      showToast: () => {},
    }));
  });

  const button = () => [...mount.querySelectorAll("button")].find((item) => /删除/.test(item.textContent ?? ""));
  expect(button()?.textContent).toContain("删除");
  await act(() => button()!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true })));
  expect(button()?.textContent).toContain("确认删除？");
  expect(requests).toHaveLength(0);

  await act(async () => {
    button()!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();
  });
  expect(requests).toEqual([{ title: world.title, action: "delete", id: "fs-1" }]);

  await act(() => root.unmount());
  mount.remove();
});
