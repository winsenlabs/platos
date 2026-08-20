import { platosControlDatabase } from "~/services/platosControlDatabase.server";

export type AlertChannelListPresenterData = Awaited<ReturnType<AlertChannelListPresenter["call"]>>;
export type AlertChannelListPresenterRecord = AlertChannelListPresenterData["alertChannels"][number];
export type AlertChannelListPresenterAlertProperties = NonNullable<
  AlertChannelListPresenterRecord["properties"]
>;

/** Canonical Environment-owned alert-channel projection. Credentials remain metadata-only. */
export class AlertChannelListPresenter {
  public async call(environmentId: string) {
    const alertChannels = await platosControlDatabase.alertChannel.findMany({
      where: { environmentId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: { configuration: true },
    });
    return {
      alertChannels: alertChannels.map((channel) => ({
        id: channel.id,
        friendlyId: channel.id,
        environmentId: channel.environmentId,
        type: channel.type,
        name: channel.name,
        enabled: channel.enabled,
        alertTypes: channel.alertTypes,
        deduplicationKey: channel.deduplicationKey,
        userProvidedDeduplicationKey: channel.userProvidedDeduplicationKey,
        deletedAt: channel.deletedAt,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
        properties: presentProperties(channel.type, channel.configuration),
      })),
      limits: { used: alertChannels.length, limit: 100_000_000 },
    };
  }
}

function presentProperties(
  type: "EMAIL" | "SLACK" | "WEBHOOK",
  configuration: {
    email: string | null;
    webhookUrl: string | null;
    slackChannelId: string | null;
    slackChannelName: string | null;
    integrationId: string | null;
    credentialId: string | null;
  } | null
) {
  if (!configuration) return undefined;
  if (type === "EMAIL") return { type, email: configuration.email };
  if (type === "SLACK") {
    return {
      type,
      channelId: configuration.slackChannelId,
      channelName: configuration.slackChannelName,
      integrationId: configuration.integrationId,
      hasToken: Boolean(configuration.credentialId),
    };
  }
  return {
    type,
    url: configuration.webhookUrl,
    hasSecret: Boolean(configuration.credentialId),
  };
}
