import type { WorldState } from "./world";

export type VisualSyncState = {
  running: boolean;
  pending: { id: string; name: string }[];
  failed: { id: string; name: string; reason?: string }[];
};

export type StorySystemProjection = {
  title: string;
  world: WorldState;
  /** state.json / world projection revision used by expectedRevision writes. */
  worldRevision?: number;
  visual: VisualSyncState;
  autoSession: Record<string, unknown> | null;
  autoPending: Record<string, unknown> | null;
  advanceTask: Record<string, unknown> | null;
  proposalClosed: boolean;
};

export type SystemSyncState = StorySystemProjection & {
  at: number;
  revision?: number;
  hash?: string;
};

export type BrainSyncState = {
  title: string;
  sessions: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  at: number;
  revision?: number;
  hash?: string;
};

export type LibrarySyncState = {
  stories: { slug: string; title: string; genre: string; chapters: number; updatedAt: string; cover?: string }[];
  tasks: { id: string; idea: string; genre: string; status: string; title?: string; stage?: string; error?: string; createdAt: string; updatedAt: string }[];
  revision: number;
  hash: string;
};

export type SyncEvent = {
  user?: string;
} & (
  | { type: "library-changed"; title: ""; at: number }
  | { type: "system-invalidated"; title: string; at: number }
  | ({ type: "system-snapshot"; at: number } & StorySystemProjection)
  | { type: "world-changed"; title: string; version: number; reason?: string; regions?: string[]; at: number }
  | { type: "auto-status"; title: string; status: string; phase?: string; written?: number; updatedAt?: string; at: number }
  | { type: "task-status"; title: string; kind: "build" | "advance" | "media" | "visual"; id?: string; sub?: "plan"; scenes?: { anchor: string; scene: string; caption?: string }[]; status: string; error?: string; at: number }
  | { type: "brain-note"; title: string; eventId: string; text: string; at: number }
  | { type: "card-update"; title: string; sessionId: string; messageId: string; cardId: string; patch: Record<string, unknown>; at: number }
  | { type: "card-replaced"; title: string; sessionId: string; messageId: string; cardIndex: number; card: Record<string, unknown>; at: number }
  | { type: "brain-append"; title: string; sessionId: string; messageId: string; at: number }
  | {
      type: "brain-status";
      title: string;
      sessions: {
        id: string;
        sessionTitle: string;
        createdAt: number;
        streaming: boolean;
        updatedAt: number;
        messages?: Record<string, unknown>[];
        messageStates?: Record<string, unknown>[];
        messageCount?: number;
        completed?: string[];
      }[];
      tasks: { id: string; status: string; sub?: "plan"; error?: string; scenes?: { anchor: string; scene: string; caption?: string }[] }[];
      at: number;
    }
);
