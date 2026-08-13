import type { RouteHandler } from "./types";

export const AUTORUN_ROUTE_PATHS = [
  "/api/novel/auto/start", "/api/novel/auto/stop", "/api/novel/auto/pause",
  "/api/novel/auto/skip", "/api/novel/auto/clear-session",
] as const;
const PATHS = new Set<string>(AUTORUN_ROUTE_PATHS);

export const autorunRoutes: RouteHandler = async ({ pathname, request }, _dependencies, legacy) =>
  PATHS.has(pathname) ? legacy(pathname, request) : null;
