import { createHmac } from "node:crypto";
import {
  ErrorCode,
  WebClient,
  type ChatPostMessageArguments,
  type WebAPIPlatformError,
  type WebAPIRateLimitedError,
} from "@slack/web-api";
import {
  CredentialKind,
  authorizeEnvironmentRuntime,
  type Prisma as ControlPrisma,
} from "@platos/tenancy-database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { sendAlertEmail } from "~/services/email.server";
import { logger } from "~/services/logger.server";
import { platosControlDatabase } from "~/services/platosControlDatabase.server";
import { platosSecretStore } from "~/services/platosCredentialStore.server";
import { resolveCanonicalEnvironmentId } from "~/services/platosEnvironmentVariables.server";
import { v3ErrorPath } from "~/utils/pathBuilder";
import { fetchWithValidatedRedirects } from "~/utils/urlValidator.server";
import { generateErrorGroupWebhookPayload } from "./errorGroupWebhook.server";

type ErrorAlertClassification = "new_issue" | "regression" | "unignored";

interface ErrorAlertPayload {
  channelId: string;
  projectId: string;
  classification: ErrorAlertClassification;
  error: {
    fingerprint: string;
    environmentId: string;
    environmentSlug: string;
    environmentName: string;
    taskIdentifier: string;
    errorType: string;
    errorMessage: string;
    sampleStackTrace: string;
    firstSeen: string;
    lastSeen: string;
    occurrenceCount: number;
  };
}

type CanonicalErrorChannel = ControlPrisma.AlertChannelGetPayload<{
  include: {
    configuration: true;
    environment: {
      include: { project: { include: { organization: true } } };
    };
  };
}>;

class SkipRetryError extends Error {}

export class DeliverErrorGroupAlertService {
  async call(payload: ErrorAlertPayload): Promise<void> {
    const canonicalEnvironmentId = await resolveCanonicalEnvironmentId({
      id: payload.error.environmentId,
    });
    const channel = await platosControlDatabase.alertChannel.findFirst({
      where: {
        id: payload.channelId,
        environmentId: canonicalEnvironmentId,
        enabled: true,
        deletedAt: null,
        alertTypes: { has: "ERROR_GROUP" },
      },
      include: {
        configuration: true,
        environment: {
          include: { project: { include: { organization: true } } },
        },
      },
    });

    if (!channel?.configuration) {
      logger.warn("[DeliverErrorGroupAlert] Channel not found or disabled", {
        channelId: payload.channelId,
        environmentId: canonicalEnvironmentId,
      });
      return;
    }

    const legacyProject = await prisma.project.findFirst({
      where: {
        id: payload.projectId,
        environments: { some: { id: payload.error.environmentId } },
      },
      include: { organization: true },
    });
    if (!legacyProject) {
      logger.warn("[DeliverErrorGroupAlert] Project not found", { projectId: payload.projectId });
      return;
    }

    const errorLink = `${env.APP_ORIGIN}${v3ErrorPath(
      legacyProject.organization,
      legacyProject,
      { slug: payload.error.environmentSlug },
      { fingerprint: payload.error.fingerprint }
    )}`;

    try {
      switch (channel.type) {
        case "EMAIL":
          await this.#sendEmail(channel, legacyProject, payload, errorLink);
          return;
        case "SLACK":
          await this.#sendSlack(channel, legacyProject.name, payload, errorLink);
          return;
        case "WEBHOOK":
          await this.#sendWebhook(channel, legacyProject, payload, errorLink);
          return;
      }
    } catch (error) {
      if (error instanceof SkipRetryError) {
        logger.warn("[DeliverErrorGroupAlert] Skipping retry", { reason: error.message });
        return;
      }
      throw error;
    }
  }

