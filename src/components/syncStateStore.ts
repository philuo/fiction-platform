import { useSyncExternalStore } from "react";
import type { WorldState } from "../api/world";
import { applyJsonPatch, sha256Json, type JsonPatchOperation } from "../shared/json-patch";
import { clearStoryRevisions, setStoryRevision } from "../shared/command-revisions";

export type SystemSyncState = {
  title: string;
  world: WorldState;
  visual: { running: boolean; pending: { id: string; name: string }[]; failed: { id: string; name: string; reason?: string }[] };
  autoSession: Record<string, unknown> | null;
  autoPending: Record<string, unknown> | null;
  advanceTask: Record<string, unknown> | null;
  at: number;
  revision?: number;
  hash?: string;
};

export type BrainSyncState = {
  title: string;
  sessions: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  at: number;
  revision?: number;
  hash?: string;
};

export type LibrarySyncState = {
  stories: { slug: string; title: string; genre: string; chapters: number; updatedAt: string; cover?: string }[];
  tasks: { id: string; idea: string; genre: string; status: string; title?: string; stage?: string; error?: string; createdAt: string; updatedAt: string }[];
  revision: number;
  hash: string;
};

const states = new Map<string, SystemSyncState>();
const brainStates = new Map<string, BrainSyncState>();
let libraryState: LibrarySyncState | null = null;
let serverInstanceId: string | null = null;
const listeners = new Set<() => void>();

export type ProjectionWrite = "accepted" | "stale" | "conflict";
export type ProjectionPatchWrite = ProjectionWrite | "missing" | "gap" | "invalid";

export function setSystemSyncState(state: SystemSyncState): ProjectionWrite {
  const previous = states.get(state.title);
  if (previous?.revision != null && state.revision != null) {
    if (state.revision < previous.revision) return "stale";
    if (state.revision === previous.revision && previous.hash && state.hash && previous.hash !== state.hash) return "conflict";
  }
  states.set(state.title, state);
  setStoryRevision(state.title, state.revision);
  for (const listener of [...listeners]) listener();
  return "accepted";
}

export function getSystemSyncState(title: string | null): SystemSyncState | null {
  return title ? states.get(title) ?? null : null;
}

export function setBrainSyncState(state: BrainSyncState): ProjectionWrite {
  const previous = brainStates.get(state.title);
  if (previous?.revision != null && state.revision != null) {
    if (state.revision < previous.revision) return "stale";
    if (state.revision === previous.revision && previous.hash && state.hash && previous.hash !== state.hash) return "conflict";
  }
  brainStates.set(state.title, state);
  for (const listener of [...listeners]) listener();
  return "accepted";
}

export function setLibrarySyncState(state: LibrarySyncState): ProjectionWrite {
  if (libraryState) {
    if (state.revision < libraryState.revision) return "stale";
    if (state.revision === libraryState.revision && libraryState.hash && state.hash && libraryState.hash !== state.hash) return "conflict";
  }
  libraryState = state;
  for (const listener of [...listeners]) listener();
  return "accepted";
}

export function acceptServerInstance(next: string): void {
  if (serverInstanceId && serverInstanceId !== next) {
    states.clear();
    brainStates.clear();
    libraryState = null;
    clearStoryRevisions();
  }
  serverInstanceId = next;
  for (const listener of [...listeners]) listener();
}

export function getLibrarySyncState(): LibrarySyncState | null { return libraryState; }

export async function applyProjectionPatch(frame: {
  scope: string; document: string; baseRevision: number; revision: number; hash: string; ops: JsonPatchOperation[];
}): Promise<ProjectionPatchWrite> {
  let current: Record<string, unknown> | null = null;
  if (frame.scope === "user" && frame.document === "library" && libraryState) {
    const { revision: _revision, hash: _hash, ...data } = libraryState;
    current = data;
  } else if (frame.scope.startsWith("story/") && frame.document === "system") {
    const state = states.get(frame.scope.slice("story/".length));
    if (state) {
      const { revision: _revision, hash: _hash, at: _at, ...data } = state;
      current = data as unknown as Record<string, unknown>;
    }
  } else if (frame.scope.startsWith("story/") && frame.document === "brain") {
    const state = brainStates.get(frame.scope.slice("story/".length));
    if (state) current = { title: state.title, sessions: state.sessions, tasks: state.tasks };
  }
  if (!current) return "missing";
  const currentRevision = frame.document === "library" ? libraryState?.revision
    : frame.document === "system" ? states.get(frame.scope.slice("story/".length))?.revision
      : brainStates.get(frame.scope.slice("story/".length))?.revision;
  if (currentRevision == null) return "missing";
  if (frame.revision <= currentRevision) return "stale";
  if (frame.baseRevision !== currentRevision) return "gap";
  try {
    const next = applyJsonPatch(current, frame.ops);
    if (await sha256Json(next) !== frame.hash) return "conflict";
    if (frame.scope === "user" && frame.document === "library") {
      return setLibrarySyncState({ ...(next as unknown as Omit<LibrarySyncState, "revision" | "hash">), revision: frame.revision, hash: frame.hash });
    }
    const title = frame.scope.slice("story/".length);
    if (frame.document === "system") {
      return setSystemSyncState({ ...(next as unknown as SystemSyncState), title, at: Date.now(), revision: frame.revision, hash: frame.hash });
    }
    if (frame.document === "brain") {
      const data = next as { sessions: Record<string, unknown>[]; tasks: Record<string, unknown>[] };
      return setBrainSyncState({ title, sessions: data.sessions, tasks: data.tasks, at: Date.now(), revision: frame.revision, hash: frame.hash });
    }
    return "invalid";
  } catch {
    return "invalid";
  }
}

/** 测试与登出隔离：清空全部权威投影和服务纪元。 */
export function resetSyncStores(): void {
  states.clear();
  brainStates.clear();
  libraryState = null;
  serverInstanceId = null;
  clearStoryRevisions();
  for (const listener of [...listeners]) listener();
}

export function getBrainSyncState(title: string | null): BrainSyncState | null {
  return title ? brainStates.get(title) ?? null : null;
}

export function clearSystemSyncState(title?: string): void {
  if (title) states.delete(title);
  else states.clear();
  if (title) brainStates.delete(title);
  else brainStates.clear();
  for (const listener of [...listeners]) listener();
}

export function useSystemSyncState(title: string | null): SystemSyncState | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => getSystemSyncState(title),
    () => getSystemSyncState(title),
  );
}

export function useBrainSyncState(title: string | null): BrainSyncState | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => getBrainSyncState(title),
    () => getBrainSyncState(title),
  );
}

export function useLibrarySyncState(): LibrarySyncState | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => libraryState,
    () => libraryState,
  );
}
