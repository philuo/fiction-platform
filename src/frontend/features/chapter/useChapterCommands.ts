import { useFeatureCommands } from "../shared/useFeatureCommands";

export function useChapterCommands() {
  const post = useFeatureCommands("/api/novel");
  return {
    advance: (title: string, instruction: string) => post("/step", { title, instruction }),
    confirm: (payload: Record<string, unknown>) => post("/chapter/confirm", payload),
    reject: (payload: Record<string, unknown>) => post("/chapter/reject", payload),
    edit: (payload: Record<string, unknown>) => post("/chapter/edit", payload),
    regenerate: (payload: Record<string, unknown>) => post("/chapter/regenerate", payload),
  };
}
