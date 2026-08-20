import { WorkerDeployment } from "@platos/database";
import { platosControlDatabase } from "~/services/platosControlDatabase.server";
import { resolveCanonicalEnvironmentId } from "~/services/platosEnvironmentVariables.server";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { BaseService } from "../baseService.server";
import {
  DeliverCanonicalAlertService,
  type CanonicalAlertChannelForDelivery,
} from "./deliverCanonicalAlert.server";

export class PerformDeploymentAlertsService extends BaseService {
  public async call(deploymentId: string) {
    const deployment = await this._prisma.workerDeployment.findFirst({
      where: { id: deploymentId },
      include: {
        environment: true,
      },
    });

    if (!deployment) {
      return;
    }

    const alertType =
      deployment.status === "DEPLOYED" ? "DEPLOYMENT_SUCCESS" : "DEPLOYMENT_FAILURE";

    const environmentId = await resolveCanonicalEnvironmentId(deployment.environment);
    const alertChannels = await platosControlDatabase.alertChannel.findMany({
      where: {
        environmentId,
        alertTypes: {
          has: alertType,
        },
        enabled: true,
        deletedAt: null,
      },
      include: { configuration: true },
    });

    for (const alertChannel of alertChannels) {
      await this.#createAndSendAlert(alertChannel, deployment, alertType);
    }
  }

  async #createAndSendAlert(
    alertChannel: CanonicalAlertChannelForDelivery,
    deployment: WorkerDeployment,
    alertType: "DEPLOYMENT_SUCCESS" | "DEPLOYMENT_FAILURE"
  ) {
    await DeliverCanonicalAlertService.call({
      channel: alertChannel,
      alertType,
      eventId: deployment.id,
      title:
        alertType === "DEPLOYMENT_SUCCESS"
          ? `Deployment ${deployment.shortCode} succeeded`
          : `Deployment ${deployment.shortCode} failed`,
      body: `Deployment ${deployment.version} in ${deployment.environmentId} ${
        alertType === "DEPLOYMENT_SUCCESS" ? "succeeded" : "failed"
      }.`,
      payload: {
        deploymentId: deployment.friendlyId,
        shortCode: deployment.shortCode,
        version: deployment.version,
        status: deployment.status,
      },
    });
  }

  static async enqueue(deploymentId: string, runAt?: Date) {
    return await alertsWorker.enqueue({
      id: `performDeploymentAlerts:${deploymentId}`,
      job: "v3.performDeploymentAlerts",
      payload: { deploymentId },
      availableAt: runAt,
    });
  }
}
