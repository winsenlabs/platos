import { platosControlDatabase } from "~/services/platosControlDatabase.server";
import { resolveCanonicalEnvironmentId } from "~/services/platosEnvironmentVariables.server";
import { BasePresenter } from "./basePresenter.server";
import { NewAlertChannelPresenter } from "./NewAlertChannelPresenter.server";
import { env } from "~/env.server";

export type ErrorAlertChannelData = Awaited<ReturnType<ErrorAlertChannelPresenter["call"]>>;

export class ErrorAlertChannelPresenter extends BasePresenter {
  public async call(projectId: string, environmentId: string) {
    const canonicalEnvironmentId = await resolveCanonicalEnvironmentId({ id: environmentId });
    const channels = await platosControlDatabase.alertChannel.findMany({
      where: {
        environmentId: canonicalEnvironmentId,
        alertTypes: { has: "ERROR_GROUP" },
        deletedAt: null,
      },
      include: { configuration: true },
      orderBy: { createdAt: "asc" },
    });

    const emails: Array<{ id: string; email: string }> = [];
    const webhooks: Array<{ id: string; url: string }> = [];
    let slackChannel: { id: string; channelId: string; channelName: string } | null = null;

    for (const channel of channels) {
      switch (channel.type) {
        case "EMAIL": {
          if (channel.configuration?.email) {
            emails.push({ id: channel.id, email: channel.configuration.email });
          }
          break;
        }
        case "SLACK": {
          if (!channel.enabled) break;
          if (
            channel.configuration?.slackChannelId &&
            channel.configuration.slackChannelName
          ) {
            slackChannel = {
              id: channel.id,
              channelId: channel.configuration.slackChannelId,
              channelName: channel.configuration.slackChannelName,
            };
          }
          break;
        }
        case "WEBHOOK": {
          if (channel.configuration?.webhookUrl) {
            webhooks.push({ id: channel.id, url: channel.configuration.webhookUrl });
          }
          break;
        }
      }
    }

    const slackPresenter = new NewAlertChannelPresenter(this._prisma, this._replica);
    const slackResult = await slackPresenter.call(projectId);

    const emailAlertsEnabled =
      env.ALERT_FROM_EMAIL !== undefined && env.ALERT_RESEND_API_KEY !== undefined;

    return {
      emails,
      webhooks,
      slackChannel,
      slack: slackResult.slack,
      emailAlertsEnabled,
    };
  }
}
