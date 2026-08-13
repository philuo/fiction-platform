import { useFeatureCommands } from "../shared/useFeatureCommands";

export function useStoryCommands() {
  const post = useFeatureCommands("/api/novel");
  return {
    create: (idea: string, genre?: string) => post("/new", { idea, genre }),
    remove: (title: string) => post("/delete", { title }),
    setProposalClosed: (title: string, closed: boolean) => post("/proposal-closed", { title, closed }),
    proposal: (payload: Record<string, unknown>) => post("/proposal", payload),
  };
}
