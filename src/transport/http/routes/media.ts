import type { RouteHandler } from "./types";

export const MEDIA_ROUTE_PATHS = [
  "/api/novel/image", "/api/novel/character/portrait", "/api/novel/media/plan", "/api/novel/media/generate",
  "/api/novel/media/regenerate", "/api/novel/media/cancel", "/api/novel/media/delete", "/api/novel/cover/upload", "/api/novel/asset",
] as const;
const PATHS = new Set<string>(MEDIA_ROUTE_PATHS);

export const mediaRoutes: RouteHandler = async ({ pathname, request }, _dependencies, legacy) =>
  PATHS.has(pathname) ? legacy(pathname, request) : null;
