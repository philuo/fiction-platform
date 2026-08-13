import { useCallback } from "react";
import { apiFetch, type ApiFetchOptions } from "../../../api/client";

export function useFeatureCommands(prefix: string) {
  const post = useCallback((path: string, payload: Record<string, unknown>, options: Omit<ApiFetchOptions, "method" | "body"> = {}) =>
    apiFetch(`${prefix}${path}`, {
      ...options,
      method: "POST",
      headers: { "Content-Type": "application/json", ...options.headers },
      body: JSON.stringify(payload),
    }), [prefix]);
  return post;
}
