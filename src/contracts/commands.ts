export type PublicCommandId = `CMD-${"N" | "W" | "L" | "M" | "G" | "S" | "Q"}${string}`;
export type CommandExecutionMode = "sync" | "job" | "stream";

export type CommandDefinition = {
  type: PublicCommandId;
  path: string;
  requiresRevision: boolean;
  execution: CommandExecutionMode;
};

const D = (type: PublicCommandId, path: string, requiresRevision: boolean, execution: CommandExecutionMode = "sync"): CommandDefinition =>
  ({ type, path, requiresRevision, execution });

export const COMMAND_DEFINITIONS = [
  D("CMD-N01", "/api/novel/new", false, "job"),
  D("CMD-N02", "/api/novel/step", true, "stream"),
  D("CMD-N03", "/api/novel/auto/start", true, "job"),
  D("CMD-N05", "/api/novel/chapter/regenerate", true),
  D("CMD-N06", "/api/novel/chapter/edit", true),
  D("CMD-N07", "/api/novel/chapter/rollback", true),
  D("CMD-N08", "/api/novel/chapter/delete", true),
  D("CMD-N09", "/api/novel/chapter/review", true),
  D("CMD-N13", "/api/novel/auto/stop", false),
  D("CMD-N14", "/api/novel/auto/skip", true),
  D("CMD-N15", "/api/novel/auto/clear-session", false),
  D("CMD-N16", "/api/novel/intervene", true),
  D("CMD-N17", "/api/novel/chapter/confirm", true),
  D("CMD-N18", "/api/novel/chapter/reject", true),
  D("CMD-N19", "/api/novel/auto/pause", false),
  D("CMD-W01", "/api/novel/outline", true),
  D("CMD-W02", "/api/novel/blueprint", false),
  D("CMD-W03", "/api/novel/blueprint", true),
  D("CMD-W04", "/api/novel/blueprint", true),
  D("CMD-W05", "/api/novel/plans", true),
  D("CMD-W07", "/api/novel/plans", true),
  D("CMD-W12", "/api/novel/world", true),
  D("CMD-W14", "/api/novel/lore", true),
  D("CMD-W16", "/api/novel/style", true),
  D("CMD-W17", "/api/novel/gacha", false),
  D("CMD-W18", "/api/novel/gacha", true),
  D("CMD-L03", "/api/novel/chapter/resettle", true),
  D("CMD-L04", "/api/novel/integrity", true),
  D("CMD-L07", "/api/novel/foreshadow", true),
  D("CMD-L11", "/api/novel/proposal", true),
  D("CMD-L13", "/api/novel/debt", true),
  D("CMD-M01", "/api/novel/media/plan", false, "job"),
  D("CMD-M02", "/api/novel/media/generate", true, "job"),
  D("CMD-M03", "/api/novel/media/generate", true, "job"),
  D("CMD-M05", "/api/novel/media/regenerate", true),
  D("CMD-M06", "/api/novel/media/delete", true),
  D("CMD-M07", "/api/novel/character/portrait", true),
  D("CMD-M08", "/api/novel/image", true),
  D("CMD-M09", "/api/novel/image", true),
  D("CMD-M10", "/api/novel/cover/upload", true),
  D("CMD-M13", "/api/novel/media/cancel", true),
  D("CMD-G02", "/api/novel/intervene", true),
  D("CMD-G03", "/api/novel/lock", true),
  D("CMD-G06", "/api/novel/rewrite", true),
  D("CMD-G07", "/api/novel/rewrite", true),
  D("CMD-S02", "/api/novel/integrity", true),
  D("CMD-S09", "/api/novel/eval", false),
  D("CMD-S12", "/api/novel/delete", true),
  D("CMD-S13", "/api/novel/proposal-closed", false),
] as const satisfies readonly CommandDefinition[];

const byType = new Map<PublicCommandId, CommandDefinition>(COMMAND_DEFINITIONS.map((definition) => [definition.type, definition]));

