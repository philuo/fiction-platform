import type { ApiFetchOptions } from "../../../api/client";
import { useFeatureCommands } from "../shared/useFeatureCommands";

export function useMediaCommands() {
  const post = useFeatureCommands("/api/novel/media");
  return {
    plan: (payload: Record<string, unknown>, options?: Omit<ApiFetchOptions, "method" | "body">) => post("/plan", payload, options),
    generate: (payload: Record<string, unknown>) => post("/generate", payload),
    regenerate: (payload: Record<string, unknown>) => post("/regenerate", payload),
    cancel: (payload: Record<string, unknown>) => post("/cancel", payload),
    remove: (payload: Record<string, unknown>) => post("/delete", payload),
  };
}
