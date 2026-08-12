import { useSyncExternalStore } from "react";
import type { WorldState } from "../api/world";

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

export function setSystemSyncState(state: SystemSyncState): ProjectionWrite {
  const previous = states.get(state.title);
  if (previous?.revision != null && state.revision != null) {
    if (state.revision < previous.revision) return "stale";
    if (state.revision === previous.revision && previous.hash && state.hash && previous.hash !== state.hash) return "conflict";
  }
  states.set(state.title, state);
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
  }
  serverInstanceId = next;
  for (const listener of [...listeners]) listener();
}

export function getLibrarySyncState(): LibrarySyncState | null { return libraryState; }

/** 测试与登出隔离：清空全部权威投影和服务纪元。 */
export function resetSyncStores(): void {
  states.clear();
  brainStates.clear();
  libraryState = null;
  serverInstanceId = null;
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
