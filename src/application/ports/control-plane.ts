import type { CommandRequest, CommandReceipt, DurableJob, JobStatus } from "../../api/control-plane";

export interface JobStore {
  create(input: { id?: string; commandId?: string; user: string | null; title?: string; kind: string; dedupeKey: string; status?: JobStatus; phase?: string; recovery?: unknown; deadlineAt?: string }): { job: DurableJob; created: boolean };
  update(id: string, patch: { status?: JobStatus; phase?: string; progress?: unknown; recovery?: unknown; result?: unknown; error?: string | null }): DurableJob | null;
  list(user: string | null, title?: string, activeOnly?: boolean): DurableJob[];
}

export interface CommandReceiptStore {
  accept(user: string | null, request: CommandRequest): { receipt: CommandReceipt; created: boolean };
  get(user: string | null, commandId: string): CommandReceipt | null;
}
