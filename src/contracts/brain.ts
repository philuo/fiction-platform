export type BrainCardData = Record<string, unknown>;

export type BrainMessageRole = "user" | "assistant";

export type BrainMessage = {
  id: string;
  role: BrainMessageRole;
  text: string;
  thinking?: string;
  cards?: BrainCardData[];
  at: number;
  pending?: boolean;
  interrupted?: boolean;
  kind?: "system";
};

export type BrainSessionData = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: BrainMessage[];
  streaming: boolean;
  completed?: string[];
  systemNotes?: string[];
};

export type BrainDisplayMessage = {
  id: string;
  role: "user" | "brain";
  text?: string;
  thinking?: string;
  cards?: BrainCardData[];
  pending?: boolean;
  interrupted?: boolean;
  kind?: "system";
  at: string;
};
