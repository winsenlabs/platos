import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CredentialKind,
  OrganizationRole,
  PrismaClient,
} from "../generated/control";
import {
  authorizeEnvironmentOperator,
  authorizeEnvironmentRuntime,
  authorizeEnvironmentService,
  type OperatorAuthorization,
} from "./auth";
import { EnvironmentVariableStore } from "./environment-variables";
import { CredentialRootKeyRing, PlatosSecretStore } from "./secrets";

describe("WIN-124 canonical persistence", () => {
  let container: StartedPostgreSqlContainer;
  let database: PrismaClient;
  let environmentId: string;
  let otherEnvironmentId: string;
  let userId: string;
  let secrets: PlatosSecretStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    execFileSync(
      resolve(process.cwd(), "node_modules/.bin/prisma"),
      ["migrate", "deploy", "--schema", resolve(process.cwd(), "prisma/schema.prisma")],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      },
    );
    database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    const user = await database.user.create({ data: { email: "win124@example.test" } });
    userId = user.id;
    const organization = await database.organization.create({
      data: { slug: "win124-org", name: "WIN-124 org" },
    });
    await database.organizationMembership.create({
      data: { organizationId: organization.id, userId, role: OrganizationRole.ADMIN },
    });
    const project = await database.project.create({
      data: { organizationId: organization.id, slug: "win124-project", name: "WIN-124 project" },
    });
    environmentId = (
      await database.environment.create({
        data: { projectId: project.id, slug: "development", name: "Development" },
      })
    ).id;

    const otherOrganization = await database.organization.create({
      data: { slug: "win124-other-org", name: "Other org" },
    });
    const otherProject = await database.project.create({
      data: { organizationId: otherOrganization.id, slug: "other-project", name: "Other project" },
    });
    otherEnvironmentId = (
      await database.environment.create({
        data: { projectId: otherProject.id, slug: "development", name: "Development" },
      })
    ).id;

    secrets = new PlatosSecretStore(
      database,
      new CredentialRootKeyRing({ activeVersion: 1, keys: { 1: randomBytes(32) } }),
    );
  }, 120_000);

  afterAll(async () => {
    await database?.$disconnect();
    await container?.stop();
  });

  test("sets, reads, redacts, transitions, isolates, and deletes Environment variables", async () => {
    const mutate = await authorizeEnvironmentOperator(
      database,
      operatorAuth(userId),
      environmentId,
      "secret:mutate",
    );
    const runtime = await authorizeEnvironmentRuntime(database, {
      actorId: "runtime:win124",
      environmentId,
    });
    const foreignRuntime = await authorizeEnvironmentRuntime(database, {
      actorId: "runtime:foreign",
      environmentId: otherEnvironmentId,
    });
    const variables = new EnvironmentVariableStore(database, secrets);

    const plain = await variables.set({
      authorization: mutate,
      key: "PUBLIC_ORIGIN",
      value: "https://example.test",
      secret: false,
    });
    expect(plain).toMatchObject({ kind: "PLAIN", version: 1, value: "https://example.test" });
    await expect(variables.read({ authorization: runtime, key: "PUBLIC_ORIGIN" })).resolves.toBe(
      "https://example.test",
    );

    const secret = await variables.set({
      authorization: mutate,
      key: "API_TOKEN",
      value: "sentinel-win124-secret",
      secret: true,
    });
    expect(secret).toMatchObject({ kind: "SECRET", version: 1, hasSecret: true });
    expect(JSON.stringify(secret)).not.toContain("sentinel-win124-secret");
    expect(JSON.stringify(secret)).not.toContain("ciphertext");
    const listed = await variables.list(mutate);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "API_TOKEN", kind: "SECRET", hasSecret: true }),
        expect.objectContaining({ key: "PUBLIC_ORIGIN", value: "https://example.test" }),
      ]),
    );
    expect(JSON.stringify(listed)).not.toContain("sentinel-win124-secret");
    const material = await variables.read({ authorization: runtime, key: "API_TOKEN" });
    if (typeof material === "string") throw new Error("secret variable returned plaintext string");
    expect(material.reveal()).toBe("sentinel-win124-secret");
    expect(JSON.stringify(material)).not.toContain("sentinel-win124-secret");

    await expect(
      variables.read({ authorization: foreignRuntime, key: "API_TOKEN" }),
    ).rejects.toMatchObject({ code: "variable_unavailable" });

    const rotated = await variables.set({
      authorization: mutate,
      key: "API_TOKEN",
      value: "sentinel-win124-rotated",
      secret: true,
    });
    expect(rotated.version).toBe(2);
    const rotatedMaterial = await variables.read({ authorization: runtime, key: "API_TOKEN" });
    if (typeof rotatedMaterial === "string") throw new Error("secret variable returned plaintext string");
    expect(rotatedMaterial.reveal()).toBe("sentinel-win124-rotated");

    const formerCredentialId = rotated.credentialId;
    const transitioned = await variables.set({
      authorization: mutate,
      key: "API_TOKEN",
      value: "plain-now",
      secret: false,
    });
    expect(transitioned).toMatchObject({ kind: "PLAIN", version: 3, value: "plain-now" });
    expect(transitioned.credentialId).toBeNull();
    expect(await database.credential.findUnique({ where: { id: formerCredentialId! } })).toMatchObject({
      activeSecretVersionId: null,
      revokedAt: expect.any(Date),
    });

    const deletedSecret = await variables.set({
      authorization: mutate,
      key: "DELETE_TOKEN",
      value: "sentinel-delete-secret",
      secret: true,
    });
    await expect(variables.delete({ authorization: mutate, key: "DELETE_TOKEN" })).resolves.toEqual({
      deleted: true,
      key: "DELETE_TOKEN",
    });
    expect(await database.credential.findUnique({ where: { id: deletedSecret.credentialId! } })).toMatchObject({
      activeSecretVersionId: null,
      revokedAt: expect.any(Date),
    });

    await expect(variables.delete({ authorization: mutate, key: "API_TOKEN" })).resolves.toEqual({
      deleted: true,
      key: "API_TOKEN",
    });
    await expect(variables.delete({ authorization: mutate, key: "API_TOKEN" })).resolves.toEqual({
      deleted: false,
      key: "API_TOKEN",
    });
    await expect(
      variables.read({ authorization: runtime, key: "API_TOKEN" }),
    ).rejects.toMatchObject({ code: "variable_unavailable" });
  });

  test("lets an authenticated integration write canonical variables visible to runtime", async () => {
    const service = await authorizeEnvironmentService(database, {
      actorId: "integration:vercel",
      environmentId,
    });
    const runtime = await authorizeEnvironmentRuntime(database, {
      actorId: "runtime:worker",
      environmentId,
    });
    const variables = new EnvironmentVariableStore(database, secrets);

    await variables.set({
      authorization: service,
      key: "VERCEL_CANONICAL_SYNC",
      value: "synced-value",
      secret: false,
    });

    await expect(
      variables.read({ authorization: runtime, key: "VERCEL_CANONICAL_SYNC" }),
    ).resolves.toBe("synced-value");
    await expect(
      database.environmentVariable.findUnique({
        where: { environmentId_key: { environmentId, key: "VERCEL_CANONICAL_SYNC" } },
      }),
    ).resolves.toMatchObject({
      environmentId,
      kind: "PLAIN",
      value: "synced-value",
      lastUpdatedBy: "integration:vercel",
    });
  });

  test("enforces Environment variable shape, key limits, and same-Environment credential kinds", async () => {
    const mutate = await authorizeEnvironmentOperator(
      database,
      operatorAuth(userId),
      environmentId,
      "secret:mutate",
    );
    const variables = new EnvironmentVariableStore(database, secrets);
    await expect(
      variables.set({ authorization: mutate, key: "lowercase", value: "value", secret: false }),
    ).rejects.toMatchObject({ code: "name_invalid" });
    await expect(
      variables.set({ authorization: mutate, key: "TOO_LARGE", value: "x".repeat(8193), secret: false }),
    ).rejects.toMatchObject({ code: "value_too_long" });

    const wrongKind = await secrets.create({
      authorization: mutate,
      name: "WRONG_KIND",
      plaintext: "not-an-env-reference",
      kind: CredentialKind.CHANNEL_SECRET,
    });
    await expect(
      database.environmentVariable.create({
        data: {
          environmentId,
          key: "WRONG_KIND",
          kind: "SECRET",
          credentialId: wrongKind.id,
        },
      }),
    ).rejects.toThrow(/wrong kind/);

    const otherUser = await database.user.create({ data: { email: "win124-other@example.test" } });
    const otherOrganization = await database.organization.findFirstOrThrow({
      where: { projects: { some: { environments: { some: { id: otherEnvironmentId } } } } },
    });
    await database.organizationMembership.create({
      data: { organizationId: otherOrganization.id, userId: otherUser.id, role: OrganizationRole.ADMIN },
    });
    const otherMutate = await authorizeEnvironmentOperator(
      database,
      operatorAuth(otherUser.id),
      otherEnvironmentId,
      "secret:mutate",
    );
    const foreignCredential = await secrets.create({
      authorization: otherMutate,
      name: "FOREIGN_REFERENCE",
      plaintext: "foreign",
      kind: CredentialKind.SECRET_REFERENCE,
    });
    await expect(
      database.environmentVariable.create({
        data: {
          environmentId,
          key: "FOREIGN_REFERENCE",
          kind: "SECRET",
          credentialId: foreignCredential.id,
        },
      }),
    ).rejects.toThrow();
  });

  test("durably deduplicates budget events and channel deliveries and keeps attempts append-only", async () => {
    const channel = await database.alertChannel.create({
      data: {
        environmentId,
        type: "EMAIL",
        name: "Budget email",
        alertTypes: ["BUDGET"],
        configuration: { create: { email: "alerts@example.test" } },
      },
    });
    const budget = await database.budget.create({
      data: {
        environmentId,
        scope: "scope",
        period: "month",
        limitCents: 10_000,
        alertThresholds: [80],
      },
    });
    const event = await database.budgetThresholdEvent.create({
      data: {
        environmentId,
        budgetId: budget.id,
        windowKey: "2026-08",
        threshold: 80,
        spentCents: 8_000,
        runs: 10,
      },
    });
    await expect(
      database.budgetThresholdEvent.create({
        data: {
          environmentId,
          budgetId: budget.id,
          windowKey: "2026-08",
          threshold: 80,
          spentCents: 8_100,
          runs: 11,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const delivery = await database.alertDelivery.create({
      data: {
        environmentId,
        channelId: channel.id,
        budgetThresholdEventId: event.id,
        kind: "BUDGET",
        idempotencyKey: `budget:${event.id}:${channel.id}`,
      },
    });
    await expect(
      database.alertDelivery.create({
        data: {
          environmentId,
          channelId: channel.id,
          budgetThresholdEventId: event.id,
          kind: "BUDGET",
          idempotencyKey: `budget:${event.id}:${channel.id}:duplicate`,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const attempt = await database.alertDeliveryAttempt.create({
      data: {
        environmentId,
        deliveryId: delivery.id,
        attemptNumber: 1,
        status: "FAILED",
        errorCode: "adapter_unavailable",
        errorMessage: "Email adapter is unavailable",
        finishedAt: new Date(),
      },
    });
    await expect(
      database.alertDeliveryAttempt.update({
        where: { id: attempt.id },
        data: { errorCode: "altered" },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(database.alertDeliveryAttempt.delete({ where: { id: attempt.id } })).rejects.toThrow(
      /immutable/,
    );
    await expect(
      database.budgetThresholdEvent.update({
        where: { id: event.id },
        data: { spentCents: 9_000 },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(database.budgetThresholdEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /immutable/,
    );
    await expect(database.$executeRawUnsafe('TRUNCATE TABLE "BudgetThresholdEvent" CASCADE')).rejects.toThrow(
      /immutable/,
    );

    await database.budget.update({
      where: { id: budget.id },
      data: { enabled: false, deletedAt: new Date() },
    });
    await expect(database.budgetThresholdEvent.findUnique({ where: { id: event.id } })).resolves.toMatchObject({
      budgetId: budget.id,
    });
    await expect(database.alertDelivery.findUnique({ where: { id: delivery.id } })).resolves.toMatchObject({
      budgetThresholdEventId: event.id,
    });

    await database.alertChannel.update({
      where: { id: channel.id },
      data: { enabled: false, deletedAt: new Date() },
    });
    await expect(
      database.alertDeliveryAttempt.findUnique({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ id: attempt.id, deliveryId: delivery.id });
  });

  test("CRUDs EMAIL, SLACK, and WEBHOOK channels and revokes deleted linked credentials", async () => {
    const authorization = await authorizeEnvironmentOperator(
      database,
      operatorAuth(userId),
      environmentId,
      "secret:mutate",
    );
    const runtime = await authorizeEnvironmentRuntime(database, {
      actorId: "runtime:alert-channel-crud",
      environmentId,
    });
    const slackCredential = await secrets.create({
      authorization,
      name: `alert-channel:slack:${Date.now()}`,
      plaintext: "sentinel-slack-token",
      kind: CredentialKind.CHANNEL_SECRET,
    });
    const webhookCredential = await secrets.create({
      authorization,
      name: `alert-channel:webhook:${Date.now()}`,
      plaintext: "sentinel-webhook-secret",
      kind: CredentialKind.CHANNEL_SECRET,
    });
    const email = await database.alertChannel.create({
      data: {
        environmentId,
        type: "EMAIL",
        name: "CRUD email",
        alertTypes: ["BUDGET"],
        configuration: { create: { email: "crud@example.test" } },
      },
    });
    const slack = await database.alertChannel.create({
      data: {
        environmentId,
        type: "SLACK",
        name: "CRUD slack",
        alertTypes: ["BUDGET"],
        configuration: {
          create: {
            slackChannelId: "C123",
            slackChannelName: "alerts",
            credentialId: slackCredential.id,
          },
        },
      },
    });
    const webhook = await database.alertChannel.create({
      data: {
        environmentId,
        type: "WEBHOOK",
        name: "CRUD webhook",
        alertTypes: ["BUDGET"],
        configuration: {
          create: { webhookUrl: "https://8.8.8.8/hooks", credentialId: webhookCredential.id },
        },
      },
    });
    await expect(
      database.alertChannel.findMany({
        where: { id: { in: [email.id, slack.id, webhook.id] }, deletedAt: null },
      }),
    ).resolves.toHaveLength(3);
    await database.alertChannel.update({ where: { id: email.id }, data: { name: "Updated email" } });
    await database.alertChannel.update({ where: { id: slack.id }, data: { name: "Updated slack" } });
    await database.alertChannel.update({ where: { id: webhook.id }, data: { name: "Updated webhook" } });

    for (const [channelId, credentialId] of [
      [slack.id, slackCredential.id],
      [webhook.id, webhookCredential.id],
    ] as const) {
      await database.$transaction(async (tx) => {
        await tx.alertChannel.update({
          where: { id: channelId },
          data: { enabled: false, deletedAt: new Date() },
        });
        const remaining = await tx.alertChannelConfiguration.count({
          where: { credentialId, channel: { enabled: true, deletedAt: null } },
        });
        expect(remaining).toBe(0);
        await secrets.revokeInTransaction(tx, { authorization, credentialId });
      });
      await expect(database.credential.findUniqueOrThrow({ where: { id: credentialId } })).resolves.toMatchObject({
        revokedAt: expect.any(Date),
        activeSecretVersionId: null,
      });
      await expect(
        secrets.readForRuntime({
          authorization: runtime,
          credentialId,
          kind: CredentialKind.CHANNEL_SECRET,
        }),
      ).rejects.toThrow();
    }
    await database.alertChannel.update({
      where: { id: email.id },
      data: { enabled: false, deletedAt: new Date() },
    });
    await expect(
      database.alertChannel.findMany({
        where: { id: { in: [email.id, slack.id, webhook.id] }, deletedAt: null },
      }),
    ).resolves.toHaveLength(0);
  });
});

function operatorAuth(userId: string): OperatorAuthorization {
  return {
    sessionId: `session:${userId}`,
    actorUserId: userId,
    effectiveUserId: userId,
    email: `${userId}@example.test`,
    expiresAt: new Date(Date.now() + 60_000),
    mfaVerifiedAt: null,
    impersonation: null,
  };
}
