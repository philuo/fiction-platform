import type { StoryRepository, WorldCommitter } from "../../application/ports/story-repository";
import { deleteStory, listStories, loadWorld, saveWorld, storyExists } from "../../api/storage";

export const fileStoryRepository: StoryRepository = {
  load: loadWorld,
  list: listStories,
  exists: storyExists,
  remove: deleteStory,
};

export const fileWorldCommitter: WorldCommitter = { commit: saveWorld };
