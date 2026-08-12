export type PublicCommandId = `CMD-${"N" | "W" | "L" | "M" | "G" | "S"}${string}`;

export type PublicCommandRoute = {
  type: PublicCommandId;
  requiresRevision: boolean;
};

/** 公开 HTTP 写操作到 Harness 命令的唯一映射。返回 null 表示纯查询或非业务写入口。 */
export function publicCommandFor(pathname: string, payload: Record<string, unknown>): PublicCommandRoute | null {
  const action = String(payload.action ?? "");
  switch (pathname) {
    case "/api/novel/new": return { type: "CMD-N01", requiresRevision: false };
    case "/api/novel/delete": return { type: "CMD-S12", requiresRevision: true };
    case "/api/novel/step": return { type: "CMD-N02", requiresRevision: true };
    case "/api/novel/chapter/confirm": return { type: "CMD-N17", requiresRevision: true };
    case "/api/novel/chapter/reject": return { type: "CMD-N18", requiresRevision: true };
    case "/api/novel/gacha": return { type: action === "apply" ? "CMD-W18" : "CMD-W17", requiresRevision: action === "apply" };
    case "/api/novel/foreshadow": return { type: "CMD-L07", requiresRevision: true };
    case "/api/novel/outline": return { type: "CMD-W01", requiresRevision: true };
    case "/api/novel/blueprint": return { type: action === "confirm" ? "CMD-W03" : action === "edit" ? "CMD-W04" : "CMD-W02", requiresRevision: action !== "generate" };
    case "/api/novel/plans": return { type: action === "edit" ? "CMD-W07" : "CMD-W05", requiresRevision: true };
    case "/api/novel/chapter/edit": return { type: "CMD-N06", requiresRevision: true };
    case "/api/novel/chapter/review": return { type: "CMD-N09", requiresRevision: true };
    case "/api/novel/lore": return { type: "CMD-W14", requiresRevision: true };
    case "/api/novel/world": return { type: "CMD-W12", requiresRevision: true };
    case "/api/novel/intervene": return action === "report" ? null : { type: action === "interrupt" ? "CMD-N16" : "CMD-G02", requiresRevision: true };
    case "/api/novel/lock": return { type: "CMD-G03", requiresRevision: true };
    case "/api/novel/proposal-closed": return { type: "CMD-S13", requiresRevision: false };
    case "/api/novel/proposal": return { type: "CMD-L11", requiresRevision: true };
    case "/api/novel/style": return { type: "CMD-W16", requiresRevision: true };
    case "/api/novel/auto/start": return { type: "CMD-N03", requiresRevision: true };
    case "/api/novel/auto/stop": return { type: "CMD-N13", requiresRevision: false };
    case "/api/novel/auto/pause": return { type: "CMD-N19", requiresRevision: false };
    case "/api/novel/auto/skip": return { type: "CMD-N14", requiresRevision: true };
    case "/api/novel/auto/clear-session": return { type: "CMD-N15", requiresRevision: false };
    case "/api/novel/chapter/resettle": return { type: "CMD-L03", requiresRevision: true };
    case "/api/novel/rewrite": return { type: action === "clear" ? "CMD-G07" : "CMD-G06", requiresRevision: true };
    case "/api/novel/eval": return { type: "CMD-S09", requiresRevision: false };
    case "/api/novel/debt": return { type: "CMD-L13", requiresRevision: true };
    case "/api/novel/image": return { type: payload.kind === "cover" ? "CMD-M09" : "CMD-M08", requiresRevision: true };
    case "/api/novel/character/portrait": return { type: "CMD-M07", requiresRevision: true };
    case "/api/novel/media/plan": return { type: "CMD-M01", requiresRevision: false };
    case "/api/novel/media/generate": return { type: payload.kind === "video" ? "CMD-M03" : "CMD-M02", requiresRevision: true };
    case "/api/novel/media/cancel": return { type: "CMD-M13", requiresRevision: true };
    case "/api/novel/media/regenerate": return { type: "CMD-M05", requiresRevision: true };
    case "/api/novel/media/delete": return { type: "CMD-M06", requiresRevision: true };
    case "/api/novel/cover/upload": return { type: "CMD-M10", requiresRevision: true };
    case "/api/novel/chapter/regenerate": return { type: "CMD-N05", requiresRevision: true };
    case "/api/novel/chapter/rollback": return { type: "CMD-N07", requiresRevision: true };
    case "/api/novel/chapter/delete": return action === "preview" || payload.phase === "preview" ? null : { type: "CMD-N08", requiresRevision: true };
    case "/api/novel/integrity": return action === "repair" ? { type: "CMD-S02", requiresRevision: true } : action === "resettle" ? { type: "CMD-L04", requiresRevision: true } : null;
    default: return null;
  }
}
