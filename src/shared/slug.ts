/** Stable filesystem/channel slug. Keep this pure so contracts and event code do not depend on storage. */
export function slugify(title: string): string {
  const slug = title.trim().replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40);
  if (!slug || slug === "." || slug === ".." || /^\.+$/.test(slug)) return "story";
  return slug;
}
