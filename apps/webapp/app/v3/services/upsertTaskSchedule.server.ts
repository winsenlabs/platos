import { type UpsertSchedule } from "../schedules";
import { rejectLocalScheduleOperation } from "../externalTriggerBoundary.server";
import { BaseService } from "./baseService.server";

export type UpsertTaskScheduleServiceOptions = UpsertSchedule;

export class UpsertTaskScheduleService extends BaseService {
  public async call(projectId: string, schedule: UpsertTaskScheduleServiceOptions) {
    void projectId;
    void schedule;
    return rejectLocalScheduleOperation();
  }
}
