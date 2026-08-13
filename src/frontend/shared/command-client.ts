import { apiFetch } from "../../api/client";
import type { PublicCommandId } from "../../contracts/commands";

export type CommandClientRequest = {
  commandId: string;
  type: PublicCommandId;
  scope: { title?: string };
  expectedRevision?: number;
  payload: unknown;
};

export async function submitCommand<T = unknown>(request: CommandClientRequest): Promise<{ response: Response; data: T }> {
  const response = await apiFetch("/api/commands", {
    method: "POST",
    body: JSON.stringify(request),
  });
  const data = await response.json().catch(() => ({})) as T;
  return { response, data };
}
