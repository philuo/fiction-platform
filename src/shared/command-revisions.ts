const storyRevisions = new Map<string, number>();

export function setStoryRevision(title: string, revision?: number): void {
  if (revision === undefined) return;
  storyRevisions.set(title, revision);
}

export function getStoryRevision(title: string): number | undefined { return storyRevisions.get(title); }

export function clearStoryRevisions(): void { storyRevisions.clear(); }
