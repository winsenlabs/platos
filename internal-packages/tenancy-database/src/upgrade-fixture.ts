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
  /**
   * WIN-269 (M4.3). A `ToolHealth` row the legacy binary's HEARTBEAT handler
   * wrote, which is a different writer from the one that writes every other
   * status in this schema.
   *
   * IT IS HERE AND NOT IN A SUITE because it is the row that proves "the same
   * tools and health state appear" after a reconnect, and because a suite that
   * inserted it itself would be asserting against a row it had chosen the shape
   * of. Written through the OLD client like everything else in this file, so
   * `lastStatus: "healthy"` is a value that release could actually store rather
   * than one somebody believed it stored.
   */
  toolHealth: "30000000-0000-4000-8000-000000000012",
  outbox: "30000000-0000-4000-8000-000000000010",
  memory: "30000000-0000-4000-8000-000000000011",
} as const;

/** The retry count the legacy binary recorded, preserved across the rename. */
export const LEGACY_RETRY_COUNT = 3;

/**
 * The legacy tool's declaration, exactly as its SDK sent it.
 *
 * PUBLISHED SO A RECONNECT CAN BE DRIVEN FROM IT. "Reconnect without
 * reconfiguration" means the entity sends the declaration it already sends; a
 * suite that composed its own would be re-registering something else and calling
 * the result a reconnect.
 */
export const ROLLOUT_TOOL_DECLARATION = Object.freeze({
  name: "rollout_tool",
  description: "Rollout rehearsal tool",
  paramSchema: Object.freeze({}),
  category: "rollout-entity",
});

/**
 * `Tool.schemaHash` for that declaration: sha256 over the stable JSON of
 * `{ category, description, name, paramSchema }`, first sixteen hex characters.
 *
 * PINNED RATHER THAN COMPUTED HERE, and the pin is what makes it useful. This
 * module must not carry a second copy of the derivation — two copies agree until
 * one is edited — so the value is written down and
 * `apps/core-api/src/composition/tool-sync-reconnect.integration.test.ts`
 * RE-DERIVES it through the `tools` context's own published
 * `canonicalToolDocument` and digest port, then asserts it equals the column the
 * legacy client actually wrote. A pin this file computed for itself could not be
 * wrong; a pin two independent derivations have to agree with can be.
 */
export const ROLLOUT_TOOL_SCHEMA_HASH = "6fbe44fc2924a3f7";

/** What the legacy binary's heartbeat handler left on the tool's health row. */
export const ROLLOUT_TOOL_HEALTH = Object.freeze({
  lastStatus: "healthy",
  avgLatencyMs: 42,
});

/**
 * THE HEARTBEAT BOTH PATHS SEND, AND THE ROW BOTH PATHS MUST LEAVE BEHIND.
 *
 * WIN-269 (M4.3). Two transports write this row: the LIVE WebSocket in
 * `apps/agent/src/tool-gateway/tool-sync-ws.service.ts`, whose heartbeat handler
 * upserts `{ lastStatus, avgLatencyMs }` straight through Prisma, and
 * `POST /api/v1/tools/sync` in `apps/core-api`, which reaches
 * `ToolsContract.recordToolHealth`. Their characterization suites are in
 * different deployables and cannot import each other.
 *
 * THIS IS WHERE THEY ARE JOINED. Both send `ROLLOUT_TOOL_HEARTBEAT` and both
 * assert `ROLLOUT_TOOL_HEALTH_AFTER_HEARTBEAT`, read from here rather than
 * written down twice — so "the two paths agree" is one committed expectation two
 * suites are held to, not two expectations that happen to match today.
 *
 * `failCount`, `totalCalls` AND `totalFailures` STAY AT ZERO AND `lastCalledAt`
 * STAYS NULL, which is the half worth reading twice. A heartbeat is not a call.
 * The oracle's update set is exactly two columns, and a fold that advanced the
 * counters would make `isFailing` true for a tool nothing has ever dispatched to.
 */
export const ROLLOUT_TOOL_HEARTBEAT = Object.freeze({
  status: "degraded",
  avg_latency_ms: 91,
  error_count_1h: 2,
});

export const ROLLOUT_TOOL_HEALTH_AFTER_HEARTBEAT = Object.freeze({
  lastStatus: "degraded",
  avgLatencyMs: 91,
  failCount: 0,
  totalCalls: 0,
  totalFailures: 0,
  lastCalledAt: null,
});

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
  // THE SCHEMA HASH IS THE CONTENT DIGEST, NOT A LABEL (WIN-269, M4.3).
  //
  // It read `"rollout-tool-v1"`, which is a value NO RUNNING PRODUCT WRITES —
  // the same class of mistake as the `"CONNECTED"` conformance rows that
  // `packages/contexts/tenancy/domain/entity.ts` records. `Tool` is CONTENT
  // ADDRESSED: `@@unique([name, schemaHash])`, and both
  // `ToolRegistryService.normalizeDeclaration` and
  // `packages/contexts/tools/domain/tool.ts` derive the column as the first
  // sixteen hex characters of sha256 over the stable JSON of
  // `{ name, description, paramSchema, category }`.
  //
  // WHY THAT MATTERS TO A ROLLOUT RATHER THAN TO TIDINESS. A registration
  // find-or-creates by that pair. Against a label, a reconnecting entity that
  // re-declares the tool it already has computes a digest that matches nothing,
  // MINTS A SECOND `Tool` ROW, and repoints the exposure at it — so its tools
  // come back under new ids and its `ToolHealth` row, which is keyed by
  // `toolId`, is left behind pointing at the old one. A fixture carrying a label
  // would have made that look like the product's behaviour when it is the
  // fixture's.
  //
  // `category` IS `rollout-entity` for the same reason: with no dot in the name,
  // both derivations fall back to the entity's own external id
  // (`inferEntityToolCategory` / `inferToolCategory`), so a row without it would
  // hash to something the running product never produces.
  await delegateOf(client, "Tool").create({
    data: {
      id: ids.tool,
      name: "rollout_tool",
      description: "Rollout rehearsal tool",
      paramSchema: {},
      category: "rollout-entity",
      schemaHash: ROLLOUT_TOOL_SCHEMA_HASH,
    },
  });
  await delegateOf(client, "EnvironmentEntityTool").create({
    data: { id: ids.mapping, environmentId: ids.environment, entityId: ids.entity, toolId: ids.tool },
  });
  // THE HEARTBEAT ROW. `lastStatus` is `healthy` — the platools `ToolHealthEntry`
  // vocabulary (`healthy | degraded | down`), which
  // `apps/agent/src/tool-gateway/tool-sync-ws.service.ts` writes verbatim into
  // this column from a `heartbeat` frame. It is NOT the call vocabulary
  // (`success | failed | timeout`) the executor writes into the same column, and
  // the distinction is the point: `packages/adapters/postgres-tenancy`'s row
  // narrowing admitted only the second, so a row of this shape — the ordinary
  // state of any entity that has ever heartbeated — could not be read back by the
  // V1 stores at all.
  //
  // `lastCalledAt` STAYS NULL and the counters stay at their defaults, because
  // the heartbeat handler writes neither. A fixture that filled them in would be
  // a row no heartbeat produces.
  await delegateOf(client, "ToolHealth").create({
    data: {
      id: ids.toolHealth,
      environmentId: ids.environment,
      toolId: ids.tool,
      entityExternalId: "rollout-entity",
      lastStatus: ROLLOUT_TOOL_HEALTH.lastStatus,
      avgLatencyMs: ROLLOUT_TOOL_HEALTH.avgLatencyMs,
    },
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
