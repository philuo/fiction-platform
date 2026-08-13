import type { SyncEvent } from "../../contracts/sync";

export type SystemSyncSnapshot = Omit<Extract<SyncEvent, { type: "system-snapshot" }>, "type" | "at">;
export type MediaTaskState = {
  id: string;
  status: string;
  sub?: "plan";
  error?: string;
  scenes?: { anchor: string; scene: string; caption?: string }[];
};

export interface ProjectionSnapshotPort {
  system(title: string, heal?: boolean): SystemSyncSnapshot | null;
  pendingMedia(username: string, title: string): SyncEvent[];
  mediaStates(username: string, title: string): MediaTaskState[];
}
