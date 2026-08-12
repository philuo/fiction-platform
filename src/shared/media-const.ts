export const MAX_IMAGES_PER_CHAPTER = 3;

/** Failed/cancelled placeholders do not consume the chapter image quota. */
export function imageOccupiesQuota(media: { kind?: string; status?: string } | null | undefined): boolean {
  return media?.kind === "image" && media.status !== "failed";
}
