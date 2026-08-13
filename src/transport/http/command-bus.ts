import { commandDefinition, publicCommandFor, type PublicCommandId } from "../../contracts/commands";
import {
  CommandConflictError,
  RevisionConflictError,
  acceptCommandOnce,
  getCommandReceipt,
  syncRevision,
  updateCommand,
  type CommandReceipt,
  type CommandRequest,
} from "../../api/control-plane";
import { runAsUser } from "../../api/storage";
import { errorDetail, jsonResponse, readJsonBody } from "./responses";

type StoredHttpResponse = { __httpResponse: true; status: number; contentType: string; body: unknown };
export type CommandHandler = (pathname: string, request: Request) => Promise<Response | null>;

function storeResponse(response: Response, body: unknown): StoredHttpResponse {
  return { __httpResponse: true, status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body };
}

function replay(receipt: CommandReceipt): Response {
  const stored = receipt.result as Partial<StoredHttpResponse> | undefined;
  const terminal = receipt.status === "succeeded" || receipt.status === "failed" || receipt.status === "cancelled";
  const replayStored = receipt.status === "succeeded"
    || ((receipt.status === "failed" || receipt.status === "cancelled") && typeof stored?.status === "number" && stored.status >= 400);
  if (terminal && replayStored && stored?.__httpResponse && typeof stored.status === "number") {
    if (stored.contentType?.includes("application/json")) return jsonResponse(stored.body, stored.status);
    return new Response(typeof stored.body === "string" ? stored.body : JSON.stringify(stored.body), {
      status: stored.status,
      headers: { "Content-Type": stored.contentType ?? "application/octet-stream" },
    });
  }
  if (receipt.status === "failed") return jsonResponse({ error: receipt.error ?? "命令执行失败", ...receipt }, 409);
  if (receipt.status === "cancelled") return jsonResponse({ error: receipt.error ?? "命令已取消", ...receipt }, 409);
  if (receipt.status === "succeeded" && receipt.result !== undefined) return jsonResponse(receipt.result);
  return jsonResponse(receipt, 202);
}

function verifyRevision(username: string, title: string, expectedRevision?: number): void {
  if (expectedRevision === undefined || !title) return;
  const current = syncRevision(username, `story/${title}`, "world").revision;
  if (current !== expectedRevision) throw new RevisionConflictError(`世界版本已变化：期望 ${expectedRevision}，当前 ${current}`);
}

export class CommandBus {
  constructor(private readonly handler: CommandHandler) {}

  async handleResource(pathname: string, request: Request, username: string): Promise<Response | null> {
    if (pathname === "/api/commands") return this.submit(request, username);
    if (!pathname.startsWith("/api/commands/")) return null;
    if (request.method !== "GET") return jsonResponse({ error: "仅支持 GET" }, 405);
    const commandId = decodeURIComponent(pathname.slice("/api/commands/".length)).trim();
    if (!commandId) return jsonResponse({ error: "缺少 commandId" }, 400);
    const receipt = getCommandReceipt(username, commandId);
    return receipt ? jsonResponse(receipt) : jsonResponse({ error: "命令不存在" }, 404);
  }

