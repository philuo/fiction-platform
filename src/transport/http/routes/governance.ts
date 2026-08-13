import type { RouteHandler } from "./types";

export const GOVERNANCE_ROUTE_PATHS = ["/api/novel/intervene", "/api/novel/lock", "/api/novel/integrity", "/api/novel/debt", "/api/novel/eval"] as const;
const PATHS = new Set<string>(GOVERNANCE_ROUTE_PATHS);

export const governanceRoutes: RouteHandler = async ({ pathname, request }, _dependencies, legacy) =>
  PATHS.has(pathname) ? legacy(pathname, request) : null;
