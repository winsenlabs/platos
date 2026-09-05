// Every guard, against the constraint it restates — and every guard that has no
// constraint behind it, against the database's willingness to take the value.
//
// TWO HALVES, AND THE SECOND IS THE POINT. A guard that refuses a value proves
// only that the guard refuses it. The question this suite answers is whether the
// database would have caught it: for four guards it would, and the case shows
// the CHECK firing; for six it would NOT, and the case shows the row going in
// clean through SQL that bypasses the port. A reader can therefore tell a
// restatement from the only line of defence, which is the difference between a
// guard that may be simplified away and one that may not.
//
// THE BYPASS IS `prisma db execute`, NOT A SECOND CLIENT. Writing the bad value
// through this package's own delegate would be writing it through the guard.
// SQL applied by the ORM's CLI reaches the table with nothing in front of it but
// the constraints, which is exactly the surface under test.
//
// NONE OF THESE CONSTRAINTS IS IN `schema.prisma`. All four live only in
// `migrations/00000000000000_initial/migration.sql`, which is why a store
// written from the schema file alone would have shipped without any of them.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ChannelApp,
  ChannelAppId,
  ChannelConnection,
  ChannelConnectionId,
  ChannelInstallation,
  ChannelInstallationId,
  EnvironmentScope,
  ExternalInstallationId,
  LeaseOwner,
} from "@platos/context-channels/application/ports/index.js";
import { asIdentifier } from "@platos/context-channels/application/ports/index.js";

import { CONFORMANCE_AT } from "./channels-conformance.js";
import type { ChannelsHarness } from "./channels-harness.js";
import { startChannelsHarness } from "./channels-harness.js";

let harness: ChannelsHarness;
let scope: EnvironmentScope;
let appId: string;

