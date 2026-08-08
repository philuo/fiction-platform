// 新角色提案横幅（Home playing 态）交互回归：
// 折叠单行渲染 / 展开抽屉（含推荐原因）/ ✕ 关闭 / 提案处理（确认入册）
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import Home from "../src/pages/Home";
import { findProposalCardMessageId } from "../src/components/BrainCabin";
import type { BrainCard } from "../src/components/brain-cards";
import { emptyWorld, type WorldState, type CharacterProposal } from "../src/api/world";

let win: Window;
let propClosedCalls: { url: string; body: { title: string; closed: boolean } }[] = [];
let serverClosed = false; // 模拟服务端关闭状态（sqlite）
const origFetch = globalThis.fetch;
beforeAll(() => {
  win = new Window({ url: "http://localhost/?title=proposal-bar-test" });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.navigator = win.navigator as unknown as Navigator;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  // 列表加载等 fetch 一律返回空；/api/novel/proposal-closed 模拟服务端状态（POST 记录调用）
  globalThis.fetch = async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/novel/proposal-closed")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { title: string; closed: boolean };
        propClosedCalls.push({ url: u, body });
        serverClosed = body.closed;
        return new Response(JSON.stringify({ ok: true, closed: body.closed }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
      }
      return new Response(JSON.stringify({ closed: serverClosed }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    return new Response(JSON.stringify({ stories: [] }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
  };
});
afterAll(() => {
  globalThis.fetch = origFetch;
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const prop = (id: string, name: string, role: string, reason: string): CharacterProposal =>
  ({ id, name, role, traits: [], motivation: `动机-${name}`, reason, source: "gacha", status: "pending" }) as CharacterProposal;

const mkWorld = (): WorldState => {
  const w = emptyWorld();
  w.title = "proposal-bar-test";
  w.chapters.push({ index: 1, title: "第一章", text: "正文", review: null });
  w.characterProposals = [prop("cp1", "林晚舟", "掌柜", "与主角身世成谜呼应"), prop("cp2", "苏九", "捕快", "制造冲突推进主线")];
  return w;
};

/** 渲染 Home（playing 态，已登录）并等待一次宏任务 flush */
async function mountHome(world: WorldState, opts: { propClosed?: boolean; serverClosed?: boolean } = {}) {
  serverClosed = opts.serverClosed ?? opts.propClosed ?? false;
  propClosedCalls = [];
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  await act(() => {
    root.render(React.createElement(Home, {
      initialData: {
        world,
        user: { id: 1, username: "tester", displayName: "测试员" },
        // SSR 注入的关闭状态（模拟刷新直达时服务端已按用户读库）
        propClosed: opts.propClosed,
      },
    }));
  });
  return { mount, root };
}

const text = (mount: HTMLElement) => mount.textContent ?? "";
const click = async (el: Element | null) => {
  expect(el).toBeTruthy();
  await act(() => {
    (el as Element).dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const findBtn = (mount: HTMLElement, label: string): HTMLButtonElement | null => {
  const btn = [...mount.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
  return (btn as HTMLButtonElement) ?? null;
};
/** icon 按钮无文本：按 title 定位（如「展开查看推荐原因…」/「收起」/「关闭新角色提案提示」） */
const findByTitle = (mount: HTMLElement, title: string): HTMLButtonElement | null => {
  const btn = [...mount.querySelectorAll("button")].find((b) => (b.getAttribute("title") ?? "").includes(title));
  return (btn as HTMLButtonElement) ?? null;
};

test("折叠态：单行 proposal-bar 渲染，抽屉常驻但未展开（无 open 类）", async () => {
  const { mount, root } = await mountHome(mkWorld());
  expect(mount.querySelector(".proposal-bar")).toBeTruthy();
  expect(text(mount)).toContain("新角色提案（2）");
  expect(text(mount)).toContain("林晚舟");
  expect(text(mount)).toContain("苏九");
  // 折叠态：抽屉为动画常驻 DOM（height:0），无 open 类
  const drawer = mount.querySelector(".proposal-drawer");
  expect(drawer).toBeTruthy();
  expect((drawer as HTMLElement).classList.contains("open")).toBe(false);
  root.unmount();
  await tick();
});

test("点击展开箭头 → 抽屉 open 显示推荐原因与动机；点击收起箭头 → 恢复单行", async () => {
  const { mount, root } = await mountHome(mkWorld());
  // 折叠态：展开为箭头 icon（无按钮样式），关闭为 ✕ icon
  const expand = findByTitle(mount, "展开查看推荐原因与动机");
  expect(expand).toBeTruthy();
  expect(expand!.className).toContain("proposal-bar-icon");
  expect(expand!.className).not.toContain("btn-save");
  await click(expand);
  expect(mount.querySelector(".proposal-bar")).toBeNull(); // 展开态隐藏单行
  const drawer = mount.querySelector(".proposal-drawer");
  expect(drawer).toBeTruthy();
  expect((drawer as HTMLElement).classList.contains("open")).toBe(true);
  expect(text(mount)).toContain("推荐原因：与主角身世成谜呼应");
  expect(text(mount)).toContain("动机-苏九");
  await click(findByTitle(mount, "收起"));
  expect(mount.querySelector(".proposal-drawer.open")).toBeNull();
  expect(mount.querySelector(".proposal-bar")).toBeTruthy();
  root.unmount();
  await tick();
});

test("点击 ✕ → 整个提案区关闭，并 POST /api/novel/proposal-closed { closed:true } 持久化到服务端", async () => {
  const { mount, root } = await mountHome(mkWorld());
  await click(findByTitle(mount, "关闭新角色提案提示"));
  expect(mount.querySelector(".proposal-bar")).toBeNull();
  expect(mount.querySelector(".proposal-drawer")).toBeNull();
  const call = propClosedCalls.find((c) => c.body.closed === true);
  expect(call).toBeTruthy();
  expect(call!.body.title).toBe("proposal-bar-test");
  expect(call!.body.closed).toBe(true);
  expect(serverClosed).toBe(true);
  root.unmount();
  await tick();
});

test("关闭状态服务端持久化：SSR 注入 closed（刷新直达）→ 首帧不渲染提案区（不再闪现后自动关）", async () => {
  const w = mkWorld();
  // 刷新直达：SSR 已按用户读库注入 propClosed=true → 首帧即隐藏（根治刷新闪现）
  const { mount, root } = await mountHome(w, { propClosed: true, serverClosed: true });
  expect(mount.querySelector(".proposal-bar")).toBeNull();
  expect(mount.querySelector(".proposal-drawer")).toBeNull();
  root.unmount();
  await tick();
});

test("未登录（initialData 无 user）→ 渲染登录页（AuthPage），不渲染提案区", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  await act(() => {
    root.render(React.createElement(Home, { initialData: { world: mkWorld() } }));
  });
  expect(mount.querySelector(".auth-shell")).toBeTruthy();
  expect(mount.querySelector(".auth-card")).toBeTruthy();
  expect(mount.querySelector(".proposal-bar")).toBeNull();
  root.unmount();
  await tick();
});

test("抽屉内「确认入册」触发 POST /api/novel/proposal", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify({ ok: false, error: "mock" }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
  };
  const { mount, root } = await mountHome(mkWorld());
  await click(findByTitle(mount, "展开查看推荐原因与动机"));
  await click(findBtn(mount, "确认入册"));
  const call = calls.find((c) => c.url === "/api/novel/proposal");
  expect(call).toBeTruthy();
  const body = JSON.parse(String(call!.body)) as { title: string; proposalId: string; action: string };
  expect(body.title).toBe("proposal-bar-test");
  expect(body.proposalId).toBe("cp1");
  expect(body.action).toBe("confirm");
  globalThis.fetch = origFetch;
  root.unmount();
  await tick();
});

describe("中枢话题恢复（findProposalCardMessageId）", () => {
  const proposalCard: BrainCard = {
    kind: "browse", title: "新角色提案（1 项）", browseType: "proposal", data: { list: [] },
  };
  const otherCard: BrainCard = {
    kind: "browse", title: "第3章", browseType: "chapter", data: { index: 3 },
  };
  test("含提案浏览卡的消息被识别（用户与中枢聊「新角色提案」→ 通知 Home 恢复显示）", () => {
    const msgs = [
      { id: "m1", role: "user", text: "有哪些角色推荐", at: "" },
      { id: "m2", role: "brain", cards: [proposalCard], at: "" },
    ] as unknown as { id: string; cards?: BrainCard[] }[];
    expect(findProposalCardMessageId(msgs as never)).toBe("m2");
  });
  test("无提案卡 → undefined（不误触发恢复）", () => {
    const msgs = [
      { id: "m1", role: "brain", cards: [otherCard], at: "" },
      { id: "m2", role: "brain", cards: [], at: "" },
      { id: "m3", role: "user", text: "再写一章", at: "" },
    ] as unknown as { id: string; cards?: BrainCard[] }[];
    expect(findProposalCardMessageId(msgs as never)).toBeUndefined();
  });
});
