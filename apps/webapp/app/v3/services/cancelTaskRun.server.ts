import { type TaskRun } from "@platos/database";
import { engine } from "../runEngine.server";
import { BaseService } from "./baseService.server";

export type CancelTaskRunServiceOptions = {
  reason?: string;
  cancelAttempts?: boolean;
  cancelledAt?: Date;
  bulkActionId?: string;
  /** Skip PENDING_CANCEL and finalize immediately (use when the worker is known to be dead). */
  finalizeRun?: boolean;
};

type CancelTaskRunServiceResult = {
  id: string;
  alreadyFinished: boolean;
};

export type CancelableTaskRun = Pick<
  TaskRun,
  "id" | "engine" | "status" | "friendlyId" | "taskEventStore" | "createdAt" | "completedAt"
>;

export class CancelTaskRunService extends BaseService {
  public async call(
    taskRun: CancelableTaskRun,
    options?: CancelTaskRunServiceOptions
  ): Promise<CancelTaskRunServiceResult | undefined> {
    const result = await engine.cancelRun({
      runId: taskRun.id,
      completedAt: options?.cancelledAt,
      reason: options?.reason,
      finalizeRun: options?.finalizeRun,
      bulkActionId: options?.bulkActionId,
      tx: this._prisma,
    });

    return {
      id: result.run.id,
      alreadyFinished: result.alreadyFinished,
    };
  }
}
