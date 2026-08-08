// 前端统一 API 客户端：token 凭证（localStorage）+ 自动附加 Authorization header + 401 统一处理。
// 凭证形态：业务 API 走 `Authorization: Bearer <token>`（不依赖 cookie，支持多用户并存互不影响）；
// 服务端另种只读 httpOnly cookie 仅供 SSR 首帧识别用户（浏览器导航自动携带，登录/登出由 token 主导）。
// 401 处理：token 失效/过期 → 清除本地 token 并通知订阅者（Home 回到登录页）。

const TOKEN_KEY = "ms_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
  notifyAuthChange();
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  notifyAuthChange();
}

/** 401 时由 apiFetch 触发：通知订阅者（Home 监听后清除用户态回登录页） */
type AuthChangeListener = () => void;
const listeners = new Set<AuthChangeListener>();
export function onAuthChange(fn: AuthChangeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notifyAuthChange(): void {
  for (const fn of [...listeners]) fn();
}

export type ApiFetchOptions = RequestInit & {
  /** 默认 true：附加 Authorization: Bearer token；传 false 跳过（如登录/注册接口本身） */
  auth?: boolean;
};

/** 统一请求入口：附加 token、JSON 方便、401 统一清凭证。返回 Response（调用方按原逻辑解析）。 */
export async function apiFetch(url: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { auth = true, headers, ...rest } = options;
  const init: RequestInit = { ...rest };
  if (auth) {
    const token = getToken();
    const h = new Headers(headers);
    if (token) h.set("authorization", `Bearer ${token}`);
    if (!h.has("content-type") && rest.body && typeof rest.body === "string") {
      h.set("content-type", "application/json");
    }
    init.headers = h;
  } else {
    init.headers = headers;
  }
  const res = await fetch(url, init);
  // token 失效：清除本地凭证并广播（401 只处理带凭证的请求，避免登录页自身的 401 误触发）
  if (res.status === 401 && auth && getToken()) {
    clearToken();
  }
  return res;
}
