import type { AuthUser, RequestContext } from "../../../contracts/auth";
import type { JobStore, MediaProvider, ModelProvider, ProjectionPublisher, StoryRepository, WorldCommitter } from "../../../application/ports";

export type RouteContext = {
  request: Request;
  pathname: string;
  body: Record<string, unknown>;
  user: AuthUser;
  requestContext: RequestContext;
};

export type RouteDependencies = {
  storyRepository: StoryRepository;
  worldCommitter: WorldCommitter;
  jobStore: JobStore;
  projectionPublisher: ProjectionPublisher;
  modelProvider: ModelProvider;
  mediaProvider: MediaProvider;
};

export type LegacyRouteHandler = (pathname: string, request: Request) => Promise<Response | null>;
export type RouteHandler = (context: RouteContext, dependencies: RouteDependencies, legacy: LegacyRouteHandler) => Promise<Response | null>;

export const EMPTY_ROUTE_DEPENDENCIES = {} as RouteDependencies;
