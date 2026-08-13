import type { ProjectionPublisher } from "../../application/ports/projections";
import { publishSync, publishSyncImmediate } from "../../api/sync";

export const syncProjectionPublisher: ProjectionPublisher = {
  publish: publishSync,
  publishImmediate: publishSyncImmediate,
};
