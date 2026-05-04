import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { engine } from "~/v3/runEngine.server";
import { getQueueSizeLimit } from "~/v3/utils/queueLimits.server";
import { BasePresenter } from "./basePresenter.server";

export type Environment = {
  running: number;
  queued: number;
  concurrencyLimit: number;
  burstFactor: number;
  runsEnabled: boolean;
  queueSizeLimit: number | null;
};

export class EnvironmentQueuePresenter extends BasePresenter {
  async call(environment: AuthenticatedEnvironment): Promise<Environment> {
    const [running, queued] = await Promise.all([
      engine.concurrencyOfEnvQueue(environment),
      engine.lengthOfEnvQueue(environment),
    ]);

    const organization = await this._replica.organization.findFirst({
      where: {
        id: environment.organizationId,
      },
      select: {
        runsEnabled: true,
        maximumDevQueueSize: true,
        maximumDeployedQueueSize: true,
      },
    });

    if (!organization) {
      throw new Error("Organization not found");
    }

    const queueSizeLimit = getQueueSizeLimit(environment.type, organization);

    return {
      running: running ?? 0,
      queued: queued ?? 0,
      concurrencyLimit: environment.maximumConcurrencyLimit,
      burstFactor: environment.concurrencyLimitBurstFactor.toNumber(),
      runsEnabled: environment.type === "DEVELOPMENT" || organization.runsEnabled,
      queueSizeLimit,
    };
  }
}
