import { type Prisma } from "@platos/database";
import { type prisma } from "~/db.server";
import { platosControlDatabase } from "~/services/platosControlDatabase.server";
import { resolveCanonicalEnvironmentId } from "~/services/platosEnvironmentVariables.server";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { BaseService } from "../baseService.server";
import {
  DeliverCanonicalAlertService,
  type CanonicalAlertChannelForDelivery,
} from "./deliverCanonicalAlert.server";

type FoundRun = Prisma.Result<
  typeof prisma.taskRun,
  { include: { lockedBy: true; runtimeEnvironment: true } },
  "findUniqueOrThrow"
>;

export class PerformTaskRunAlertsService extends BaseService {
  public async call(runId: string) {
    const run = await this._prisma.taskRun.findFirst({
      where: { id: runId },
      include: {
        lockedBy: true,
        runtimeEnvironment: {
          include: {
            parentEnvironment: true,
          },
        },
      },
    });

    if (!run) {
      return;
    }

    const environmentId = await resolveCanonicalEnvironmentId(run.runtimeEnvironment);
    const alertChannels = await platosControlDatabase.alertChannel.findMany({
      where: {
        environmentId,
        alertTypes: {
          has: "TASK_RUN",
        },
        enabled: true,
        deletedAt: null,
      },
      include: { configuration: true },
    });

    for (const alertChannel of alertChannels) {
      await this.#createAndSendAlert(alertChannel, run);
    }
  }

  async #createAndSendAlert(alertChannel: CanonicalAlertChannelForDelivery, run: FoundRun) {
    await DeliverCanonicalAlertService.call({
      channel: alertChannel,
      alertType: "TASK_RUN",
      eventId: run.id,
      title: `Run ${run.friendlyId} failed`,
      body: `${run.taskIdentifier} failed in ${run.runtimeEnvironment.slug}.`,
      payload: {
        runId: run.friendlyId,
        taskIdentifier: run.taskIdentifier,
        environmentSlug: run.runtimeEnvironment.slug,
      },
    });
  }

  static async enqueue(runId: string, runAt?: Date) {
    return await alertsWorker.enqueue({
      id: `performTaskRunAlerts:${runId}`,
      job: "v3.performTaskRunAlerts",
      payload: { runId },
      availableAt: runAt,
    });
  }
}
