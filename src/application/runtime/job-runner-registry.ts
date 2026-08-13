/**
 * Process-local execution handles. Durable status remains in the JobStore; values here may
 * disappear on restart and must never be rendered as authoritative business state.
 */
const maps = new Map<string, Map<string, unknown>>();
const sets = new Map<string, Set<unknown>>();

export function runtimeMap<T>(name: string): Map<string, T> {
  let registry = maps.get(name);
  if (!registry) {
    registry = new Map<string, unknown>();
    maps.set(name, registry);
  }
  return registry as Map<string, T>;
}

export function runtimeSet<T>(name: string): Set<T> {
  let registry = sets.get(name);
  if (!registry) {
    registry = new Set<unknown>();
    sets.set(name, registry);
  }
  return registry as Set<T>;
}

export function clearRuntimeRegistries(): void {
  for (const registry of maps.values()) registry.clear();
  for (const registry of sets.values()) registry.clear();
}
