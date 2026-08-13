import type { SyncEvent } from "../../contracts/sync";

export interface ProjectionPublisher {
  publish(event: SyncEvent): void;
  publishImmediate(event: SyncEvent): void;
}
