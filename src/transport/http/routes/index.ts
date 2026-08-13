import { brainRoutes } from "./brain";
import { AUTORUN_ROUTE_PATHS, autorunRoutes } from "./autorun";
import { BRAIN_ROUTE_PATHS } from "./brain";
import { chapterRoutes } from "./chapter";
import { CHAPTER_ROUTE_PATHS } from "./chapter";
import { governanceRoutes } from "./governance";
import { GOVERNANCE_ROUTE_PATHS } from "./governance";
import { mediaRoutes } from "./media";
import { MEDIA_ROUTE_PATHS } from "./media";
import { planningRoutes } from "./planning";
import { PLANNING_ROUTE_PATHS } from "./planning";
import { queryRoutes } from "./query";
import { QUERY_ROUTE_PATHS } from "./query";
import { storyRoutes } from "./story";
import { STORY_ROUTE_PATHS } from "./story";
import type { LegacyRouteHandler, RouteContext, RouteDependencies, RouteHandler } from "./types";

const handlers: RouteHandler[] = [brainRoutes, queryRoutes, storyRoutes, chapterRoutes, planningRoutes, governanceRoutes, mediaRoutes, autorunRoutes];

export const MODULAR_ROUTE_PATHS = [
  ...BRAIN_ROUTE_PATHS, ...QUERY_ROUTE_PATHS, ...STORY_ROUTE_PATHS, ...CHAPTER_ROUTE_PATHS,
  ...PLANNING_ROUTE_PATHS, ...GOVERNANCE_ROUTE_PATHS, ...MEDIA_ROUTE_PATHS, ...AUTORUN_ROUTE_PATHS,
] as const;

export async function dispatchHttpRoute(context: RouteContext, dependencies: RouteDependencies, legacy: LegacyRouteHandler): Promise<Response | null> {
  for (const handler of handlers) {
    const response = await handler(context, dependencies, legacy);
    if (response) return response;
  }
  return null;
}

export { handlers };
export { EMPTY_ROUTE_DEPENDENCIES } from "./types";
export type { LegacyRouteHandler, RouteContext, RouteDependencies, RouteHandler } from "./types";
