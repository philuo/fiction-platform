import type { CommandReceiptStore, JobStore } from "../../application/ports/control-plane";
import { acceptCommandOnce, createJob, getCommandReceipt, listJobs, updateJob } from "../../api/control-plane";

export const sqliteJobStore: JobStore = { create: createJob, update: updateJob, list: listJobs };
export const sqliteCommandReceiptStore: CommandReceiptStore = { accept: acceptCommandOnce, get: getCommandReceipt };
