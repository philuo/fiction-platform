/** Produce a stable cache-busting token for fixed-name production assets. */
export function assetContentVersion(parts: Array<string | Uint8Array>): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex").slice(0, 16);
}
