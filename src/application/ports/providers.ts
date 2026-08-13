import type { ChapterMedia, WorldState } from "../../contracts/world";

export interface ModelProvider {
  complete(messages: { role: string; content: string }[], options?: Record<string, unknown>): Promise<string>;
}

export interface MediaProvider {
  createImage(storyTitle: string, scene: string, anchor: string, options?: Record<string, unknown>): Promise<ChapterMedia>;
  createVideo(scene: string, anchor: string, options?: Record<string, unknown>): Promise<ChapterMedia>;
  reconcile(world: WorldState, chapterIndex: number, mediaId: string): Promise<"pending" | "ready" | "failed">;
}
