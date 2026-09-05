// The five ports, run against BOTH stores, compared verbatim.
//
// The comparison is the point. Two independently written suites would measure
// two things and agree by coincidence; `runTenancyPortsConformance` drives one
// sequence of calls and records what came back, and this file runs it twice.
//
// EVERY RUN GETS ITS OWN ROWS. The scenario BUMPS a counter and REVOKES
// sessions, so a second run over the first run's environment would start from
// generation 2 and find nothing left to revoke — and would then be compared
// against an in-memory store that is new every time. `seedScenario` is therefore
// called per run rather than once in `beforeAll`, which is also what lets the
// two cases below run in either order.
//
// AND THEN THE PART THE COMPARISON CANNOT REACH. A shared scenario proves the
// two stores answer the same questions the same way; it cannot prove the answers
// are ones PostgreSQL will accept, because the double never meets PostgreSQL.
// The second half of this file is those cases, and the first of them is a defect
// in the double: the invitation token issuer the context ships mints
// `digest:plt_inv_1`, and `OrganizationInvitation_tokenHash_check` refuses it.
// Every use-case suite in the tree passes with that digest.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createAccessKeyRevocationCounter,
  createInvitationTokenIssuer,
  createOperatorDirectory,
  createRecordingLocks,
  createRecordingSessionRevoker,
  createTenancyStore,
  createUnitOfWork,
} from "@platos/context-tenancy/application/index.js";
import type {
  EmailAddress,
  OrganizationInvitationId,
  TokenDigest,
  UserId,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier, OrganizationRole } from "@platos/context-tenancy/application/ports/index.js";

import { digestOf, emailOf, envId, inviteId, orgId, projId, slugOf } from "./harness.js";
import { invitationSlotKey } from "./locks.js";
import {
  PORTS_AT,
  SEEDED_LIVE_SESSIONS,
  runTenancyPortsConformance,
  type PortsConformanceIds,
  type PortsObservation,
} from "./ports-conformance.js";
import { startPortsHarness, type PortsHarness } from "./ports-harness.js";

let harness: PortsHarness;
let liveOrganizationId: string;
let run = 0;

const EXPIRES = new Date("2026-05-08T09:00:00.000Z");
const DIGEST = /^[0-9a-f]{64}$/u;

/** Fresh rows for one run of the scenario. See the header. */
async function seedScenario(): Promise<PortsConformanceIds> {
  run += 1;
  const label = `ports-${String(run)}`;
  const organizationId = await harness.seedOrganization(`${label}-live`);
  const archivedOrganizationId = await harness.seedOrganization(`${label}-archived`, true);
  const environmentId = await harness.seedEnvironment(organizationId, `${label}-prod`);
  const memberEmail = `member-${label}@ports.test`;
  const memberUserId = await harness.seedUser(memberEmail);
  await harness.seedSession({ userId: memberUserId });
  await harness.seedSession({ userId: memberUserId });
  return {
    organizationId,
    archivedOrganizationId,
    absentOrganizationId: harness.freshId("0107"),
    environmentId,
    absentEnvironmentId: harness.freshId("0108"),
    memberUserId,
    memberEmail,
    absentUserId: harness.freshId("0109"),
  };
}

/** The same scenario over the in-memory doubles, seeded to the same shape. */
async function observeInMemory(ids: PortsConformanceIds): Promise<PortsObservation> {
  const store = createTenancyStore();
  // Built literally rather than through the domain's record builders, because
  // the two stores have to be keyed by the SAME identifiers and the builders
  // derive theirs from a prefix. Every field is spelled out, so a record shape
  // that changes is a compile error here rather than a silent default.
  const projectId = projId(`${ids.organizationId}-project`);
  store.organizations.push(
    {
      id: orgId(ids.organizationId),
      slug: slugOf(ids.organizationId),
      name: ids.organizationId,
      archivedAt: null,
      createdAt: PORTS_AT,
      updatedAt: PORTS_AT,
    },
    {
      id: orgId(ids.archivedOrganizationId),
      slug: slugOf(ids.archivedOrganizationId),
      name: ids.archivedOrganizationId,
      archivedAt: PORTS_AT,
      createdAt: PORTS_AT,
      updatedAt: PORTS_AT,
    },
  );
  store.projects.push({
    id: projectId,
    organizationId: orgId(ids.organizationId),
    slug: slugOf(`${ids.organizationId}-project`),
    name: "project",
    archivedAt: null,
    createdAt: PORTS_AT,
    updatedAt: PORTS_AT,
  });
  store.environments.push({
    id: envId(ids.environmentId),
    projectId,
    slug: slugOf("prod"),
    name: "prod",
    archivedAt: null,
    accessKeyRevocationVersion: 0,
    memoryFeedbackBackfillCursor: null,
    memoryFeedbackBackfillCompletedAt: null,
    createdAt: PORTS_AT,
    updatedAt: PORTS_AT,
  });

  const sessionRevoker = createRecordingSessionRevoker();
  sessionRevoker.seed(asIdentifier<UserId>(ids.memberUserId), SEEDED_LIVE_SESSIONS);
  const operators = createOperatorDirectory();
  operators.add({
    userId: asIdentifier<UserId>(ids.memberUserId),
    email: asIdentifier<EmailAddress>(ids.memberEmail),
    disabledAt: null,
  });

  return runTenancyPortsConformance(
    {
      locks: createRecordingLocks(store),
      sessionRevoker,
      accessKeyRevocation: createAccessKeyRevocationCounter(store),
      invitationTokens: createInvitationTokenIssuer(),
      operators,
    },
    createUnitOfWork(store),
    ids,
  );
}

