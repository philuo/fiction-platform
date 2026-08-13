import { useFeatureCommands } from "../shared/useFeatureCommands";

export function useGovernanceCommands() {
  const post = useFeatureCommands("/api/novel");
  return {
    intervene: (payload: Record<string, unknown>) => post("/intervene", payload),
    lock: (payload: Record<string, unknown>) => post("/lock", payload),
    integrity: (payload: Record<string, unknown>) => post("/integrity", payload),
    debt: (payload: Record<string, unknown>) => post("/debt", payload),
  };
}
