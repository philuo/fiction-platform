import type { AuthUser, RequestContext } from "../../contracts/auth";
import {
  AuthError,
  clearSessionCookieValue,
  loginUser,
  logoutSession,
  registerUser,
  sessionCookieValue,
  validateCredentials,
  SESSION_COOKIE,
} from "../../api/auth";
import { jsonResponse, readJsonBody } from "./responses";

export type AuthRouteDependencies = {
  migrateLegacyStories(username: string): void;
};

function requestToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  const cookie = request.headers.get("cookie") ?? "";
  const pair = cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  return pair ? pair.slice(SESSION_COOKIE.length + 1) : "";
}

/** Authentication transport. Returns null for paths owned by another router. */
export async function handleAuthRoute(
  pathname: string,
  request: Request,
  authenticatedUser: AuthUser | null,
  context: RequestContext | null,
  dependencies: AuthRouteDependencies,
): Promise<Response | null> {
  switch (pathname) {
    case "/api/auth/register": {
      if (request.method !== "POST") return jsonResponse({ error: "仅支持 POST" }, 405);
      const body = await readJsonBody(request);
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      const displayName = String(body.displayName ?? "").trim();
      const validationError = validateCredentials(username, password);
      if (validationError) return jsonResponse({ error: validationError }, 400);
      try {
        const user = await registerUser(username, password, displayName);
        if (user.isFirstUser) {
          try {
            dependencies.migrateLegacyStories(user.username);
          } catch (error) {
            console.warn("[api/auth/register] 旧数据迁移失败:", (error as Error).message);
          }
        }
        const session = await loginUser(username, password);
        const token = session?.token ?? "";
        return jsonResponse(
          { ok: true, token, user: { id: user.id, username: user.username, displayName: user.displayName } },
          200,
          token ? { "Set-Cookie": sessionCookieValue(token) } : undefined,
        );
      } catch (error) {
        if (error instanceof AuthError) return jsonResponse({ error: error.message }, 409);
        console.error("[api/auth/register]", error);
        return jsonResponse({ error: "注册失败，请稍后重试" }, 500);
      }
    }

    case "/api/auth/login": {
      if (request.method !== "POST") return jsonResponse({ error: "仅支持 POST" }, 405);
      const body = await readJsonBody(request);
      const result = await loginUser(String(body.username ?? "").trim(), String(body.password ?? ""));
      if (!result) return jsonResponse({ error: "用户名或密码错误" }, 401);
      return jsonResponse({ ok: true, token: result.token, user: result.user }, 200, { "Set-Cookie": sessionCookieValue(result.token) });
    }

    case "/api/auth/logout": {
      if (request.method !== "POST") return jsonResponse({ error: "仅支持 POST" }, 405);
      const token = requestToken(request);
      if (token) logoutSession(token);
      return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearSessionCookieValue() });
    }

    case "/api/auth/me":
      return authenticatedUser && context
        ? jsonResponse({ ok: true, user: authenticatedUser })
        : jsonResponse({ error: "未登录" }, 401);

    default:
      return null;
  }
}