  private async submit(request: Request, username: string): Promise<Response> {
    if (request.method !== "POST") return jsonResponse({ error: "仅支持 POST" }, 405);
    const command = await readJsonBody(request) as unknown as CommandRequest;
    const commandId = String(command.commandId ?? "").trim();
    const type = String(command.type ?? "") as PublicCommandId;
    const title = String(command.scope?.title ?? "").trim();
    const definition = commandDefinition(type);
    if (!commandId || !type || !command.scope || !("payload" in command)) return jsonResponse({ error: "commandId/type/scope/payload 不能为空" }, 400);
    if (!definition) return jsonResponse({ error: `命令尚未迁入统一入口: ${type}` }, 400);
    if (type !== "CMD-N01" && !title) return jsonResponse({ error: "该命令缺少 scope.title" }, 400);
    if (definition.requiresRevision && (!Number.isInteger(command.expectedRevision) || command.expectedRevision! < 0)) {
      return jsonResponse({ error: "覆盖性命令缺少 expectedRevision" }, 409);
    }
    try {
      verifyRevision(username, title, command.expectedRevision);
      const accepted = acceptCommandOnce(username, { ...command, commandId, type, scope: { ...command.scope, title: title || undefined } });
      if (accepted.created) {
        const execute = async (): Promise<{ result?: unknown; error?: string }> => {
          updateCommand(commandId, "running");
          try {
            const payload = typeof command.payload === "object" && command.payload ? command.payload as Record<string, unknown> : {};
            const forwarded = new Request(`http://internal${definition.path}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...payload, ...(title ? { title } : {}), commandId }),
            });
            const response = await this.handler(definition.path, forwarded);
            const result = response ? await response.clone().json().catch(() => ({})) : {};
            if (!response || !response.ok) throw new Error(String((result as { error?: unknown }).error ?? `命令执行器返回 ${response?.status ?? 500}`));
            updateCommand(commandId, definition.execution === "sync" ? "succeeded" : "running", result);
            return { result };
          } catch (error) {
            const message = errorDetail(error, "命令执行失败");
            updateCommand(commandId, "failed", undefined, message);
            return { error: message };
          }
        };
        if (definition.execution === "sync") {
          const outcome = await runAsUser(username, execute);
          const terminal = getCommandReceipt(username, commandId) ?? accepted.receipt;
          return jsonResponse(terminal, outcome.error ? 409 : 200);
        }
        void runAsUser(username, execute);
      }
      const current = getCommandReceipt(username, commandId) ?? accepted.receipt;
      const status = current.status === "queued" || current.status === "running" ? 202 : current.status === "succeeded" ? 200 : 409;
      return jsonResponse(current, status);
    } catch (error) {
      if (error instanceof CommandConflictError || error instanceof RevisionConflictError) return jsonResponse({ error: error.message }, 409);
      return jsonResponse({ error: errorDetail(error, "命令提交失败") }, 400);
    }
  }

  async handleLegacy(pathname: string, request: Request, username: string): Promise<Response | null> {
    if (!pathname.startsWith("/api/novel/") || request.method !== "POST") return null;
    const payload = await readJsonBody(request.clone());
    const route = publicCommandFor(pathname, payload);
    if (!route) return null;
    if (request.headers.get("x-command-contract") !== "v1") {
      return jsonResponse({ error: "公开写操作必须使用 x-command-contract: v1" }, 400);
    }
    const commandId = String(request.headers.get("x-command-id") ?? "").trim();
    const claimedType = String(request.headers.get("x-command-type") ?? "").trim();
    const title = String(payload.title ?? "").trim();
    const expectedRaw = request.headers.get("x-expected-revision");
    const expectedRevision = expectedRaw == null ? undefined : Number(expectedRaw);
    if (!commandId || claimedType !== route.type) return jsonResponse({ error: "命令契约与业务入口不匹配" }, 400);
    if (route.requiresRevision && !title) return jsonResponse({ error: "该命令缺少 scope.title" }, 400);
    if (route.requiresRevision && (!Number.isInteger(expectedRevision) || expectedRevision! < 0)) return jsonResponse({ error: "覆盖性命令缺少 expectedRevision" }, 409);
    try {
      verifyRevision(username, title, expectedRevision);
      const accepted = acceptCommandOnce(username, { commandId, type: route.type, scope: { title: title || undefined }, expectedRevision, payload });
      if (!accepted.created) return replay(accepted.receipt);
      updateCommand(commandId, "running");
      const headers = new Headers(request.headers);
      headers.set("x-command-accepted", "1");
      const response = await this.handler(pathname, new Request(request.url, { method: request.method, headers, body: JSON.stringify({ ...payload, commandId }) }));
      if (!response) throw new Error("命令执行器不存在");
      const isStream = route.execution === "stream" || response.headers.get("content-type")?.includes("text/event-stream");
      if (!response.ok) {
        const result = await response.clone().json().catch(() => ({}));
        updateCommand(commandId, "failed", storeResponse(response, result), String((result as { error?: unknown }).error ?? `命令执行器返回 ${response.status}`));
      } else if (!isStream) {
        const result = await response.clone().json().catch(() => ({}));
        updateCommand(commandId, route.execution === "job" ? "running" : "succeeded", storeResponse(response, result));
      }
      return response;
    } catch (error) {
      if (error instanceof CommandConflictError || error instanceof RevisionConflictError) return jsonResponse({ error: error.message }, 409);
      updateCommand(commandId, "failed", undefined, errorDetail(error, "命令提交失败"));
      return jsonResponse({ error: errorDetail(error, "命令提交失败") }, 400);
    }
  }
}
