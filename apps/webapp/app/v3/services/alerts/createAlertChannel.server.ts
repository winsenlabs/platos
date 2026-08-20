import { randomUUID } from "node:crypto";
import {
  CredentialKind,
  authorizeEnvironmentOperator,
  type EnvironmentOperatorAuthorization,
} from "@platos/tenancy-database";
import { platosControlDatabase } from "~/services/platosControlDatabase.server";
import { platosSecretStore } from "~/services/platosCredentialStore.server";
import { prisma } from "~/db.server";
import { findProjectByRef } from "~/models/project.server";
import { validatePublicUrl } from "~/utils/urlValidator.server";
import { ServiceValidationError } from "../baseService.server";

export type CreateAlertChannelOptions = {
  environmentId?: string;
  name: string;
  alertTypes: string[];
  deduplicationKey?: string;
  channel:
    | { type: "EMAIL"; email: string }
    | { type: "WEBHOOK"; url: string; secret: string }
    | {
        type: "SLACK";
        channelId: string;
        channelName: string;
        integrationId: string | undefined;
        token?: string;
      };
};

const SUPPORTED_ALERT_TYPES = new Set([
  "TASK_RUN",
  "DEPLOYMENT_FAILURE",
  "DEPLOYMENT_SUCCESS",
  "ERROR_GROUP",
]);

/** Canonical Environment-owned alert-channel mutation service. */
export class CreateAlertChannelService {
  public async call(
    projectRef: string,
    userId: string,
    options: CreateAlertChannelOptions
  ) {
    if (!options.environmentId) {
      throw new ServiceValidationError("Environment target is required");
    }
    const authorization = await authorizePatProjectEnvironment(
      projectRef,
      userId,
      options.environmentId
    );
    if (!options.name.trim() || options.alertTypes.length === 0) {
      throw new ServiceValidationError("Name and alert types are required");
    }
    if (options.alertTypes.some((type) => !SUPPORTED_ALERT_TYPES.has(type))) {
      throw new ServiceValidationError("Unsupported alert type");
    }
    if (options.channel.type === "WEBHOOK" && !options.channel.secret) {
      throw new ServiceValidationError("Webhook signing secret is required");
    }
    if (options.channel.type === "WEBHOOK") {
      const validation = await validatePublicUrl(options.channel.url);
      if (!validation.ok) {
        throw new ServiceValidationError("Webhook URL is not public");
      }
    }
    const existing = options.deduplicationKey
      ? await platosControlDatabase.alertChannel.findFirst({
          where: {
            environmentId: authorization.environmentId,
            deduplicationKey: options.deduplicationKey,
            deletedAt: null,
          },
          select: { id: true },
        })
      : null;
    if (existing) throw new ServiceValidationError("Alert channel already exists");
    const id = randomUUID();
    return platosControlDatabase.$transaction(async (tx) => {
      let credentialId: string | null = null;
      const secret = options.channel.type === "WEBHOOK"
        ? options.channel.secret
        : options.channel.type === "SLACK"
          ? options.channel.token
          : undefined;
      if (secret) {
        credentialId = (
          await platosSecretStore.createInTransaction(tx, {
            authorization,
            name: `alert-channel:${id}`,
            plaintext: secret,
            kind: CredentialKind.CHANNEL_SECRET,
          })
        ).id;
      }
      return tx.alertChannel.create({
        data: {
          id,
          environmentId: authorization.environmentId,
          name: options.name.trim(),
          type: options.channel.type,
          alertTypes: options.alertTypes,
          deduplicationKey: options.deduplicationKey,
          userProvidedDeduplicationKey: Boolean(options.deduplicationKey),
          configuration: {
            create: options.channel.type === "EMAIL"
              ? { email: options.channel.email }
              : options.channel.type === "WEBHOOK"
                ? { webhookUrl: options.channel.url, credentialId }
                : {
                    slackChannelId: options.channel.channelId,
                    slackChannelName: options.channel.channelName,
                    integrationId: options.channel.integrationId,
                    integrationProvider: options.channel.integrationId ? "SLACK" : null,
                    credentialId,
                  },
          },
        },
        include: { configuration: true },
      });
    });
  }
}

async function authorizePatProjectEnvironment(
  projectRef: string,
  legacyUserId: string,
  environmentId: string
): Promise<EnvironmentOperatorAuthorization> {
  const legacyProject = await findProjectByRef(projectRef, legacyUserId);
  if (!legacyProject) throw new ServiceValidationError("Project not found");
  const [legacyUser, legacyOrganization] = await Promise.all([
    prisma.user.findUnique({ where: { id: legacyUserId }, select: { email: true } }),
    prisma.organization.findUnique({
      where: { id: legacyProject.organizationId },
      select: { slug: true },
    }),
  ]);
  if (!legacyUser?.email || !legacyOrganization) {
    throw new ServiceValidationError("Project not found");
  }
  const canonicalUser = await platosControlDatabase.user.findFirst({
    where: { email: { equals: legacyUser.email, mode: "insensitive" } },
    select: { id: true, email: true },
  });
  const environment = await platosControlDatabase.environment.findFirst({
    where: {
      id: environmentId,
      project: {
        slug: legacyProject.slug,
        organization: { slug: legacyOrganization.slug },
      },
      archivedAt: null,
    },
    select: { id: true },
  });
  if (!canonicalUser || !environment) {
    throw new ServiceValidationError("Environment is not part of the authorized project");
  }
  return authorizeEnvironmentOperator(
    platosControlDatabase,
    {
      sessionId: `pat:${legacyUserId}`,
      actorUserId: canonicalUser.id,
      effectiveUserId: canonicalUser.id,
      email: canonicalUser.email,
      expiresAt: new Date(Date.now() + 60_000),
      mfaVerifiedAt: null,
      impersonation: null,
    },
    environment.id,
    "secret:mutate"
  );
}
