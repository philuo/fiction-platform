import type { ProjectionSnapshotPort } from "../../application/ports/projection-snapshots";
import { getSystemSyncSnapshot, listMediaTaskStates, listPendingMediaTasks } from "../../api/routes";

/** 迁移适配：sync transport 通过 projection port 访问旧投影构建器。 */
export const legacyProjectionSnapshots: ProjectionSnapshotPort = {
  system: getSystemSyncSnapshot,
  pendingMedia: listPendingMediaTasks,
  mediaStates: listMediaTaskStates,
};