export function commandDefinition(type: PublicCommandId): CommandDefinition | undefined {
  return byType.get(type);
}

export type PublicCommandRoute = Pick<CommandDefinition, "type" | "requiresRevision" | "execution">;

/** Resolve payload-sensitive legacy URLs to the canonical command definition. */
export function publicCommandFor(pathname: string, payload: Record<string, unknown>): PublicCommandRoute | null {
  const action = String(payload.action ?? "");
  let type: PublicCommandId | null = null;
  switch (pathname) {
    case "/api/novel/new": type = "CMD-N01"; break;
    case "/api/novel/delete": type = "CMD-S12"; break;
    case "/api/novel/step": type = "CMD-N02"; break;
    case "/api/novel/chapter/confirm": type = "CMD-N17"; break;
    case "/api/novel/chapter/reject": type = "CMD-N18"; break;
    case "/api/novel/gacha": type = action === "apply" ? "CMD-W18" : "CMD-W17"; break;
    case "/api/novel/foreshadow": type = "CMD-L07"; break;
    case "/api/novel/outline": type = "CMD-W01"; break;
    case "/api/novel/blueprint": type = action === "confirm" ? "CMD-W03" : action === "edit" ? "CMD-W04" : "CMD-W02"; break;
    case "/api/novel/plans": type = action === "edit" ? "CMD-W07" : "CMD-W05"; break;
    case "/api/novel/chapter/edit": type = "CMD-N06"; break;
    case "/api/novel/chapter/review": type = "CMD-N09"; break;
    case "/api/novel/lore": type = "CMD-W14"; break;
    case "/api/novel/world": type = "CMD-W12"; break;
    case "/api/novel/intervene": type = action === "report" ? null : action === "interrupt" ? "CMD-N16" : "CMD-G02"; break;
    case "/api/novel/lock": type = "CMD-G03"; break;
    case "/api/novel/proposal-closed": type = "CMD-S13"; break;
    case "/api/novel/proposal": type = "CMD-L11"; break;
    case "/api/novel/style": type = "CMD-W16"; break;
    case "/api/novel/auto/start": type = "CMD-N03"; break;
    case "/api/novel/auto/stop": type = "CMD-N13"; break;
    case "/api/novel/auto/pause": type = "CMD-N19"; break;
    case "/api/novel/auto/skip": type = "CMD-N14"; break;
    case "/api/novel/auto/clear-session": type = "CMD-N15"; break;
    case "/api/novel/chapter/resettle": type = "CMD-L03"; break;
    case "/api/novel/rewrite": type = action === "clear" ? "CMD-G07" : "CMD-G06"; break;
    case "/api/novel/eval": type = "CMD-S09"; break;
    case "/api/novel/debt": type = "CMD-L13"; break;
    case "/api/novel/image": type = payload.kind === "cover" ? "CMD-M09" : "CMD-M08"; break;
    case "/api/novel/character/portrait": type = "CMD-M07"; break;
    case "/api/novel/media/plan": type = "CMD-M01"; break;
    case "/api/novel/media/generate": type = payload.kind === "video" ? "CMD-M03" : "CMD-M02"; break;
    case "/api/novel/media/cancel": type = "CMD-M13"; break;
    case "/api/novel/media/regenerate": type = "CMD-M05"; break;
    case "/api/novel/media/delete": type = "CMD-M06"; break;
    case "/api/novel/cover/upload": type = "CMD-M10"; break;
    case "/api/novel/chapter/regenerate": type = "CMD-N05"; break;
    case "/api/novel/chapter/rollback": type = "CMD-N07"; break;
    case "/api/novel/chapter/delete": type = action === "preview" || payload.phase === "preview" ? null : "CMD-N08"; break;
    case "/api/novel/integrity": type = action === "repair" ? "CMD-S02" : action === "resettle" ? "CMD-L04" : null; break;
  }
  const definition = type ? commandDefinition(type) : undefined;
  return definition ? { type: definition.type, requiresRevision: definition.requiresRevision, execution: definition.execution } : null;
}
