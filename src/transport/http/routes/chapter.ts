import type { RouteHandler } from "./types";

export const CHAPTER_ROUTE_PATHS = [
  "/api/novel/step", "/api/novel/chapter/confirm", "/api/novel/chapter/reject", "/api/novel/chapter/edit",
  "/api/novel/chapter/review", "/api/novel/chapter/regenerate", "/api/novel/chapter/rollback", "/api/novel/chapter/delete",
] as const;
const PATHS = new Set<string>(CHAPTER_ROUTE_PATHS);

export const chapterRoutes: RouteHandler = async ({ pathname, request }, _dependencies, legacy) =>
  PATHS.has(pathname) ? legacy(pathname, request) : null;
