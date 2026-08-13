import type { RouteHandler } from "./types";

export const PLANNING_ROUTE_PATHS = [
  "/api/novel/outline", "/api/novel/blueprint", "/api/novel/plans", "/api/novel/rewrite", "/api/novel/chapter/resettle",
] as const;
const PATHS = new Set<string>(PLANNING_ROUTE_PATHS);

export const planningRoutes: RouteHandler = async ({ pathname, request }, _dependencies, legacy) =>
  PATHS.has(pathname) ? legacy(pathname, request) : null;
