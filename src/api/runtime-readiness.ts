export type RuntimeReadiness = {
  serverInstanceId: string;
  ready: boolean;
  startedAt: string;
  readyAt?: string;
  recoveryError?: string;
  recoveredWorldCommits: { committed: number; aborted: number; conflicts: number };
  interruptedJobs: number;
};

const RUNTIME_KEY = "__moshift_runtime_readiness__";
type RuntimeGlobal = typeof globalThis & { [RUNTIME_KEY]?: RuntimeReadiness };

function state(): RuntimeReadiness {
  const root = globalThis as RuntimeGlobal;
  root[RUNTIME_KEY] ??= {
    serverInstanceId: crypto.randomUUID(),
    ready: false,
    startedAt: new Date().toISOString(),
    recoveredWorldCommits: { committed: 0, aborted: 0, conflicts: 0 },
    interruptedJobs: 0,
  };
  return root[RUNTIME_KEY];
}

export function runtimeReadiness(): Readonly<RuntimeReadiness> {
  return state();
}

export function markRuntimeRecovering(): void {
  Object.assign(state(), { ready: false, readyAt: undefined, recoveryError: undefined });
}

export function markRuntimeReady(result: Pick<RuntimeReadiness, "recoveredWorldCommits" | "interruptedJobs">): void {
  Object.assign(state(), result, { ready: true, readyAt: new Date().toISOString(), recoveryError: undefined });
}

export function markRuntimeRecoveryFailed(error: unknown): void {
  Object.assign(state(), { ready: false, recoveryError: error instanceof Error ? error.message : String(error) });
}
