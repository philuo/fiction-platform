// 临时调试：隔离复现 form 卡 input 事件模拟
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
// ESM import（与正式测试一致）
import ReactEsm from "react";
import { createRoot as createRootEsm } from "react-dom/client";
import { BrainCardView as BrainCardViewEsm } from "../src/components/brain-cards";
// CJS require 对比
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
const ReactCjs = require2("react");
const { createRoot: createRootCjs } = require2("react-dom/client");
const { BrainCardView: BrainCardViewCjs } = require2("../src/components/brain-cards.tsx");

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

function runCase(tag: string, React: typeof ReactEsm, createRoot: typeof createRootEsm, Comp: unknown) {
  return new Promise<Record<string, unknown> | null>((resolve) => {
    const calls: { values: Record<string, unknown> }[] = [];
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const root = createRoot(mount);
    (root as { render: (n: unknown) => void }).render(Comp(calls));
    setTimeout(() => {
      const el = mount.querySelector("input.bc-form-input") as HTMLInputElement;
      const desc = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!;
      const ownDesc = Object.getOwnPropertyDescriptor(el, "value");
      console.log(tag, "instance own value desc:", ownDesc ? `own(get:${typeof ownDesc.get}, set:${typeof ownDesc.set})` : "none (prototype)");
      console.log(tag, "tracker before:", JSON.stringify((el as unknown as { _valueTracker?: { currentValue?: unknown } })._valueTracker));
      desc.set!.call(el, "负伤");
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      setTimeout(() => {
        const btn = [...mount.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("保存"))!;
        btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
        setTimeout(() => {
          console.log(tag, "->", JSON.stringify(calls));
          resolve(calls[0]?.values ?? null);
          root.unmount();
        }, 20);
      }, 20);
    }, 30);
  });
}

test("ESM vs CJS form input", async () => {
  const makeCompEsm = (calls: { values: Record<string, unknown> }[]) =>
    ReactEsm.createElement(BrainCardViewEsm, {
      card: { kind: "form", title: "T", fields: [{ key: "status", label: "状态", type: "text", value: "调查中" }], action: { endpoint: "/api/x", method: "POST", body: {} }, submitLabel: "保存" },
      onFormSubmit: (_c: unknown, values: Record<string, unknown>) => calls.push({ values }),
    });
  const makeCompCjs = (calls: { values: Record<string, unknown> }[]) =>
    ReactCjs.createElement(BrainCardViewCjs, {
      card: { kind: "form", title: "T", fields: [{ key: "status", label: "状态", type: "text", value: "调查中" }], action: { endpoint: "/api/x", method: "POST", body: {} }, submitLabel: "保存" },
      onFormSubmit: (_c: unknown, values: Record<string, unknown>) => calls.push({ values }),
    });
  // 1) CJS React + CJS 组件
  const r1 = await runCase("CJS React + CJS comp", ReactCjs, createRootCjs, makeCompCjs);
  // 2) ESM React + ESM 组件
  const r2 = await runCase("ESM React + ESM comp", ReactEsm, createRootEsm, makeCompEsm);
  console.log("RESULT CJS:", JSON.stringify(r1));
  console.log("RESULT ESM:", JSON.stringify(r2));
  expect(r1?.status).toBe("负伤");
});
