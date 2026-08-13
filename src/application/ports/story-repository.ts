import type { WorldState } from "../../contracts/world";

export interface StoryRepository {
  load(title: string): WorldState | null;
  list(username?: string): string[];
  exists(title: string): boolean;
  remove(title: string): boolean;
}

export interface WorldCommitter {
  commit(world: WorldState, regions?: string[]): string;
}
