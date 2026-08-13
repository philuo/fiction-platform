import { useFeatureCommands } from "../shared/useFeatureCommands";

export function useAutorunCommands() {
  const post = useFeatureCommands("/api/novel/auto");
  return {
    start: (payload: Record<string, unknown>) => post("/start", payload),
    pause: (title: string) => post("/pause", { title }),
    stop: (title: string) => post("/stop", { title }),
    skip: (payload: Record<string, unknown>) => post("/skip", payload),
    clearSession: (title: string) => post("/clear-session", { title }),
  };
}