  async #sendEmail(
    channel: CanonicalErrorChannel,
    project: { name: string; organization: { title: string } },
    payload: ErrorAlertPayload,
    errorLink: string
  ): Promise<void> {
    if (!channel.configuration?.email) throw new Error("Alert channel email is unavailable");
    await sendAlertEmail({
      email: "alert-error-group",
      to: channel.configuration.email,
      classification: payload.classification,
      taskIdentifier: payload.error.taskIdentifier,
      environment: payload.error.environmentName,
      error: {
        message: payload.error.errorMessage,
        type: payload.error.errorType,
        stackTrace: payload.error.sampleStackTrace || undefined,
      },
      occurrenceCount: payload.error.occurrenceCount,
      errorLink,
      organization: project.organization.title,
      project: project.name,
    });
  }

  async #sendSlack(
    channel: CanonicalErrorChannel,
    projectName: string,
    payload: ErrorAlertPayload,
    errorLink: string
  ): Promise<void> {
    if (!channel.configuration?.slackChannelId) {
      throw new Error("Alert channel Slack destination is unavailable");
    }
    const token = await this.#readChannelSecret(channel);
    const label = this.#classificationLabel(payload.classification);
    const message: ChatPostMessageArguments = {
      channel: channel.configuration.slackChannelId,
      text: `${label}: ${payload.error.errorType || "Error"} in ${payload.error.taskIdentifier} [${payload.error.environmentName}]`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${label} in ${payload.error.taskIdentifier} [${payload.error.environmentName}]*`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `\`\`\`${payload.error.sampleStackTrace || payload.error.errorMessage}\`\`\``,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Project:*\n${projectName}` },
            { type: "mrkdwn", text: `*Occurrences:*\n${payload.error.occurrenceCount}` },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Investigate" },
              url: errorLink,
              style: "primary",
            },
          ],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    };

    try {
      await new WebClient(token).chat.postMessage(message);
    } catch (error) {
      if (isWebAPIRateLimitedError(error)) throw new Error("Slack rate limited");
      if (isWebAPIPlatformError(error)) {
        if (error.data.error === "invalid_blocks" || error.data.error === "account_inactive") {
          throw new SkipRetryError(`Slack: ${error.data.error}`);
        }
        throw new Error("Slack platform error");
      }
      throw error;
    }
  }

  async #sendWebhook(
    channel: CanonicalErrorChannel,
    project: {
      id: string;
      externalRef: string;
      slug: string;
      name: string;
      organizationId: string;
      organization: { slug: string; title: string };
    },
    payload: ErrorAlertPayload,
    errorLink: string
  ): Promise<void> {
    if (!channel.configuration?.webhookUrl) {
      throw new Error("Alert channel webhook URL is unavailable");
    }
    const secret = await this.#readChannelSecret(channel);
    const webhookPayload = generateErrorGroupWebhookPayload({
      classification: payload.classification,
      error: payload.error,
      organization: {
        id: project.organizationId,
        slug: project.organization.slug,
        name: project.organization.title,
      },
      project: {
        id: project.id,
        externalRef: project.externalRef,
        slug: project.slug,
        name: project.name,
      },
      dashboardUrl: errorLink,
    });
    const rawPayload = JSON.stringify(webhookPayload);
    const response = await fetchWithValidatedRedirects(channel.configuration.webhookUrl, 3, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trigger-signature-hmacsha256": createHmac("sha256", secret)
          .update(rawPayload)
          .digest("hex"),
      },
      body: rawPayload,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Error alert webhook returned ${response.status}`);
  }

  async #readChannelSecret(channel: CanonicalErrorChannel): Promise<string> {
    if (!channel.configuration?.credentialId) {
      throw new Error("Alert channel credential is unavailable");
    }
    const authorization = await authorizeEnvironmentRuntime(platosControlDatabase, {
      environmentId: channel.environmentId,
      actorId: `error-alert-delivery:${channel.id}`,
    });
    return (
      await platosSecretStore.readForRuntime({
        authorization,
        credentialId: channel.configuration.credentialId,
        kind: CredentialKind.CHANNEL_SECRET,
      })
    ).reveal();
  }

  #classificationLabel(classification: ErrorAlertClassification): string {
    switch (classification) {
      case "new_issue":
        return "New error";
      case "regression":
        return "Regression";
      case "unignored":
        return "Error resurfaced";
    }
  }
}

function isWebAPIPlatformError(error: unknown): error is WebAPIPlatformError {
  return (error as WebAPIPlatformError).code === ErrorCode.PlatformError;
}

function isWebAPIRateLimitedError(error: unknown): error is WebAPIRateLimitedError {
  return (error as WebAPIRateLimitedError).code === ErrorCode.RateLimitedError;
}
