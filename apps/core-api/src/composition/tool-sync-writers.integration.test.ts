// THE TWO WRITERS WIN-269 PUBLISHED, AGAINST A REAL PostgreSQL, AND EVERY
// REFUSAL THEY OWE.
//
// `TenancyContract.recordEntityConnection` and `ToolsContract.recordToolHealth`
// are the published form of the two writes
// `apps/agent/src/tool-gateway/tool-sync-ws.service.ts` makes through Prisma
// directly — the `Entity.connectionStatus` pair and the `ToolHealth` upsert the
// heartbeat handler performs. `docs/audits/win-269-tool-lifecycle-reach.json`
// records all three sites, and this suite is what makes the methods more than a
// signature.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A SEPARATE FILE FROM THE RECONNECT PROOF
//
// That one is about a ROUTE over a legacy installation. This one is about the
// CONTRACT, called directly, so a refusal is attributable to the use case rather
// than to a transport that might have refused first. Both run over the same
// `startLegacyInstallation`, so neither invents a fixture.
//
// It also lives in `composition/` rather than in the adapter package, and C8 in
// `scripts/arch/composition-root.mjs` is the reason: a suite under `transports/`
// may not reach the adapters to seed, and a suite in
// `packages/adapters/postgres-tenancy` may not reach a context's use cases at
// all — `cross-context-contracts-only` (ADR M0.3 §5.1 rule (c)) stops it. This
// directory is where a composed context and a real store are both in scope.
//
// -----------------------------------------------------------------------------
// THE FORGED SCOPE, AND WHY IT IS THE CASE THAT MATTERS
//
// `EnvironmentOperatorAuthorization` is unforgeable in TWO ways and this suite
// exercises both, because they are different defects:
//
//   A VALUE THIS CONTEXT NEVER MINTED. `domain/authorization.ts` keeps a
//   module-private WeakSet of the values it issued, so a grant COPIED FIELD BY
//   FIELD out of a genuine one — which carries every property a shape check
//   would look at — is rejected on IDENTITY. The refusal is
//   `TENANCY_AUTHORIZATION_FORGED`.
//
//   A GENUINE GRANT, OFFERED FOR SOMETHING IT DOES NOT COVER. Nothing is forged;
//   the caller simply holds a real authorization for one environment and names
//   an entity under another project. That is a DIFFERENT fact and it gets a
//   DIFFERENT code — `TENANCY_ENTITY_NOT_IN_SCOPE` from tenancy's writer,
//   `TOOLS_ENTITY_NOT_IN_SCOPE` from the tools recorder — because an operator
//   told "forged" goes to look at their client and an operator told "not in
//   scope" goes to look at their environment.
//
// TWO GUARDS THAT ANSWERED ONE CODE WOULD BE ONE GUARD as far as any case could
// see, which is what `scripts/error-taxonomy.mjs` exists to refuse. Each is
// asserted by its own code below, and the second organization exists only so the
// second one can be reached at all.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asIdentifier, type EntityId, type EnvironmentId } from "@platos/kernel";
import type {
  EnvironmentOperatorAuthorization,
  TenancyContract,
  UserId,
} from "@platos/context-tenancy";
import type { ExternalEntityId, ToolsContract } from "@platos/context-tools";

import { OPERATOR, startLegacyInstallation, type LegacyInstallation } from "./tool-sync-legacy.js";

const AT = new Date("2026-05-01T09:00:00.000Z");

/** A SECOND tenant, so a GENUINE grant can be offered for the wrong place. */
const OTHER = Object.freeze({
  organizationId: "ffffffff-1001-4000-8000-000000000001",
  projectId: "ffffffff-1002-4000-8000-000000000002",
  environmentId: "ffffffff-1003-4000-8000-000000000003",
  membershipId: "ffffffff-1004-4000-8000-000000000004",
});

let installation: LegacyInstallation;
let tenancy: TenancyContract;
let tools: ToolsContract;
let grant: EnvironmentOperatorAuthorization;
/** A REAL grant for a REAL environment in a DIFFERENT project. Nothing forged. */
let elsewhere: EnvironmentOperatorAuthorization;
/** A REAL grant for the right environment at the WEAKER access level. */
let readOnly: EnvironmentOperatorAuthorization;
let entityId: EntityId;
let externalEntityId: ExternalEntityId;
let toolName: string;

