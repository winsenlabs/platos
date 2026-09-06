// The rows a legacy installation holds, written by the legacy binary itself.
//
// WIN-258 T7. Two suites need the same legacy database — the binary-level
// rehearsal in this package and the store-level one in
// `packages/adapters/postgres-tenancy` — and a fixture written twice is two
// fixtures that agree until one of them is edited.
//
// WRITTEN THROUGH THE OLD CLIENT, NOT AS SQL. `upgrade-rehearsal.integration.test.ts`
// seeds its legacy rows with hand-written INSERT statements, which is a
// statement somebody BELIEVED the old binary would emit. A create through the
// rebuilt old client physically cannot name a column that release did not have,
// so "written without any column added since the baseline" is a property of the
// tool rather than a claim about the fixture.
//
// THE RETRY COUNTER IS ADDRESSED BY DERIVATION. Its physical column is renamed
// by the ordered set, so the fixture takes the field as a parameter — resolved
// by the caller from the difference between the two frozen datamodels — rather
// than spelling either name. A literal would keep passing if a different column
// were renamed instead.

import type { UpgradeBaselineClient, UpgradeBaselineField } from "./upgrade-baseline-clients";
import { delegateOf } from "./upgrade-baseline-clients";

/** Every identifier the rehearsals share, so no fixture spells a UUID twice. */
export const ROLLOUT_IDS = {
  user: "30000000-0000-4000-8000-000000000001",
  organization: "30000000-0000-4000-8000-000000000002",
  project: "30000000-0000-4000-8000-000000000003",
  environment: "30000000-0000-4000-8000-000000000004",
  siblingEnvironment: "30000000-0000-4000-8000-000000000005",
  endUser: "30000000-0000-4000-8000-000000000006",
  agent: "30000000-0000-4000-8000-000000000007",
  agentVersion: "30000000-0000-4000-8000-000000000008",
  thread: "30000000-0000-4000-8000-000000000009",
  turn: "30000000-0000-4000-8000-00000000000a",
  attachment: "30000000-0000-4000-8000-00000000000b",
  entity: "30000000-0000-4000-8000-00000000000c",
  tool: "30000000-0000-4000-8000-00000000000d",
  mapping: "30000000-0000-4000-8000-00000000000e",
  policy: "30000000-0000-4000-8000-00000000000f",
  outbox: "30000000-0000-4000-8000-000000000010",
  memory: "30000000-0000-4000-8000-000000000011",
} as const;

/** The retry count the legacy binary recorded, preserved across the rename. */
export const LEGACY_RETRY_COUNT = 3;

/** The whole legacy database, written by the release that provisioned it. */
export async function seedAsLegacyBinary(
  client: UpgradeBaselineClient,
  retryCounter: UpgradeBaselineField,
): Promise<void> {
  const ids = ROLLOUT_IDS;
  await delegateOf(client, "User").create({
    data: { id: ids.user, email: "rollout@example.test", displayName: "Rollout" },
  });
  await delegateOf(client, "Organization").create({
    data: { id: ids.organization, slug: "rollout", name: "Rollout" },
  });
  await delegateOf(client, "Project").create({
    data: { id: ids.project, organizationId: ids.organization, slug: "rollout", name: "Rollout" },
  });
  await delegateOf(client, "Environment").create({
    data: { id: ids.environment, projectId: ids.project, slug: "production", name: "Production" },
  });
  await delegateOf(client, "Environment").create({
    data: { id: ids.siblingEnvironment, projectId: ids.project, slug: "staging", name: "Staging" },
  });
  await delegateOf(client, "EndUser").create({
    data: { id: ids.endUser, organizationId: ids.organization, displayName: "Preserved" },
  });
  await delegateOf(client, "Agent").create({
    data: { id: ids.agent, projectId: ids.project, name: "Rollout agent", slug: "rollout-agent" },
  });
  await delegateOf(client, "AgentVersion").create({
    data: {
      id: ids.agentVersion,
      agentId: ids.agent,
      versionNumber: 1,
      model: "fixture:model",
      createdBy: "legacy-binary",
    },
  });
  await delegateOf(client, "Thread").create({
    data: {
      id: ids.thread,
      environmentId: ids.environment,
      agentId: ids.agent,
      endUserId: ids.endUser,
      title: "legacy thread",
    },
  });
  await delegateOf(client, "Turn").create({
    data: {
      id: ids.turn,
      threadId: ids.thread,
      agentVersionId: ids.agentVersion,
      versionBucket: "CURRENT",
      sequence: 1,
      status: "SUCCEEDED",
    },
  });
  await delegateOf(client, "MessageAttachment").create({
    data: {
      id: ids.attachment,
      environmentId: ids.environment,
      endUserId: ids.endUser,
      turnId: ids.turn,
      kind: "document",
      mimeType: "text/plain",
      bytes: 17,
      storageKey: "legacy-attachment",
      originalName: "preserve-me.txt",
    },
  });
  await delegateOf(client, "Entity").create({
    data: {
      id: ids.entity,
      projectId: ids.project,
      externalId: "rollout-entity",
      displayName: "Rollout entity",
      connectionStatus: "connected",
      connectionKind: "mcp",
    },
  });
  await delegateOf(client, "Tool").create({
    data: {
      id: ids.tool,
      name: "rollout_tool",
      description: "Rollout rehearsal tool",
      paramSchema: {},
      schemaHash: "rollout-tool-v1",
    },
  });
  await delegateOf(client, "EnvironmentEntityTool").create({
    data: { id: ids.mapping, environmentId: ids.environment, entityId: ids.entity, toolId: ids.tool },
  });
  await delegateOf(client, "EntityToolPolicy").create({
    data: {
      id: ids.policy,
      entityId: ids.entity,
      toolId: ids.tool,
      effect: "ALLOW",
      minIdentityMode: "bearer",
      scopeLabels: ["tools:read"],
      addedBy: "legacy-binary",
    },
  });
  await delegateOf(client, "ObservabilityOutbox").create({
    data: {
      id: ids.outbox,
      turnId: ids.turn,
      organizationId: ids.organization,
      payload: { shape: "legacy" },
      status: "PENDING",
      [retryCounter.name]: LEGACY_RETRY_COUNT,
    },
  });
  await delegateOf(client, "Memory").create({
    data: {
      id: ids.memory,
      environmentId: ids.environment,
      endUserId: ids.endUser,
      agentId: ids.agent,
      kind: "fact",
      content: "written by the legacy binary",
      visibility: "subject",
      agentVisible: false,
      source: "turn",
    },
  });
}
