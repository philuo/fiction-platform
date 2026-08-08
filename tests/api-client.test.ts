// 探针：验证 apiFetch 的 token 附加与 401 处理（jsdom 模拟 localStorage + fetch mock）
import { test, expect } from "bun:test";

// —— 在 node 环境模拟 window/localStorage/fetch ——
const store = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  },
};

let captured: { url: string; init: RequestInit } | null = null;
(globalThis as any).fetch = async (url: string, init: RequestInit) => {
  captured = { url, init };
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const { apiFetch, getToken, setToken, clearToken, onAuthChange } = await import("../src/api/client");

test("apiFetch 附加 Authorization: Bearer token", async () => {
  setToken("tok123");
  await apiFetch("/api/novel/list");
  const h = new Headers(captured!.init.headers);
  expect(h.get("authorization")).toBe("Bearer tok123");
});

test("auth:false 不附加 token（登录/注册自身）", async () => {
  clearToken();
  setToken("tok123");
  await apiFetch("/api/auth/login", { method: "POST", auth: false, body: "{}" });
  const h = new Headers(captured!.init.headers);
  expect(h.get("authorization")).toBeNull();
});

test("401 清 token 并广播 onAuthChange", async () => {
  setToken("expired");
  let notified = false;
  const off = onAuthChange(() => (notified = true));
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ error: "未登录" }), { status: 401 });
  const res = await apiFetch("/api/novel/list");
  expect(res.status).toBe(401);
  expect(getToken()).toBeNull();
  expect(notified).toBe(true);
  off();
  clearToken();
});