beforeAll(async () => {
  harness = await startPortsHarness();
  liveOrganizationId = await harness.seedOrganization("ports-invitations");
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the five tenancy ports against both stores", () => {
  test("answer the shared scenario identically", async () => {
    const ids = await seedScenario();
    const postgres = await runTenancyPortsConformance(
      harness.ports,
      harness.adapter.unitOfWork,
      ids,
    );
    expect(postgres).toEqual(await observeInMemory(ids));
  });

  test("and the scenario is not vacuous: every recorded step has a value", async () => {
    // Without this, a scenario that recorded nothing would compare equal to a
    // scenario that recorded nothing, and the case above would be green against
    // two stores that had never been called. The keys are pinned by NAME, so a
    // step deleted from the scenario is a red suite rather than a smaller
    // comparison that still passes.
    const ids = await seedScenario();
    const postgres = await runTenancyPortsConformance(
      harness.ports,
      harness.adapter.unitOfWork,
      ids,
    );
    expect(Object.keys(postgres).sort()).toEqual([
      "digestIsNotTheToken",
      "digestIsStable",
      "firstBump",
      "firstRevoke",
      "generationAfterCommit",
      "generationAfterFirstBump",
      "generationBefore",
      "generationForAbsentEnvironment",
      "invitationSlotReturned",
      "knownAccount",
      "lockAbsentEnvironment",
      "lockAbsentOrganization",
      "lockArchivedOrganization",
      "lockLiveEnvironment",
      "lockLiveOrganization",
      "mintRoundTrips",
      "mintsDiffer",
      "secondBump",
      "secondRevoke",
      "unknownAccount",
    ]);
    // Pinned by VALUE as well as by name, so a step that started answering
    // `undefined` would still be caught.
    expect(postgres.lockLiveOrganization).toBe(true);
    expect(postgres.lockArchivedOrganization).toBe(false);
    expect(postgres.lockAbsentOrganization).toBe(false);
    expect(postgres.lockLiveEnvironment).toBe(true);
    expect(postgres.lockAbsentEnvironment).toBe(false);
    expect(postgres.generationBefore).toBe(0);
    expect(postgres.firstBump).toBe(1);
    expect(postgres.generationAfterFirstBump).toBe(1);
    expect(postgres.secondBump).toBe(2);
    expect(postgres.generationAfterCommit).toBe(2);
    expect(postgres.generationForAbsentEnvironment).toBeNull();
    expect(postgres.firstRevoke).toBe(SEEDED_LIVE_SESSIONS);
    expect(postgres.secondRevoke).toBe(0);
    expect(postgres.unknownAccount).toBeNull();
  });
});

