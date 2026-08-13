import type { BrainCard } from "../../../components/brain-cards";

export type ChatMessage = {
  id: string;
  role: "user" | "brain";
  text?: string;
  thinking?: string;
  cards?: BrainCard[];
  pending?: boolean;
  interrupted?: boolean;
  kind?: "system";
  at: string;
};
