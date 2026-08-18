import { rejectLocalScheduleOperation } from "../externalTriggerBoundary.server";
import { BaseService } from "./baseService.server";

type Options = {
  projectId: string;
  userId: string;
  friendlyId: string;
};

export class DeleteTaskScheduleService extends BaseService {
  public async call({ projectId, userId, friendlyId }: Options) {
    void projectId;
    void userId;
    void friendlyId;
    return rejectLocalScheduleOperation();
  }
}
