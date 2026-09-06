// The mapping and the guards, PURE — the only `channels` suite in this package
// that needs no database, and therefore the only one `pnpm test:v1-packages`
// runs.
//
// WHAT IT IS FOR. Every refusal below is reachable from the integration suites
// too, but reaching it there costs a container and hides the decision inside a
// round trip. These cases pin the DECISION: which field was refused, under which
// code, and what a stored row becomes when it is read back. A guard whose only
// witness is an integration run is a guard nobody can see fail.
//
// THE READ SIDE IS ASYMMETRIC WITH THE WRITE SIDE, ON PURPOSE, and these cases
// are where that is legible. `readConnectionRow` carries a provider the write
// guard would have refused, because the value is what a live connection was
// created with and refusing the READ would take a working connection offline to
// punish a naming mistake. It refuses an unreadable `status` on an installation,
// because there is no safe substitute for a lifecycle state. Both are choices,
// and both are here as cases rather than as prose.

import { describe, expect, test } from "vitest";

import type {
  ChannelConnectionId,
  ChannelThreadKey,
} from "@platos/context-channels/application/ports/index.js";
import { asIdentifier } from "@platos/context-channels/application/ports/index.js";

import {
  firstRefusal,
  requireAppProvider,
  requireConnectionProvider,
  requireDistribution,
  requireEventStatus,
  requireGeneration,
  requireInstallationStatus,
  requireLeaseCoherence,
  requireOptionalUuid,
  requireRefreshCoherence,
  requireRefreshState,
  requireRoutingTable,
  requireSealedPayload,
  requireTextList,
  requireThreadKey,
  requireUuid,
} from "./channels-guards.js";
import type { AppRow, ConnectionRow, EventRow, InstallationRow, LinkRow } from "./channels-rows.js";
import {
  readAppRow,
  readConnectionRow,
  readEventRow,
  readInstallationRow,
  readLinkRow,
} from "./channels-rows.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const AT = new Date("2026-05-01T09:00:00.000Z");

/** The refusal's reason string, or null when the check passed. */
function reasonOf(check: unknown): string | null {
  if (check === null) return null;
  const result = check as { readonly ok: boolean; readonly error: { readonly details?: unknown } };
  if (result.ok) return null;
  const details = result.error.details as { readonly reason?: string } | undefined;
  return details?.reason ?? "";
}

function connectionRow(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: UUID_A,
    environmentId: UUID_B,
    projectId: UUID_C,
    organizationId: UUID_A,
    entityId: null,
    provider: "slack",
    displayName: "Acme",
    defaultAgentId: null,
    agentRouting: [],
    enabled: true,
    credentialId: null,
    createdAt: AT,
    ...overrides,
  };
}

function appRow(overrides: Partial<AppRow> = {}): AppRow {
  return {
    id: UUID_A,
    environmentId: UUID_B,
    projectId: UUID_C,
    organizationId: UUID_A,
    provider: "slack",
    displayName: null,
    clientId: "client-1",
    credentialId: null,
    scopes: ["chat:write"],
    distribution: "private",
    defaultAgentId: null,
    agentRouting: [],
    createdAt: AT,
    ...overrides,
  };
}

function installationRow(overrides: Partial<InstallationRow> = {}): InstallationRow {
  return {
    id: UUID_A,
    appId: UUID_B,
    externalInstallationId: "T0ACME",
    displayName: null,
    credentialId: null,
    grantedScopes: ["chat:write"],
    defaultAgentId: null,
    agentRouting: [],
    status: "active",
    revokedAt: null,
    lastEventAt: null,
    tokenRefreshState: "IDLE",
    tokenRefreshClaimId: null,
    tokenRefreshStartedAt: null,
    tokenRefreshRepairCode: null,
    tokenGeneration: 1,
    createdAt: AT,
    ...overrides,
  };
}

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: UUID_A,
    appId: UUID_B,
    eventId: "Ev1",
    payloadFormatVersion: 1,
    payloadKeyVersion: 2,
    encryptedPayload: "sealed",
    status: "PENDING",
    retryCount: 0,
    availableAt: AT,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseGeneration: 0,
    turnId: null,
    deliveryCompletedAt: null,
    lastErrorCode: null,
    completedAt: null,
    createdAt: AT,
    ...overrides,
  };
}

