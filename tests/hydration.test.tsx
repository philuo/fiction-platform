// SSR ↔ 客户端 hydrate 一致性回归（hydration mismatch 防护）：
// 用同一份 initialData 分别走 renderToString（服务端）与 hydrateRoot（客户端），
// 断言不产生 React hydration mismatch 警告。
// 背景：中枢 BrainCore 按 presence 渲染颜色/发光，若 SSR 与 client 首帧输入或代码
// 版本不一致（如旧 bundle 的 standby 色映射 #7a6f5e vs 新 #191817、weary 阈值漂移），
// 会报 "A tree hydrated but some attributes ... didn't match" 且不修复，事件失效。
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import Home from "../src/pages/Home";
import { emptyWorld, type WorldState, type QualityDebt } from "../src/api/world";

let win: Window;
const origFetch = globalThis.fetch;

beforeAll(() => {
  win = new Window({ url: "http://localhost/?title=hydration-test" });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.navigator = win.navigator as unknown as Navigator;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  // 挂载期各类 fetch（列表/提案区/恢复任务）一律返回空，避免依赖真实服务端
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ stories: [] }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
});

afterAll(() => {
  globalThis.fetch = origFetch;
  win.happyDOM.close();
});

const debt = (id: number, status: QualityDebt["status"], severity: QualityDebt["severity"]): QualityDebt =>
  ({ id: `d${id}`, chapterIndex: id, lens: "logic", issue: `质量债${id}`, status, severity }) as QualityDebt;

function mkWorld(openDebts: number): WorldState {
  const w = emptyWorld();
  w.title = "hydration-test";
  w.nextChapter = openDebts + 1;
  w.blueprint = {
    theme: "t", mainPlot: "m", ending: "e", compass: "c", progressContract: "p",
    volumes: [{ id: "v1", title: "第一卷", goal: "g", status: "writing" }],
  };
  w.chapters.push({ index: 1, title: "第一章", text: "正文", review: null });
  w.qualityDebt = Array.from({ length: openDebts }, (_, i) => debt(i, "open", "minor"));
  return w;
}

const homeProps = (world: WorldState) => ({
  initialData: {
    world,
    user: { id: 1, username: "tester", displayName: "测试员" },
    propClosed: false,
  },
  url: "/?title=hydration-test",
});

const tick = () => new Promise<void>((r) => setTimeout(r, 50));

/** 在 happy-dom 中把 SSR HTML 写进 #root，再 hydrateRoot，捕获 hydration mismatch 警告 */
async function captureHydrationWarnings(html: string, clientWorld: WorldState): Promise<string[]> {
  win.document.body.innerHTML = `<div id="root">${html}</div>`;
  const warnings: string[] = [];
  const origError = console.error;
  const record = (s: string) => {
    if (/hydrat|did not match|mismatch/i.test(s)) warnings.push(s);
    else origError(s);
  };
  console.error = (...args: unknown[]) => record(args.map(String).join(" "));
  try {
    const root = hydrateRoot(
      win.document.getElementById("root")!,
      React.createElement(Home, homeProps(clientWorld)),
      {
        // React 19：hydration mismatch 通过 uncaught error 报告（无错误边界时）
        onUncaughtError: (err) => record(String((err as Error)?.message ?? err)),
      },
    );
    try {
      await tick(); // 等 hydrate 完成（React 19 hydrate 是异步的；过早操作会触发 early-update 降级）
    } finally {
      root.unmount();
    }
  } catch (e) {
    // dev 模式下 hydration mismatch 会经 scheduler 抛出到调用方，同样记为 warning
    record(String((e as Error)?.message ?? e));
  } finally {
    console.error = origError;
  }
  return warnings;
}

describe("SSR ↔ hydrate 一致性（hydration mismatch 防护）", () => {
  test("weary presence（≥8 条 open 质量债）：SSR 与 client 首帧一致，无 mismatch", async () => {
    const html = renderToString(React.createElement(Home, homeProps(mkWorld(23))));
    expect(html).toContain('stroke="#7a6f5e"'); // weary 色
    const warnings = await captureHydrationWarnings(html, mkWorld(23));
    expect(warnings).toEqual([]);
  });

  test("standby presence（2 条 open 质量债）：SSR 与 client 首帧一致，无 mismatch", async () => {
    const html = renderToString(React.createElement(Home, homeProps(mkWorld(2))));
    expect(html).toContain('stroke="#191817"'); // standby 色
    const warnings = await captureHydrationWarnings(html, mkWorld(2));
    expect(warnings).toEqual([]);
  });

  test("自检：SSR 与 client 输入不一致（weary ↔ standby 漂移）时渲染输出可检测出差异", () => {
    // 模拟旧 server bundle 渲染 23 债（weary），新 client 首帧拿到 2 债（standby）——
    // 即用户报告里「server #7a6f5e vs client #191817」的本质。若未来 HUE/阈值/任何
    // 派生逻辑出现 SSR/client 分歧，前两个「相同输入」用例会失败；本用例证明测试
    // 家族对这类输入漂移具备检测能力（输出层面即可区分）。
    const serverHtml = renderToString(React.createElement(Home, homeProps(mkWorld(23))));
    const clientHtml = renderToString(React.createElement(Home, homeProps(mkWorld(2))));
    expect(serverHtml).toContain('data-presence="weary"');
    expect(serverHtml).toContain('stroke="#7a6f5e"');
    expect(clientHtml).toContain('data-presence="standby"');
    expect(clientHtml).toContain('stroke="#191817"');
  });
});
