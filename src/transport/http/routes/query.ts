import type { RouteHandler } from "./types";

export const QUERY_ROUTE_PATHS = [
  "/api/health", "/api/chat", "/api/chat/stream", "/api/search", "/api/novel/export", "/api/novel/changelog",
] as const;
const PATHS = new Set<string>(QUERY_ROUTE_PATHS);

export const queryRoutes: RouteHandler = async ({ pathname, request }, _dependencies, legacy) =>
  PATHS.has(pathname) ? legacy(pathname, request) : null;
