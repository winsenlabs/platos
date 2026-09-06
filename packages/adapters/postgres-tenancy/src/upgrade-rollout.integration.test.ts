// The store half of WIN-258's rollout acceptance, on a real database.
//
// The binary half lives in `internal-packages/tenancy-database`: two rebuilt old
// clients, a measured catalogue difference, and a sweep over every table each
// old binary knows. This suite asks the other question, the one only the T5
// stores can answer:
//
//   FORWARD  — do the V1 stores read rows written WITHOUT any column added since
//              the baseline? Every row here was written by the c25432c5 client,
//              which physically cannot name `MessageAttachment.agentId`,
//              `MessageAttachment.threadId` or `EntityToolPolicy.environmentId`
//              because that release did not have them. The stores read those
//              three columns as ownership, so what they see is what the
//              migration's backfill derived, not what any writer supplied.
//
//   BACKWARD — does the binary being replaced read what the V1 STORES wrote? Not
//              what the client wrote: the stores are what a V1 pod runs, and a
//              store writes a subset of the columns with values of its own
//              choosing. The rollout partner's client is open on the same
//              database and reads each written row back.
//
// WHY THIS IS NOT THE ARGUMENT THE EARLIER TRANCHES MADE. "We added no column,
// so nothing can have broken" is a claim about the migrations. It is silent
// about a backfill that derived the wrong owner, about a store that reads a
// column the old binary writes differently, and about the two rows below whose
// stored values the upgrade REWROTE. All three are observations here.

import { afterAll, beforeAll, expect, test } from "vitest";

// `environmentScope` comes from `channels`, and `channels-harness.ts` beside
// this file takes it from the same place: `files` and `tools` re-export the
// kernel TYPE their signatures name but not the constructor, and adding
// `@platos/kernel` to this package's manifest for one function would add a
// workspace edge `scripts/arch/v1-project-graph.mjs` counts.
import { environmentScope } from "@platos/context-channels/application/ports/index.js";

import type {
  ActorId,
  EntityToolPolicy,
  EntityToolPolicyId,
  Result,
  ToolId,
  ToolName,
} from "@platos/context-tools/application/ports/index.js";
import { asToolsIdentifier } from "@platos/context-tools/application/ports/index.js";
import type {
  AgentId,
  AttachmentId,
  AttachmentScope,
  ThreadScope,
} from "@platos/context-files/application/ports/index.js";
import { asIdentifier as asFilesIdentifier } from "@platos/context-files/application/ports/index.js";

import {
  attachmentFixture,
  endUserIdOf,
  envIdOf,
  orgIdOf,
  projIdOf,
  threadIdOf,
} from "./files-fixtures.js";
import type { RolloutHarness } from "./upgrade-rollout-harness.js";
import { ROLLOUT_IDS, startRolloutHarness } from "./upgrade-rollout-harness.js";
import { entityIdOf, envId, orgId, projId, slugOf } from "./harness.js";

const ids = ROLLOUT_IDS;

/** Rows the V1 STORES write during the rollout window. */
const written = {
  attachment: "33000000-0000-4000-8000-000000000001",
  organization: "33000000-0000-4000-8000-000000000002",
  project: "33000000-0000-4000-8000-000000000003",
  environment: "33000000-0000-4000-8000-000000000004",
} as const;

const AT = new Date("2026-05-01T09:00:00.000Z");

let harness: RolloutHarness;
let scope: ReturnType<typeof environmentScope>;
let thread: ThreadScope;
let attachmentScopeOfLegacy: AttachmentScope;

beforeAll(async () => {
  harness = await startRolloutHarness();
  scope = environmentScope(
    orgIdOf(ids.organization),
    projIdOf(ids.project),
    envIdOf(ids.environment),
  );
  thread = { environment: scope, threadId: threadIdOf(ids.thread) };
  attachmentScopeOfLegacy = {
    environment: scope,
    threadId: threadIdOf(ids.thread),
    owner: {
      endUserId: endUserIdOf(ids.endUser),
      agentId: asFilesIdentifier<AgentId>(ids.agent),
    },
  };
}, 900_000);

afterAll(async () => {
  await harness?.stop();
});