async function authorize(
  environmentId: string,
  access: "metadata" | "secret:mutate",
): Promise<EnvironmentOperatorAuthorization> {
  const authorized = await tenancy.authorizeEnvironmentOperator({
    environmentId: asIdentifier<EnvironmentId>(environmentId),
    operator: {
      actorUserId: asIdentifier<UserId>(OPERATOR.userId),
      effectiveUserId: asIdentifier<UserId>(OPERATOR.userId),
    },
    access,
  });
  if (!authorized.ok) throw new Error(`could not authorize ${environmentId}: ${authorized.error.code}`);
  return authorized.value;
}

beforeAll(async () => {
  installation = await startLegacyInstallation();
  const contexts = installation.running.app.contexts;
  if (contexts.tenancy === undefined || contexts.tools === undefined) {
    throw new Error("tenancy and tools must both be composed for this suite to mean anything");
  }
  tenancy = contexts.tenancy;
  tools = contexts.tools;

  entityId = asIdentifier<EntityId>(installation.legacy.ids["entity"] as string);
  const [entityRow] = await installation.observe(
    `SELECT "externalId" FROM "Entity" WHERE id = '${String(entityId)}'`,
  );
  externalEntityId = asIdentifier<ExternalEntityId>(entityRow ?? "");
  const [named] = await installation.observe(`SELECT name FROM "Tool"`);
  toolName = named ?? "";

  const store = installation.construction.adapters["postgres-tenancy"];
  if (store === undefined) throw new Error("postgres-tenancy must be constructed");
  // THE SECOND TENANT IS SEEDED THROUGH THE ADAPTER'S OWN PORTS. It holds NO
  // entity: its whole purpose is to be a place a genuine grant points at and the
  // legacy entity does not live in.
  await store.unitOfWork.run(async (transaction) => {
    await store.saveOrganization(
      { id: asIdentifier(OTHER.organizationId), slug: asIdentifier("win269-elsewhere"), name: "Elsewhere", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveProject(
      { id: asIdentifier(OTHER.projectId), organizationId: asIdentifier(OTHER.organizationId), slug: asIdentifier("elsewhere"), name: "Elsewhere project", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveEnvironment(
      { id: asIdentifier(OTHER.environmentId), projectId: asIdentifier(OTHER.projectId), slug: asIdentifier("prod"), name: "Elsewhere production", archivedAt: null, accessKeyRevocationVersion: 0, memoryFeedbackBackfillCursor: null, memoryFeedbackBackfillCompletedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveOrganizationMembership(
      { id: asIdentifier(OTHER.membershipId), organizationId: asIdentifier(OTHER.organizationId), userId: asIdentifier(OPERATOR.userId), role: "OWNER", deactivatedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
  });

  grant = await authorize(installation.legacy.ids["environment"] as string, "secret:mutate");
  elsewhere = await authorize(OTHER.environmentId, "secret:mutate");
  readOnly = await authorize(installation.legacy.ids["environment"] as string, "metadata");
}, 600_000);

afterAll(async () => {
  await installation?.stop();
});

/**
 * A grant copied FIELD BY FIELD out of a genuine one.
 *
 * Every property a shape check could look at is present and correct, including
 * `principalType`, `tier`, `access` and the whole re-derived `scope`. The spread
 * also carries own enumerable SYMBOL keys, which is exactly why the mint
 * register is a WeakSet of identities rather than a symbol stamped on the value:
 * a stamp would survive this copy.
 */
function forged(from: EnvironmentOperatorAuthorization): unknown {
  return Object.freeze({ ...from });
}

describe("recordEntityConnection, against the real store", () => {
  it("writes the oracle's connect pair: connected AND a dated lastConnectedAt", async () => {
    const recorded = await tenancy.recordEntityConnection({
      authorization: grant,
      entityId,
      status: "connected",
    });
    expect(recorded.ok).toBe(true);
    // READ BACK FROM A `psql` PROCESS. Durability is somebody else seeing the
    // row, not the writer seeing its own.
    const [row] = await installation.observe(
      `SELECT "connectionStatus" || '|' || (case when "lastConnectedAt" is null then 'null' else 'dated' end) ` +
        `FROM "Entity" WHERE id = '${String(entityId)}'`,
    );
    expect(row).toBe("connected|dated");
  });

  it("writes the disconnect half WITHOUT advancing lastConnectedAt", async () => {
    const [was] = await installation.observe(
      `SELECT "lastConnectedAt"::text FROM "Entity" WHERE id = '${String(entityId)}'`,
    );
    const recorded = await tenancy.recordEntityConnection({
      authorization: grant,
      entityId,
      status: "disconnected",
    });
    expect(recorded.ok).toBe(true);
    const [row] = await installation.observe(
      `SELECT "connectionStatus" || '|' || "lastConnectedAt"::text FROM "Entity" WHERE id = '${String(entityId)}'`,
    );
    // THE ORACLE WRITES `{ connectionStatus: "disconnected" }` AND NOTHING ELSE.
    // Advancing the timestamp here would make every disconnect look like a
    // connection to any dashboard reading the column.
    expect(row).toBe(`disconnected|${was ?? ""}`);
    // Put it back, so the order of the cases below cannot depend on this one.
    await tenancy.recordEntityConnection({ authorization: grant, entityId, status: "connected" });
  });

  it("refuses a FORGED grant on identity, not on shape", async () => {
    const recorded = await tenancy.recordEntityConnection({
      authorization: forged(grant),
      entityId,
      status: "disconnected",
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.code).toBe("TENANCY_AUTHORIZATION_FORGED");
    // AND NOTHING WAS WRITTEN. A refusal that had already flipped the column
    // would be a refusal in name only.
    const [row] = await installation.observe(
      `SELECT "connectionStatus" FROM "Entity" WHERE id = '${String(entityId)}'`,
    );
    expect(row).toBe("connected");
  });

  it("refuses a GENUINE grant for another project under its OWN code", async () => {
    const recorded = await tenancy.recordEntityConnection({
      authorization: elsewhere,
      entityId,
      status: "disconnected",
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    // DISTINCT FROM `TENANCY_AUTHORIZATION_FORGED` — nothing here was forged —
    // and distinct from `TENANCY_NOT_FOUND`, because the entity exists.
    expect(recorded.error.code).toBe("TENANCY_ENTITY_NOT_IN_SCOPE");
    const [row] = await installation.observe(
      `SELECT "connectionStatus" FROM "Entity" WHERE id = '${String(entityId)}'`,
    );
    expect(row).toBe("connected");
  });

  it("refuses a genuine grant at the weaker access level", async () => {
    const recorded = await tenancy.recordEntityConnection({
      authorization: readOnly,
      entityId,
      status: "disconnected",
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.code).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect((recorded.error.details ?? {})["gate"]).toBe("secret-mutate-role");
  });

  it("refuses a status the running product never writes", async () => {
    const recorded = await tenancy.recordEntityConnection({
      authorization: grant,
      entityId,
      status: "CONNECTED",
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    // UPPER CASE IS NOT A SPELLING OF `connected`. The conformance fixtures in
    // `packages/adapters/postgres-tenancy` carry `"CONNECTED"` because a fixture
    // author typed it; the running product writes lower case, and a writer that
    // normalised would rewrite every live row on the first reconnect.
    expect(recorded.error.code).toBe("TENANCY_INVALID_CONNECTION_STATUS");
  });

  it("refuses an entity that does not exist, distinctly from one out of scope", async () => {
    const recorded = await tenancy.recordEntityConnection({
      authorization: grant,
      entityId: asIdentifier<EntityId>("ffffffff-9999-4000-8000-000000000099"),
      status: "connected",
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.code).toBe("TENANCY_NOT_FOUND");
  });
});

describe("recordToolHealth, against the real store", () => {
  it("folds a report onto the legacy row without touching its call counters", async () => {
    const recorded = await tools.recordToolHealth({
      authorization: grant,
      entityId,
      externalEntityId,
      reports: [{ toolName, status: "down", avgLatencyMs: 1234 }],
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.unknownToolNames).toEqual([]);
    const [row] = await installation.observe(
      `SELECT "lastStatus" || '|' || "avgLatencyMs"::text || '|' || "failCount"::text || '|' ` +
        `|| "totalCalls"::text || '|' || "totalFailures"::text || '|' ` +
        `|| coalesce("lastCalledAt"::text,'null') FROM "ToolHealth"`,
    );
    // `down` IS NOT `failed`. A heartbeat is the entity's opinion between calls;
    // the counters belong to `applyOutcome`, which only a dispatch reaches.
    expect(row).toBe("down|1234|0|0|0|null");
  });

  it("refuses a FORGED grant on identity", async () => {
    const recorded = await tools.recordToolHealth({
      authorization: forged(grant),
      entityId,
      externalEntityId,
      reports: [{ toolName, status: "healthy", avgLatencyMs: 1 }],
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    // TENANCY'S CODE, NOT ONE OF THIS CONTEXT'S. `tools` verifies a grant by
    // ASKING tenancy through `verifyAuthorization`, so the refusal is minted by
    // the context that holds the register — which is what makes it the same
    // answer wherever a forged grant is presented.
    expect(recorded.error.code).toBe("TENANCY_AUTHORIZATION_FORGED");
    const [row] = await installation.observe(`SELECT "lastStatus" FROM "ToolHealth"`);
    expect(row).toBe("down");
  });

  it("refuses a GENUINE grant for another project under the tools code", async () => {
    const recorded = await tools.recordToolHealth({
      authorization: elsewhere,
      entityId,
      externalEntityId,
      reports: [{ toolName, status: "healthy", avgLatencyMs: 1 }],
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    // `TOOLS_ENTITY_NOT_IN_SCOPE`, and the tenancy writer answered
    // `TENANCY_ENTITY_NOT_IN_SCOPE` for the same offence. TWO GUARDS, TWO CODES:
    // they live in different contexts and send an operator to different owners.
    expect(recorded.error.code).toBe("TOOLS_ENTITY_NOT_IN_SCOPE");
  });

  it("refuses a genuine grant at the weaker access level", async () => {
    const recorded = await tools.recordToolHealth({
      authorization: readOnly,
      entityId,
      externalEntityId,
      reports: [{ toolName, status: "healthy", avgLatencyMs: 1 }],
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.code).toBe("TOOLS_SCOPE_MISMATCH");
  });

  it("refuses an external id that is not this entity's, rather than filing under it", async () => {
    const recorded = await tools.recordToolHealth({
      authorization: grant,
      entityId,
      externalEntityId: asIdentifier<ExternalEntityId>(`${String(externalEntityId)}-other`),
      reports: [{ toolName, status: "healthy", avgLatencyMs: 1 }],
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.code).toBe("TOOLS_ENTITY_NOT_IN_SCOPE");
    // `ToolHealth.entityExternalId` IS WRITTEN FROM THIS FIELD, so admitting a
    // mismatch would file this entity's health under another name — and exactly
    // one row must still exist.
    const rows = await installation.observe(`SELECT count(*)::text FROM "ToolHealth"`);
    expect(rows).toEqual(["1"]);
  });

  it("refuses the whole frame when one entry's status is not a platools value", async () => {
    const recorded = await tools.recordToolHealth({
      authorization: grant,
      entityId,
      externalEntityId,
      reports: [
        { toolName, status: "healthy", avgLatencyMs: 5 },
        { toolName: "another", status: "mostly fine", avgLatencyMs: 5 },
      ],
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.code).toBe("TOOLS_HEALTH_REPORT_INVALID");
    // AND THE GOOD HALF DID NOT LAND. Every report is validated before any row is
    // read, so a frame carrying one bad status leaves nothing half-applied.
    const [row] = await installation.observe(`SELECT "lastStatus" FROM "ToolHealth"`);
    expect(row).toBe("down");
  });

  it("skips a name this environment does not expose and reports the skip", async () => {
    const recorded = await tools.recordToolHealth({
      authorization: grant,
      entityId,
      externalEntityId,
      reports: [{ toolName: "no_such_tool", status: "down", avgLatencyMs: 0 }],
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.recorded).toEqual([]);
    expect(recorded.value.unknownToolNames).toEqual(["no_such_tool"]);
    const rows = await installation.observe(`SELECT count(*)::text FROM "ToolHealth"`);
    expect(rows).toEqual(["1"]);
  });
});
