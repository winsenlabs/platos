import { type TaskRun } from "@platos/database";
import { rejectLocalTaskTrigger } from "../externalTriggerBoundary.server";
import { type RunOptionsData } from "../testTask";
import { BaseService } from "./baseService.server";

type OverrideOptions = {
  environmentId?: string;
  payload?: string;
  metadata?: unknown;
  bulkActionId?: string;
  triggerSource?: string;
} & RunOptionsData;

export class ReplayTaskRunService extends BaseService {
  public async call(existingTaskRun: TaskRun, overrideOptions: OverrideOptions = {}) {
    void existingTaskRun;
    void overrideOptions;
    return rejectLocalTaskTrigger();
  }
}
