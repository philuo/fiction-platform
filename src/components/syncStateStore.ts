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
};

export type BrainSyncState = {
  title: string;
  sessions: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  at: number;
};

const states = new Map<string, SystemSyncState>();
const brainStates = new Map<string, BrainSyncState>();
const listeners = new Set<() => void>();

export function setSystemSyncState(state: SystemSyncState): void {
  states.set(state.title, state);
  for (const listener of [...listeners]) listener();
}

export function getSystemSyncState(title: string | null): SystemSyncState | null {
  return title ? states.get(title) ?? null : null;
}

export function setBrainSyncState(state: BrainSyncState): void {
  brainStates.set(state.title, state);
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