describe("identifiers are checked against the shape the UUID columns round-trip", () => {
  test("a canonical uuid passes and every other spelling is refused by field name", () => {
    expect(requireUuid("op", "connectionId", UUID_A)).toBeNull();
    // Braced, unhyphenated and upper-case forms are all ACCEPTED by PostgreSQL
    // and normalised on the way in, so a row written with one of them does not
    // equal the string the caller holds and the next read finds nothing.
    expect(reasonOf(requireUuid("op", "connectionId", `{${UUID_A}}`))).toContain(
      "identifier_not_uuid:connectionId",
    );
    // Upper case is a DIFFERENT string that PostgreSQL folds to the same row,
    // so the id read back would not equal the id written. The literal below
    // carries hex letters on purpose: UUID_A is all digits and folds to itself.
    expect(reasonOf(requireUuid("op", "connectionId", "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"))).toContain(
      "identifier_not_uuid",
    );
    expect(reasonOf(requireUuid("op", "connectionId", "conn-1"))).toContain("identifier_not_uuid");
  });

  test("the nullable form treats a null as a null and not as a malformed id", () => {
    expect(requireOptionalUuid("op", "entityId", null)).toBeNull();
    expect(reasonOf(requireOptionalUuid("op", "entityId", "entity-1"))).toContain(
      "identifier_not_uuid:entityId",
    );
  });

  test("the context's own builders mint ids this guard refuses", () => {
    // THE FINDING, as a case. `application/testing/builders.ts` mints `conn-1`,
    // `app-1`, `cred-1`, `agent-1` and `thread-1`, and every use-case suite in
    // that package is green with them. All five are refused here, and would have
    // been refused by the column with SQLSTATE 22P02.
    const minted = ["conn-1", "app-1", "cred-1", "agent-1", "thread-1"];
    expect(minted.map((value) => reasonOf(requireUuid("op", "id", value)) !== null)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("the vocabularies no CHECK constraint stands behind", () => {
  test("a connection admits four providers and an app admits one", () => {
    expect(requireConnectionProvider("op", "telegram")).toBeNull();
    expect(requireAppProvider("op", "slack")).toBeNull();
    // The narrowness IS the rule: telegram has no installation model, so an app
    // for it would fail much later, at OAuth time.
    expect(reasonOf(requireAppProvider("op", "telegram"))).toContain("provider_unknown");
    expect(reasonOf(requireConnectionProvider("op", "Slack"))).toContain("provider_unknown");
  });

  test("distribution and installation status are compared exactly", () => {
    expect(requireDistribution("op", "public")).toBeNull();
    expect(requireInstallationStatus("op", "revoked")).toBeNull();
    expect(reasonOf(requireDistribution("op", "PUBLIC"))).toContain("distribution_unknown");
    expect(reasonOf(requireInstallationStatus("op", "deleted"))).toContain(
      "installation_status_unknown",
    );
  });
});

describe("the vocabularies a migration-only CHECK does stand behind", () => {
  test("the refresh state is one of the three the CHECK admits", () => {
    expect(requireRefreshState("op", "REPAIR_REQUIRED")).toBeNull();
    expect(reasonOf(requireRefreshState("op", "REFRESHING_SOON"))).toContain(
      "refresh_state_unknown",
    );
  });

  test("the inbox status is one of the five the CHECK admits", () => {
    expect(requireEventStatus("op", "DISCARDED")).toBeNull();
    expect(reasonOf(requireEventStatus("op", "RETRYING"))).toContain("event_status_unknown");
  });
});

describe("the routing table is checked as strictly as it is written", () => {
  test("a well-formed table of both rule kinds passes", () => {
    expect(
      requireRoutingTable("op", [
        { match: { type: "channel", id: "C1" }, agentId: UUID_A },
        { match: { type: "prefix", value: "ada" }, agentId: UUID_B },
      ]),
    ).toBeNull();
    expect(requireRoutingTable("op", [])).toBeNull();
  });

  test("a table the CHECK would accept but the resolver cannot read is refused", () => {
    // `jsonb_typeof(...) = 'array'` is satisfied by `[1, 2, 3]`, so the CHECK
    // behind this column cannot tell a rule table from a list of numbers.
    expect(reasonOf(requireRoutingTable("op", [1, 2, 3]))).toContain("routing_rule_malformed");
    expect(reasonOf(requireRoutingTable("op", [{ agentId: UUID_A }]))).toContain(
      "rule[0].match",
    );
    expect(
      reasonOf(requireRoutingTable("op", [{ match: { type: "channel" }, agentId: UUID_A }])),
    ).toContain("rule[0].match.id");
    expect(
      reasonOf(requireRoutingTable("op", [{ match: { type: "regex", value: "x" }, agentId: UUID_A }])),
    ).toContain("rule[0].match.type");
  });

  test("the rule cap is enforced here because the column has none", () => {
    const many = Array.from({ length: 33 }, () => ({
      match: { type: "prefix", value: "ada" },
      agentId: UUID_A,
    }));
    expect(reasonOf(requireRoutingTable("op", many))).toContain("routing_too_many_rules:33");
  });
});

describe("the two coherence rules the schema cannot express", () => {
  test("REFRESHING needs a claim and every other state must hold none", () => {
    expect(requireRefreshCoherence("op", "REFRESHING", UUID_A, AT, null)).toBeNull();
    expect(requireRefreshCoherence("op", "IDLE", null, null, null)).toBeNull();
    expect(requireRefreshCoherence("op", "REPAIR_REQUIRED", null, null, "grant-consumed")).toBeNull();
    expect(reasonOf(requireRefreshCoherence("op", "REFRESHING", null, AT, null))).toContain(
      "REFRESHING without a claim",
    );
    expect(reasonOf(requireRefreshCoherence("op", "IDLE", UUID_A, AT, null))).toContain(
      "IDLE holding a claim",
    );
    expect(reasonOf(requireRefreshCoherence("op", "REPAIR_REQUIRED", null, null, null))).toContain(
      "REPAIR_REQUIRED without a repair code",
    );
  });

  test("a terminal inbox row may not keep a lease that would look claimable", () => {
    expect(requireLeaseCoherence("op", "PROCESSING", "worker-a", AT)).toBeNull();
    expect(requireLeaseCoherence("op", "COMPLETED", null, null)).toBeNull();
    expect(reasonOf(requireLeaseCoherence("op", "PROCESSING", "worker-a", null))).toContain(
      "PROCESSING without a held lease",
    );
    expect(reasonOf(requireLeaseCoherence("op", "COMPLETED", "worker-a", AT))).toContain(
      "COMPLETED holding a lease",
    );
  });
});

describe("the remaining column-shaped guards", () => {
  test("a sealed payload carries both versions and a ciphertext", () => {
    expect(requireSealedPayload("op", 1, 1, "sealed")).toBeNull();
    expect(reasonOf(requireSealedPayload("op", 0, 1, "sealed"))).toContain("payloadFormatVersion");
    expect(reasonOf(requireSealedPayload("op", 1, 1.5, "sealed"))).toContain("payloadKeyVersion");
    expect(reasonOf(requireSealedPayload("op", 1, 1, ""))).toContain("encryptedPayload");
  });

  test("a TEXT[] column takes non-empty strings and a counter may not go negative", () => {
    expect(requireTextList("op", "scopes", ["chat:write"])).toBeNull();
    expect(reasonOf(requireTextList("op", "scopes", [""]))).toContain("text_list_invalid:scopes");
    expect(requireGeneration("op", "leaseGeneration", 0)).toBeNull();
    expect(reasonOf(requireGeneration("op", "tokenGeneration", -1))).toContain(
      "generation_negative:tokenGeneration=-1",
    );
  });

  test("a thread key is bounded here because the column is not", () => {
    expect(requireThreadKey("op", "channel:C1:1.0")).toBeNull();
    expect(reasonOf(requireThreadKey("op", "   "))).toContain("thread_key_invalid:empty");
    expect(reasonOf(requireThreadKey("op", "k".repeat(513)))).toContain("513 characters");
  });

  test("the first refusal wins and a clean list yields the value", () => {
    const passed = firstRefusal("value", [null, null]);
    expect(passed.ok && passed.value).toBe("value");
    const refused = firstRefusal("value", [
      null,
      requireUuid<string>("op", "second", "nope"),
      requireUuid<string>("op", "third", "also-nope"),
    ]);
    expect(reasonOf(refused)).toContain("second");
  });
});

describe("reading a stored row back", () => {
  test("a connection becomes an aggregate whose scope came from the tree", () => {
    const read = readConnectionRow(
      connectionRow({ entityId: UUID_C, defaultAgentId: UUID_B, credentialId: UUID_A }),
    );
    expect(read.ok && read.value.scope).toEqual({
      level: "environment",
      organizationId: UUID_A,
      projectId: UUID_C,
      environmentId: UUID_B,
    });
    expect(read.ok && read.value.entityId).toBe(UUID_C);
  });

  test("a row whose environment did not join up is refused rather than given a scope", () => {
    const read = readConnectionRow(connectionRow({ projectId: null }));
    expect(reasonOf(read)).toContain("unresolved_scope_ancestry");
  });

  test("a connection carries a provider the write guard would have refused", () => {
    // ASYMMETRIC ON PURPOSE. See the header: refusing the read would take a
    // working connection offline to punish a naming mistake.
    const read = readConnectionRow(connectionRow({ provider: "matrix" }));
    expect(read.ok && read.value.provider).toBe("matrix");
  });

  test("a routing column that is not an array is refused on the way out", () => {
    expect(reasonOf(readConnectionRow(connectionRow({ agentRouting: { rules: [] } })))).toContain(
      "unreadable_routing",
    );
    expect(reasonOf(readAppRow(appRow({ agentRouting: null })))).toContain("unreadable_routing");
  });

  test("a NULL text array reads as an empty list because the column allows one", () => {
    // The migration declares `scopes TEXT[] DEFAULT ARRAY[]::TEXT[]` with NO
    // `NOT NULL`, which `schema.prisma` does not say. A row written by anything
    // other than this client can hold SQL NULL there.
    const read = readAppRow(appRow({ scopes: null }));
    expect(read.ok && read.value.scopes).toEqual([]);
    const installation = readInstallationRow(installationRow({ grantedScopes: null }), 0);
    expect(installation.ok && installation.value.grantedScopes).toEqual([]);
  });

  test("an installation projects the revision it is handed and names its fence", () => {
    const read = readInstallationRow(
      installationRow({
        credentialId: UUID_C,
        tokenRefreshState: "REFRESHING",
        tokenRefreshClaimId: UUID_B,
        tokenRefreshStartedAt: AT,
      }),
      7,
    );
    expect(read.ok && read.value.credentialRevision).toBe(7);
    expect(read.ok && read.value.refreshState).toBe("REFRESHING");
    expect(read.ok && read.value.refreshClaimId).toBe(UUID_B);
  });

  test("an installation whose lifecycle words are unknown is refused, not guessed", () => {
    expect(reasonOf(readInstallationRow(installationRow({ status: "suspended" }), 0))).toContain(
      "unreadable_installation_status",
    );
    expect(
      reasonOf(readInstallationRow(installationRow({ tokenRefreshState: "PAUSED" }), 0)),
    ).toContain("unreadable_refresh_state");
  });

  test("an inbox row becomes an event with its sealed payload reassembled", () => {
    const read = readEventRow(eventRow({ turnId: UUID_C, leaseOwner: null }));
    expect(read.ok && read.value.payload).toEqual({
      formatVersion: 1,
      keyVersion: 2,
      ciphertext: "sealed",
    });
    expect(read.ok && read.value.turnId).toBe(UUID_C);
    expect(reasonOf(readEventRow(eventRow({ status: "RETRYING" })))).toContain(
      "unreadable_event_status",
    );
  });

  test("a link's owner kind comes from the table it was read out of", () => {
    const row: LinkRow = {
      id: UUID_A,
      ownerId: UUID_B,
      threadId: UUID_C,
      channelThreadKey: "channel:C1:1.0",
      createdAt: AT,
    };
    const direct = readLinkRow(row, "connection");
    const hosted = readLinkRow(row, "installation");
    expect(direct.owner).toEqual({ kind: "connection", connectionId: UUID_B });
    expect(hosted.owner).toEqual({ kind: "installation", installationId: UUID_B });
    expect(direct.channelThreadKey).toBe(
      asIdentifier<ChannelThreadKey>("channel:C1:1.0"),
    );
    expect(direct.linkId).toBe(asIdentifier<ChannelConnectionId>(UUID_A));
  });
});
