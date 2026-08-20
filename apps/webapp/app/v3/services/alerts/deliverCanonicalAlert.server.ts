import { createHmac } from "node:crypto";
import { WebClient } from "@slack/web-api";
import {
  CredentialKind,
  authorizeEnvironmentRuntime,
  type AlertChannelType,
} from "@platos/tenancy-database";
import { sendPlainTextEmail } from "~/services/email.server";
import { logger } from "~/services/logger.server";
import { platosControlDatabase } from "~/services/platosControlDatabase.server";
import { platosSecretStore } from "~/services/platosCredentialStore.server";
import { fetchWithValidatedRedirects } from "~/utils/urlValidator.server";

export type CanonicalAlertChannelForDelivery = {
  id: string;
  environmentId: string;
  type: AlertChannelType;
  configuration: {
    email: string | null;
    webhookUrl: string | null;
    slackChannelId: string | null;
    credentialId: string | null;
  } | null;
};

export class DeliverCanonicalAlertService {
  static async call(params: {
    channel: CanonicalAlertChannelForDelivery;
    alertType: "TASK_RUN" | "DEPLOYMENT_SUCCESS" | "DEPLOYMENT_FAILURE";
    eventId: string;
    title: string;
    body: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const { channel } = params;
    if (!channel.configuration) {
      logger.warn("[DeliverCanonicalAlert] Channel configuration not found", {
        channelId: channel.id,
      });
      return;
    }

    switch (channel.type) {
      case "EMAIL": {
        if (!channel.configuration.email) throw new Error("Alert channel email is unavailable");
        await sendPlainTextEmail({
          to: channel.configuration.email,
          subject: params.title,
          text: params.body,
        });
        return;
      }
      case "SLACK": {
        if (!channel.configuration.slackChannelId) {
          throw new Error("Alert channel Slack destination is unavailable");
        }
        const token = await this.#readChannelSecret(channel);
        await new WebClient(token).chat.postMessage({
          channel: channel.configuration.slackChannelId,
          text: `${params.title}\n${params.body}`,
          unfurl_links: false,
          unfurl_media: false,
        });
        return;
      }
      case "WEBHOOK": {
        if (!channel.configuration.webhookUrl) {
          throw new Error("Alert channel webhook URL is unavailable");
        }
        const secret = await this.#readChannelSecret(channel);
        const body = JSON.stringify({
          id: params.eventId,
          type: params.alertType,
          environmentId: channel.environmentId,
          ...params.payload,
        });
        const response = await fetchWithValidatedRedirects(channel.configuration.webhookUrl, 3, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-trigger-signature-hmacsha256": createHmac("sha256", secret)
              .update(body)
              .digest("hex"),
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          throw new Error(`Alert webhook returned ${response.status}`);
        }
        return;
      }
    }
  }

  static async #readChannelSecret(channel: CanonicalAlertChannelForDelivery): Promise<string> {
    if (!channel.configuration?.credentialId) {
      throw new Error("Alert channel credential is unavailable");
    }
    const authorization = await authorizeEnvironmentRuntime(platosControlDatabase, {
      environmentId: channel.environmentId,
      actorId: `alert-delivery:${channel.id}`,
    });
    return (
      await platosSecretStore.readForRuntime({
        authorization,
        credentialId: channel.configuration.credentialId,
        kind: CredentialKind.CHANNEL_SECRET,
      })
    ).reveal();
  }
}