test("the V1 stores read the tenancy tree a legacy release wrote", async () => {
  const ancestry = await harness.adapter.loadEnvironmentAncestry(envId(ids.environment));
  expect(ancestry).not.toBeNull();
  expect({
    organizationSlug: ancestry?.organization.slug,
    projectSlug: ancestry?.project.slug,
    environmentSlug: ancestry?.environment.slug,
    // NEVER WRITTEN BY THE LEGACY BINARY. The column did not exist when these
    // rows were created; the fence migration added it and backfilled zero.
    revocationVersion: ancestry?.environment.accessKeyRevocationVersion,
  }).toEqual({
    organizationSlug: "rollout",
    projectSlug: "rollout",
    environmentSlug: "production",
    revocationVersion: 0,
  });

  const entity = await harness.adapter.findEntityByExternalId(
    projId(ids.project),
    "rollout-entity",
  );
  expect(entity?.displayName).toBe("Rollout entity");
});

test("the V1 stores read ownership no legacy writer ever supplied", async () => {
  // `MessageAttachment.agentId` and `.threadId` are how the files store scopes
  // an attachment. The legacy client could not set either. Both come from the
  // m4 backfill, and the store's own read is what proves the backfill derived
  // the OWNER the store expects rather than merely a non-null value.
  const attachment = value(
    await harness.adapter.findAttachment(thread, asFilesIdentifier<AttachmentId>(ids.attachment)),
  );
  expect(attachment).not.toBeNull();
  expect({
    threadId: attachment?.scope.threadId,
    agentId: attachment?.scope.owner.agentId,
    endUserId: attachment?.scope.owner.endUserId,
    binding: attachment?.binding,
    storageKey: attachment?.storageKey,
    bytes: attachment?.bytes,
    originalName: attachment?.originalName,
  }).toEqual({
    threadId: ids.thread,
    agentId: ids.agent,
    endUserId: ids.endUser,
    binding: { state: "bound", turnId: ids.turn },
    storageKey: "legacy-attachment",
    bytes: 17,
    originalName: "preserve-me.txt",
  });

  // A scope-shaped read is the sharpest form of the same question: an
  // attachment whose backfilled thread pointed anywhere else would be invisible
  // here rather than merely wrong.
  const inScope = value(
    await harness.adapter.findAttachmentsInScope(attachmentScopeOfLegacy, 10),
  );
  expect(inScope.map((row) => row.storageKey)).toEqual(["legacy-attachment"]);

  // Same shape one context over: the tools store reads an EntityToolPolicy whose
  // environment was derived, not written.
  const policies = value(
    await harness.adapter.listEntityToolPolicies(scope, entityIdOf(ids.entity)),
  );
  expect(
    policies.map((policy) => ({
      environmentId: policy.environmentId,
      toolName: policy.toolName,
      effect: policy.effect,
      scopeLabels: [...policy.scopeLabels],
      addedBy: policy.addedBy,
    })),
  ).toEqual([
    {
      environmentId: ids.environment,
      toolName: "rollout_tool",
      effect: "ALLOW",
      scopeLabels: ["tools:read"],
      addedBy: "legacy-binary",
    },
  ]);
});

test("the V1 stores read a thread written before the fork columns existed", async () => {
  const legacyThread = value(await harness.adapter.threads.findThread(scope, threadIdOf(ids.thread)));
  expect(legacyThread).not.toBeNull();
  expect(legacyThread?.title).toBe("legacy thread");

  // The fork columns arrived nullable and defaulted, which is what makes the
  // upgrade an expansion for this table. The store reads the defaults rather
  // than refusing a row that predates them.
  const stored = await harness.client.thread.findUniqueOrThrow({
    where: { id: ids.thread },
    select: { forkedUpToTurnId: true, forkedTurnIds: true },
  });
  expect(stored).toEqual({ forkedUpToTurnId: null, forkedTurnIds: [] });
});