describe("what the shared scenario cannot reach", () => {
  test("the in-memory token issuer mints a digest PostgreSQL refuses", async () => {
    // THE FINDING, on both sides of one assertion. The double's digest is a
    // readable placeholder; the adapter's is 64 lowercase hex.
    const fake = createInvitationTokenIssuer().mint();
    expect(String(fake.digest)).not.toMatch(DIGEST);
    expect(String(harness.adapter.invitationTokens.mint().digest)).toMatch(DIGEST);

    // And PostgreSQL is the authority here, not the regular expression above.
    const write = (tokenDigest: TokenDigest): Promise<void> =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.adapter.saveInvitation(
          {
            id: asIdentifier<OrganizationInvitationId>(harness.freshId("0110")),
            organizationId: orgId(liveOrganizationId),
            inviterId: null,
            acceptedByUserId: null,
            email: emailOf(`invitee-${harness.freshId("0113")}@ports.test`),
            role: OrganizationRole.MEMBER,
            tokenDigest,
            expiresAt: EXPIRES,
            acceptedAt: null,
            revokedAt: null,
            createdAt: PORTS_AT,
          },
          transaction,
        ),
      );

    await expect(write(fake.digest)).rejects.toThrow(
      /OrganizationInvitation_tokenHash_check|check constraint/iu,
    );
    await expect(write(harness.adapter.invitationTokens.mint().digest)).resolves.toBeUndefined();
  });

  test("a token minted here is acceptable, and is found by its digest alone", async () => {
    // The round trip the port exists for: mint, store the digest, and later
    // resolve the row from a raw token a person pasted out of an email. If
    // `digest` were not the function `mint` used, this is the case that fails —
    // and it cannot be reached from the double at all, because the double's
    // digest never reaches a row.
    const minted = harness.adapter.invitationTokens.mint();
    const invitationId = inviteId(harness.freshId("0111"));
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.saveInvitation(
        {
          id: invitationId,
          organizationId: orgId(liveOrganizationId),
          inviterId: null,
          acceptedByUserId: null,
          email: emailOf(`round-trip-${harness.freshId("0114")}@ports.test`),
          role: OrganizationRole.MEMBER,
          tokenDigest: minted.digest,
          expiresAt: EXPIRES,
          acceptedAt: null,
          revokedAt: null,
          createdAt: PORTS_AT,
        },
        transaction,
      ),
    );
    const found = await harness.adapter.findInvitationByTokenDigest(
      harness.adapter.invitationTokens.digest(minted.token),
    );
    expect(found?.id).toBe(invitationId);
    // And a token nobody minted resolves to nothing rather than to the row above.
    expect(
      await harness.adapter.findInvitationByTokenDigest(
        harness.adapter.invitationTokens.digest("plt_inv_not-a-real-token"),
      ),
    ).toBeNull();
  });

  test("both stores lock the SAME invitation slot, spelled the same way", async () => {
    // TWO LOCKS ARE NOT ONE LOCK. The adapter hashes a string into the advisory
    // lock space and the in-memory double records that string, so if the two
    // spelled the key differently nothing would fail anywhere: the fake would
    // record its key, the adapter would take its own, and the shared scenario
    // above would still compare equal, because neither store returns the key.
    // This is the one case that compares them, and it is the reason
    // `invitationSlotKey` is a named pure function rather than a template
    // literal inline in the statement.
    const store = createTenancyStore();
    const organizationId = orgId(harness.freshId("0120"));
    store.organizations.push({
      id: organizationId,
      slug: slugOf("slot-key"),
      name: "slot-key",
      archivedAt: null,
      createdAt: PORTS_AT,
      updatedAt: PORTS_AT,
    });
    const recording = createRecordingLocks(store);
    await createUnitOfWork(store).run((transaction) =>
      recording.lockInvitationSlot(organizationId, emailOf("slot@ports.test"), transaction),
    );
    expect([...recording.invitationSlots]).toEqual([
      invitationSlotKey(organizationId, "slot@ports.test"),
    ]);
  });

  test("the operator directory does not carry identity-access's impersonation flag", async () => {
    // `UserStore.findById` returns `platformOperator`; `OperatorAccount` has no
    // such field, and an adapter that spread the record would have published
    // identity-access's impersonation rule into tenancy with nothing failing.
    const userId = await harness.seedUser("shape@ports.test");
    const account = await harness.adapter.operators.findAccount(asIdentifier<UserId>(userId));
    expect(account).not.toBeNull();
    expect(Object.keys(account ?? {}).sort()).toEqual(["disabledAt", "email", "userId"]);
  });

  test("the operator directory reads a disabled account rather than hiding it", async () => {
    // `disabledAt` is on the port because the DECISION is tenancy's — a disabled
    // account accepts nothing — and a directory that filtered disabled users out
    // would turn "this account may not accept" into "no such account", which is
    // a different refusal with a different fix.
    const disabledUserId = await harness.seedUser("disabled@ports.test");
    await harness.client.$executeRawUnsafe(
      `UPDATE "User" SET "disabledAt" = $2::timestamp, "updatedAt" = $2::timestamp WHERE id = $1::uuid`,
      disabledUserId,
      PORTS_AT,
    );
    const account = await harness.adapter.operators.findAccount(
      asIdentifier<UserId>(disabledUserId),
    );
    expect(account?.disabledAt).toEqual(PORTS_AT);
    expect(String(account?.email)).toBe("disabled@ports.test");
  });

  test("an invitation digest the port did not mint still has to be lowercase hex", async () => {
    // Belt and braces on the CONSTRAINT, not on the port: `saveInvitation`
    // writes the digest it is handed, and this is the case that proves
    // PostgreSQL is doing the refusing rather than a TypeScript brand anybody
    // can cast past.
    await expect(
      harness.adapter.unitOfWork.run((transaction) =>
        harness.adapter.saveInvitation(
          {
            id: asIdentifier<OrganizationInvitationId>(harness.freshId("0112")),
            organizationId: orgId(liveOrganizationId),
            inviterId: null,
            acceptedByUserId: null,
            email: emailOf("uppercase@ports.test"),
            role: OrganizationRole.MEMBER,
            // Uppercase hex, right length. The migration's expression is
            // `[0-9a-f]`, not `[0-9a-fA-F]`.
            tokenDigest: digestOf("A1".repeat(32)),
            expiresAt: EXPIRES,
            acceptedAt: null,
            revokedAt: null,
            createdAt: PORTS_AT,
          },
          transaction,
        ),
      ),
    ).rejects.toThrow(/OrganizationInvitation_tokenHash_check|check constraint/iu);
  });
});
