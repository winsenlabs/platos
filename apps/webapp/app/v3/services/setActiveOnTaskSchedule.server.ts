import { rejectLocalScheduleOperation } from "../externalTriggerBoundary.server";
import { BaseService } from "./baseService.server";

type Options = {
  projectId: string;
  userId: string;
  friendlyId: string;
  active: boolean;
};

export class SetActiveOnTaskScheduleService extends BaseService {
  public async call({ projectId, userId, friendlyId, active }: Options) {
    void projectId;
    void userId;
    void friendlyId;
    void active;
    return rejectLocalScheduleOperation();
  }
}
