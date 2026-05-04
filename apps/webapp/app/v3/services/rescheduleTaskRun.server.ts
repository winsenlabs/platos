import { RescheduleRunRequestBody } from "@platos/core/v3";
import { TaskRun } from "@platos/database";
import { parseDelay } from "~/utils/delays";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { engine } from "../runEngine.server";

export class RescheduleTaskRunService extends BaseService {
  public async call(taskRun: TaskRun, body: RescheduleRunRequestBody) {
    if (taskRun.status !== "DELAYED") {
      throw new ServiceValidationError("Cannot reschedule a run that is not delayed");
    }

    const delay = await parseDelay(body.delay);

    if (!delay) {
      throw new ServiceValidationError(`Invalid delay: ${body.delay}`);
    }

    await this._prisma.taskRun.update({
      where: {
        id: taskRun.id,
      },
      data: {
        delayUntil: delay,
        queueTimestamp: delay,
      },
    });

    return engine.rescheduleDelayedRun({ runId: taskRun.id, delayUntil: delay });
  }
}
