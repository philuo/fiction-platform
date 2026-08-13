import type { MediaProvider, ModelProvider } from "../../application/ports/providers";
import type { ChapterMedia, WorldState } from "../../contracts/world";
import * as agnes from "../../api/agnes";
import { createSceneVideo, generateSceneImage } from "../../api/media";

export const agnesModelProvider: ModelProvider = {
  complete: (messages, options) => agnes.chat(messages as Parameters<typeof agnes.chat>[0], options as Parameters<typeof agnes.chat>[1]),
};

export type MediaReconciler = (title: string, chapterIndex: number, mediaId: string) => Promise<"pending" | "ready" | "failed">;

export function createLegacyMediaProvider(reconcile: MediaReconciler): MediaProvider {
  return {
    createImage: (storyTitle, scene, anchor, options) =>
      generateSceneImage(storyTitle, scene, anchor, options as Parameters<typeof generateSceneImage>[3]),
    createVideo: (scene, anchor, options) =>
      createSceneVideo(scene, anchor, options as Parameters<typeof createSceneVideo>[2]),
    reconcile: (_world: WorldState, chapterIndex: number, mediaId: string) => reconcile(_world.title, chapterIndex, mediaId),
  };
}

export type { ChapterMedia };
