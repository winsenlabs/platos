import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { type TestTaskData } from "../testTask";
import { rejectLocalTaskTrigger } from "../externalTriggerBoundary.server";
import { BaseService } from "./baseService.server";

export class TestTaskService extends BaseService {
  public async call(environment: AuthenticatedEnvironment, data: TestTaskData) {
    void environment;
    void data;
    return rejectLocalTaskTrigger();
  }
}
