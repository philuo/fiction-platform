/**
 * 生成 v4 UUID。
 * 优先用 crypto.randomUUID（仅 secure context 可用）；否则降级到 crypto.getRandomValues 手写 v4。
 * 背景：通过 http://局域网IP:3000（非 secure context）访问时 crypto.randomUUID 为 undefined，
 * 直接调用会抛 TypeError: crypto.randomUUID is not a function。
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    // RFC 4122 v4：version 4 / variant 10
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  // 最终兜底：无 crypto 环境（极罕见），Math.random 生成符合 v4 形状的串
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