test("the binary being replaced reads back what the V1 stores wrote", async () => {
  const attachment = attachmentFixture(attachmentScopeOfLegacy, written.attachment, {
    turnId: ids.turn,
    kind: "document",
    mimeType: "text/plain",
    bytes: 41,
    storageKey: "written-by-the-v1-store",
    originalName: "rollout.txt",
    contentHash: null,
    createdAt: AT,
    expiresAt: null,
  });
  value(
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.insertAttachment(attachment, transaction),
    ),
  );

  const seenByPartner = await harness.partnerRow("MessageAttachment", written.attachment);
  expect(seenByPartner).toMatchObject({
    id: written.attachment,
    environmentId: ids.environment,
    endUserId: ids.endUser,
    agentId: ids.agent,
    threadId: ids.thread,
    turnId: ids.turn,
    kind: "document",
    mimeType: "text/plain",
    bytes: 41,
    storageKey: "written-by-the-v1-store",
    originalName: "rollout.txt",
    contentHash: null,
    expiresAt: null,
  });
  // Every column the old binary knows is present and decoded — a column the V1
  // store wrote with a value the old client could not read would surface as a
  // rejected promise above, not as a missing key here.
  expect(Object.keys(seenByPartner ?? {}).sort()).toEqual(
    partnerColumns("MessageAttachment").sort(),
  );
});

test("the binary being replaced reads a policy the V1 store scoped to an environment", async () => {
  const policy: EntityToolPolicy = {
    entityToolPolicyId: asToolsIdentifier<EntityToolPolicyId>("<minted>"),
    environmentId: scope.environmentId,
    entityId: entityIdOf(ids.entity),
    toolId: asToolsIdentifier<ToolId>(ids.tool),
    toolName: asToolsIdentifier<ToolName>("rollout_tool"),
    effect: "DENY",
    minIdentityMode: "oidc",
    scopeLabels: ["tools:write"],
    allowedPatIds: [],
    addedBy: asToolsIdentifier<ActorId>("v1-store"),
    addedAt: AT,
    lastReviewedAt: null,
  };
  const stored = value(await harness.adapter.upsertEntityToolPolicy(policy));

  const seenByPartner = await harness.partnerRow(
    "EntityToolPolicy",
    stored.entityToolPolicyId as unknown as string,
  );
  expect(seenByPartner).toMatchObject({
    entityId: ids.entity,
    toolId: ids.tool,
    effect: "DENY",
    minIdentityMode: "oidc",
    addedBy: "v1-store",
  });
});

test("the binary being replaced reads a tenancy tree the V1 stores minted", async () => {
  await harness.adapter.unitOfWork.run(async (transaction) => {
    await harness.adapter.saveOrganization(
      {
        id: orgId(written.organization),
        slug: slugOf("rollout-window"),
        name: "Rollout window",
        archivedAt: null,
        createdAt: AT,
        updatedAt: AT,
      },
      transaction,
    );
    await harness.adapter.saveProject(
      {
        id: projId(written.project),
        organizationId: orgId(written.organization),
        slug: slugOf("rollout-window"),
        name: "Rollout window",
        archivedAt: null,
        createdAt: AT,
        updatedAt: AT,
      },
      transaction,
    );
    await harness.adapter.saveEnvironment(
      {
        id: envId(written.environment),
        projectId: projId(written.project),
        slug: slugOf("production"),
        name: "Production",
        archivedAt: null,
        accessKeyRevocationVersion: 4,
        memoryFeedbackBackfillCursor: null,
        memoryFeedbackBackfillCompletedAt: null,
        createdAt: AT,
        updatedAt: AT,
      },
      transaction,
    );
  });

  await expect(harness.partnerRow("Organization", written.organization)).resolves.toMatchObject({
    slug: "rollout-window",
    name: "Rollout window",
  });
  await expect(harness.partnerRow("Project", written.project)).resolves.toMatchObject({
    organizationId: written.organization,
    slug: "rollout-window",
  });
  // The revocation counter is a column the migration added. The old binary
  // knows it — it shipped the same fence — so a V1 store's value reads back.
  await expect(harness.partnerRow("Environment", written.environment)).resolves.toMatchObject({
    projectId: written.project,
    accessKeyRevocationVersion: 4,
  });
});

function value<Value>(result: Result<Value>): Value {
  if (!result.ok) throw new Error(`the rehearsal requires this to succeed: ${result.error.code}`);
  return result.value;
}

/** Every column name the rollout partner's client selects for a model. */
function partnerColumns(modelName: string): string[] {
  const model = harness.rolloutPartnerDatamodel.models.find(
    (candidate) => candidate.name === modelName,
  );
  if (model === undefined) throw new Error(`the rollout partner has no model ${modelName}`);
  return model.fields
    .filter((field) => field.kind === "scalar" || field.kind === "enum")
    .map((field) => field.name);
}