beforeAll(async () => {
  harness = await startChannelsHarness();
  scope = await harness.freshScope();
  appId = harness.base.freshId("0301");
  harness.applyPeerRows(
    `INSERT INTO "ChannelApp" ("id", "environmentId", "provider", "clientId", "distribution",
                              "agentRouting", "createdAt", "updatedAt")
     VALUES ('${appId}', '${scope.environmentId}', 'slack', 'client-bypass', 'private', '[]',
             '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
  );
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

/** The database's answer to a statement written past the port. Null when it took it. */
function refusalFor(sql: string): string | null {
  try {
    harness.applyPeerRows(sql);
    return null;
  } catch (error) {
    const shown = error as { readonly stdout?: unknown; readonly stderr?: unknown };
    return `${String(shown.stdout ?? "")}${String(shown.stderr ?? "")}`;
  }
}

/** The reason a port refusal carries, or null when it did not refuse. */
function reasonOf(result: { readonly ok: boolean; readonly error?: unknown }): string | null {
  if (result.ok) return null;
  const error = result.error as { readonly details?: { readonly reason?: string } };
  return error.details?.reason ?? "";
}

function connection(overrides: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    connectionId: asIdentifier<ChannelConnectionId>(harness.base.freshId("0302")),
    scope,
    entityId: null,
    provider: "slack",
    displayName: null,
    defaultAgentId: null,
    agentRouting: [],
    enabled: true,
    credentialId: null,
    createdAt: CONFORMANCE_AT,
    ...overrides,
  };
}

function app(overrides: Partial<ChannelApp> = {}): ChannelApp {
  return {
    appId: asIdentifier<ChannelAppId>(harness.base.freshId("0303")),
    scope,
    provider: "slack",
    displayName: null,
    clientId: `client-${harness.base.freshId("0304").slice(-8)}`,
    credentialId: null,
    scopes: [],
    distribution: "private",
    defaultAgentId: null,
    agentRouting: [],
    createdAt: CONFORMANCE_AT,
    ...overrides,
  };
}

function installation(overrides: Partial<ChannelInstallation> = {}): ChannelInstallation {
  return {
    installationId: asIdentifier<ChannelInstallationId>(harness.base.freshId("0305")),
    appId: asIdentifier<ChannelAppId>(appId),
    externalInstallationId: asIdentifier<ExternalInstallationId>(
      `T${harness.base.freshId("0306").slice(-8)}`,
    ),
    displayName: null,
    credentialId: null,
    credentialRevision: 0,
    grantedScopes: [],
    defaultAgentId: null,
    agentRouting: [],
    status: "active",
    revokedAt: null,
    lastEventAt: null,
    refreshState: "IDLE",
    refreshClaimId: null,
    refreshStartedAt: null,
    refreshRepairCode: null,
    tokenGeneration: 1,
    createdAt: CONFORMANCE_AT,
    ...overrides,
  };
}

function write<Value>(work: (transaction: never) => Promise<Value>): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work as never);
}

describe("the four guards a migration-only constraint stands behind", () => {
  test("an unknown refresh state is refused by the guard AND by the CHECK", async () => {
    const refused = await write((transaction) =>
      harness.repository.saveInstallation(
        installation({ refreshState: "PAUSED" as ChannelInstallation["refreshState"] }),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain("refresh_state_unknown");
    const bypassed = refusalFor(
      `INSERT INTO "ChannelInstallation" ("id", "appId", "externalInstallationId", "status",
                                         "agentRouting", "tokenRefreshState", "createdAt", "updatedAt")
       VALUES ('${harness.base.freshId("0307")}', '${appId}', 'T-BYPASS-1', 'active', '[]', 'PAUSED',
               '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
    );
    expect(bypassed).toContain("ChannelInstallation_tokenRefreshState_check");
  });

  test("an unknown inbox status is refused by the guard AND by the CHECK", async () => {
    const refused = await write((transaction) =>
      harness.repository.insertEvent(
        {
          inboxId: asIdentifier(harness.base.freshId("0308")),
          appId: asIdentifier(appId),
          eventId: asIdentifier("Ev-status"),
          payload: { formatVersion: 1, keyVersion: 1, ciphertext: "sealed" },
          status: "RETRYING" as never,
          retryCount: 0,
          availableAt: CONFORMANCE_AT,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseGeneration: 0,
          turnId: null,
          deliveryCompletedAt: null,
          lastErrorCode: null,
          completedAt: null,
          createdAt: CONFORMANCE_AT,
        },
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain("event_status_unknown");
    const bypassed = refusalFor(
      `INSERT INTO "ChannelEventInbox" ("id", "appId", "eventId", "payloadFormatVersion",
                                       "payloadKeyVersion", "encryptedPayload", "status",
                                       "createdAt", "updatedAt")
       VALUES ('${harness.base.freshId("0309")}', '${appId}', 'Ev-bypass-1', 1, 1, 'sealed',
               'RETRYING', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
    );
    expect(bypassed).toContain("ChannelEventInbox_status_check");
  });

  test("a routing table that is not an array is refused by the guard AND by the CHECK", async () => {
    const refused = await write((transaction) =>
      harness.repository.saveConnection(
        connection({ agentRouting: { rules: [] } as never }),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain("routing_not_array");
    const bypassed = refusalFor(
      `INSERT INTO "ChannelConnection" ("id", "environmentId", "provider", "agentRouting",
                                       "createdAt", "updatedAt")
       VALUES ('${harness.base.freshId("030a")}', '${scope.environmentId}', 'slack', '{"rules": []}',
               '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
    );
    expect(bypassed).toContain("ChannelConnection_agentRouting_json_root");
  });

  test("a non-uuid identifier is refused by the guard AND by the column type", async () => {
    const refused = await write((transaction) =>
      harness.repository.saveConnection(
        connection({ connectionId: asIdentifier<ChannelConnectionId>("conn-1") }),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain("identifier_not_uuid:connectionId");
    const bypassed = refusalFor(
      `INSERT INTO "ChannelConnection" ("id", "environmentId", "provider", "agentRouting",
                                       "createdAt", "updatedAt")
       VALUES ('conn-1', '${scope.environmentId}', 'slack', '[]',
               '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
    );
    expect(bypassed).toContain("uuid");
  });
});

describe("the guards that are the only line of defence", () => {
  test("the provider vocabulary exists nowhere in the schema", async () => {
    const refused = await write((transaction) =>
      harness.repository.saveConnection(
        connection({ provider: "Slack" as ChannelConnection["provider"] }),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain("provider_unknown");
    // The column is plain TEXT. `"Slack"` beside `"slack"` is two connections
    // one adapter registry can never both find.
    expect(
      refusalFor(
        `INSERT INTO "ChannelConnection" ("id", "environmentId", "provider", "agentRouting",
                                         "createdAt", "updatedAt")
         VALUES ('${harness.base.freshId("030b")}', '${scope.environmentId}', 'Slack', '[]',
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      ),
    ).toBeNull();
  });

  test("the distribution vocabulary exists nowhere in the schema", async () => {
    const refused = await write((transaction) =>
      harness.repository.saveApp(
        app({ distribution: "PUBLIC" as ChannelApp["distribution"] }),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain("distribution_unknown");
    expect(
      refusalFor(
        `INSERT INTO "ChannelApp" ("id", "environmentId", "provider", "clientId", "distribution",
                                  "agentRouting", "createdAt", "updatedAt")
         VALUES ('${harness.base.freshId("030c")}', '${scope.environmentId}', 'slack',
                 'client-anything', 'PUBLIC', '[]',
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      ),
    ).toBeNull();
  });

  test("an installation status outside the two is taken by the column", async () => {
    const refused = await write((transaction) =>
      harness.repository.saveInstallation(
        installation({ status: "suspended" as ChannelInstallation["status"] }),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain("installation_status_unknown");
    expect(
      refusalFor(
        `INSERT INTO "ChannelInstallation" ("id", "appId", "externalInstallationId", "status",
                                           "agentRouting", "createdAt", "updatedAt")
         VALUES ('${harness.base.freshId("030d")}', '${appId}', 'T-BYPASS-2', 'suspended', '[]',
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      ),
    ).toBeNull();
  });

  test("a routing table of numbers satisfies the CHECK and is refused here", async () => {
    const refused = await write((transaction) =>
      harness.repository.saveConnection(connection({ agentRouting: [1, 2, 3] as never }), transaction),
    );
    expect(reasonOf(refused)).toContain("routing_rule_malformed");
    // `jsonb_typeof('[1,2,3]') = 'array'`, so the constraint behind this column
    // cannot tell a rule table from a list of numbers.
    expect(
      refusalFor(
        `INSERT INTO "ChannelConnection" ("id", "environmentId", "provider", "agentRouting",
                                         "createdAt", "updatedAt")
         VALUES ('${harness.base.freshId("030e")}', '${scope.environmentId}', 'slack', '[1,2,3]',
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      ),
    ).toBeNull();
  });

  test("a negative generation is taken by the INTEGER column", async () => {
    const refused = await write((transaction) =>
      harness.repository.saveInstallation(installation({ tokenGeneration: -1 }), transaction),
    );
    expect(reasonOf(refused)).toContain("generation_negative:tokenGeneration=-1");
    expect(
      refusalFor(
        `INSERT INTO "ChannelInstallation" ("id", "appId", "externalInstallationId", "status",
                                           "agentRouting", "tokenGeneration", "createdAt", "updatedAt")
         VALUES ('${harness.base.freshId("030f")}', '${appId}', 'T-BYPASS-3', 'active', '[]', -1,
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      ),
    ).toBeNull();
  });

  test("an incoherent refresh fence is taken by four independent nullable columns", async () => {
    const refused = await write((transaction) =>
      harness.repository.saveInstallation(
        installation({ refreshState: "REFRESHING", refreshClaimId: null, refreshStartedAt: null }),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain("REFRESHING without a claim");
    // A fence nobody holds and nobody can release. The CHECK constrains the
    // state COLUMN and says nothing about the three that give it meaning.
    expect(
      refusalFor(
        `INSERT INTO "ChannelInstallation" ("id", "appId", "externalInstallationId", "status",
                                           "agentRouting", "tokenRefreshState", "createdAt", "updatedAt")
         VALUES ('${harness.base.freshId("0310")}', '${appId}', 'T-BYPASS-4', 'active', '[]',
                 'REFRESHING', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      ),
    ).toBeNull();
  });
});

describe("the guards on the READ side, which no constraint can help with", () => {
  test("a read keyed on something that is not a uuid is refused before the cast", async () => {
    // The cast raises SQLSTATE 22P02 inside a RAW statement, whose refusal names
    // the driver rather than the parameter. The guard names the parameter.
    const connection = await harness.repository.findConnectionById(
      asIdentifier<ChannelConnectionId>("conn-1"),
    );
    expect(reasonOf(connection)).toContain("findConnectionById:identifier_not_uuid:connectionId");
    const application = await harness.repository.findApp(scope, asIdentifier<ChannelAppId>("app-1"));
    expect(reasonOf(application)).toContain("findApp:identifier_not_uuid:appId");
  });

  test("an empty string in a TEXT[] is refused before the column takes it", async () => {
    const refused = await write((transaction) =>
      harness.repository.saveApp(app({ scopes: ["chat:write", ""] }), transaction),
    );
    expect(reasonOf(refused)).toContain("text_list_invalid:scopes");
  });

  test("a sealed payload missing a version is refused before the INTEGER column takes it", async () => {
    const refused = await write((transaction) =>
      harness.repository.insertEvent(
        {
          inboxId: asIdentifier(harness.base.freshId("0312")),
          appId: asIdentifier(appId),
          eventId: asIdentifier("Ev-payload-shape"),
          payload: { formatVersion: 0, keyVersion: 1, ciphertext: "sealed" },
          status: "PENDING",
          retryCount: 0,
          availableAt: CONFORMANCE_AT,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseGeneration: 0,
          turnId: null,
          deliveryCompletedAt: null,
          lastErrorCode: null,
          completedAt: null,
          createdAt: CONFORMANCE_AT,
        },
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain("sealed_payload_invalid:payloadFormatVersion");
  });

  test("a terminal row that kept its lease is refused before it can look claimable", async () => {
    const refused = await write((transaction) =>
      harness.repository.insertEvent(
        {
          inboxId: asIdentifier(harness.base.freshId("0313")),
          appId: asIdentifier(appId),
          eventId: asIdentifier("Ev-lease-shape"),
          payload: { formatVersion: 1, keyVersion: 1, ciphertext: "sealed" },
          status: "COMPLETED",
          retryCount: 1,
          availableAt: CONFORMANCE_AT,
          leaseOwner: asIdentifier<LeaseOwner>("worker-zombie"),
          leaseExpiresAt: CONFORMANCE_AT,
          leaseGeneration: 1,
          turnId: null,
          deliveryCompletedAt: CONFORMANCE_AT,
          lastErrorCode: null,
          completedAt: CONFORMANCE_AT,
          createdAt: CONFORMANCE_AT,
        },
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain("COMPLETED holding a lease");
  });
});

describe("the guards whose only constraint is an index that would not name them", () => {
  test("an over-long thread key is refused before the btree sees it", async () => {
    const refused = await harness.repository.findThreadLink(
      { kind: "connection", connectionId: asIdentifier(harness.base.freshId("0311")) },
      asIdentifier("k".repeat(513)),
    );
    expect(reasonOf(refused)).toContain("thread_key_invalid:513 characters");
  });

  test("a claim page size that is not a positive count is refused before `take` sees it", async () => {
    const refused = await harness.repository.findClaimableEvents(
      asIdentifier(appId),
      CONFORMANCE_AT,
      -1,
    );
    // A NEGATIVE take REVERSES the page rather than emptying it, so an unchecked
    // limit hands a poller the newest rows and starves the oldest silently.
    expect(reasonOf(refused)).toContain("claim_limit_invalid:-1");
    const empty = await harness.repository.findClaimableEvents(asIdentifier(appId), CONFORMANCE_AT, 0);
    expect(reasonOf(empty)).toContain("claim_limit_invalid:0");
  });
});
