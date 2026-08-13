import type { RouteHandler } from "./types";

export const STORY_ROUTE_PATHS = [
  "/api/novel/new", "/api/novel/delete", "/api/novel/world", "/api/novel/lore", "/api/novel/style",
  "/api/novel/gacha", "/api/novel/proposal", "/api/novel/proposal-closed", "/api/novel/foreshadow",
] as const;
const PATHS = new Set<string>(STORY_ROUTE_PATHS);

export const storyRoutes: RouteHandler = async ({ pathname, request }, _dependencies, legacy) =>
  PATHS.has(pathname) ? legacy(pathname, request) : null;
