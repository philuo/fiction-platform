import type { RouteHandler } from "./types";

export const BRAIN_ROUTE_PATHS = [
  "/api/brain/sessions", "/api/brain/sessions/delete", "/api/brain/sessions/detail",
  "/api/brain/sessions/completed", "/api/brain/sessions/append", "/api/brain/sessions/progress",
  "/api/brain/sessions/update-card", "/api/brain/sessions/consume-panel", "/api/brain/sessions/replace-card",
  "/api/brain/sessions/system-note", "/api/brain/sessions/truncate", "/api/brain/chat",
] as const;
const PATHS = new Set<string>(BRAIN_ROUTE_PATHS);

export const brainRoutes: RouteHandler = async ({ pathname, request }, _dependencies, legacy) =>
  PATHS.has(pathname) ? legacy(pathname, request) : null;
