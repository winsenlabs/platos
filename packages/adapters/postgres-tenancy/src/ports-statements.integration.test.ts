// Statement counts for the five ports, MEASURED — the N+1 control.
//
// Every pin below is a number this suite observed rather than a number somebody
// expected, and every one is taken TWICE: once over a small set and once over a
// set an order of magnitude larger. What matters is not the figure but that the
// figure does not move with the number of rows. An N+1 does not announce itself
// in a suite — every value is correct and every test passes — it announces
// itself as a demotion that took four seconds because the user had forty
// sessions.
//
// THE PORTS THAT COST ZERO ARE PINNED TOO. `InvitationTokenIssuer` must send no
// statement at all: a mint that reached the database would put the raw token on
// a connection, and the whole design of this port is that the secret never
// leaves the process except in the returned value.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  SessionRevocationOrder,
  UserId,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import { emailOf, envId, orgId } from "./harness.js";
import { startPortsHarness, type PortsHarness } from "./ports-harness.js";

let harness: PortsHarness;
let organizationId: string;
let environmentId: string;
/** One live session. */
let lightUserId: string;
/** Twenty live sessions, so a per-row cost would show. */
let heavyUserId: string;

const REVOKED_AT = new Date("2026-05-02T09:00:00.000Z");
const HEAVY_SESSIONS = 20;

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of; counting them would make every pin depend on
 * whether the call happened to be inside a transaction.
 *
 * THE HEALTH CHECK IS MATCHED WHOLE, and the sibling suites' pattern is
 * deliberately not copied. They drop anything BEGINNING `SELECT 1`, which is the
 * driver's connection probe — and also, as this suite found, the shape a lock
 * statement naturally takes. `lockInvitationSlot` projected a constant `1` in its
 * first draft and was measured at ZERO statements: a lock that looked free
 * because a filter written for something else had eaten it. The statement now
 * projects `true` AND this filter anchors, so neither half can hide the other.
 */
function queries(): readonly string[] {
  return harness
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/iu.test(statement) &&
        !/^\s*SELECT 1\s*$/iu.test(statement),
    );
}

async function measure(work: () => Promise<unknown>): Promise<number> {
  harness.resetStatements();
  await work();
  return queries().length;
}

const orderFor = (userId: string): SessionRevocationOrder => ({
  userId: asIdentifier<UserId>(userId),
  cause: "membership-role-changed",
  revokedAt: REVOKED_AT,
  includeImpersonatedSessions: true,
});

beforeAll(async () => {
  harness = await startPortsHarness();
  organizationId = await harness.seedOrganization("statements-org");
  environmentId = await harness.seedEnvironment(organizationId, "statements-prod");
  lightUserId = await harness.seedUser("light@ports.test");
  await harness.seedSession({ userId: lightUserId });
  heavyUserId = await harness.seedUser("heavy@ports.test");
  for (let index = 0; index < HEAVY_SESSIONS; index += 1) {
    await harness.seedSession({ userId: heavyUserId });
  }
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("statement counts", () => {
  test("each lock costs exactly one statement", async () => {
    const organization = await measure(() =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.ports.locks.lockOrganizationForUpdate(orgId(organizationId), transaction),
      ),
    );
    const slot = await measure(() =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.ports.locks.lockInvitationSlot(
          orgId(organizationId),
          emailOf("statements@ports.test"),
          transaction,
        ),
      ),
    );
    const environment = await measure(() =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.ports.locks.lockEnvironmentForUpdate(envId(environmentId), transaction),
      ),
    );
    expect({ organization, slot, environment }).toEqual({
      organization: 1,
      slot: 1,
      environment: 1,
    });
  }, 60_000);

  test("read and bump cost one statement each, and the bump does not read first", async () => {
    const read = await measure(() =>
      harness.ports.accessKeyRevocation.read(envId(environmentId)),
    );
    const bump = await measure(() =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.ports.accessKeyRevocation.bump(envId(environmentId), transaction),
      ),
    );
    // TWO would mean a read-modify-write, which is the lost update the port's
    // "monotonic and unconditional" contract forbids. The count is the only thing
    // that can tell the two implementations apart; both return the right number.
    expect({ read, bump }).toEqual({ read: 1, bump: 1 });
  }, 60_000);

  test("revoking sessions costs ONE statement whether the user has 1 or 20", async () => {
    const light = await measure(() =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.ports.sessionRevoker.revoke(orderFor(lightUserId), transaction),
      ),
    );
    const heavy = await measure(() =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.ports.sessionRevoker.revoke(orderFor(heavyUserId), transaction),
      ),
    );
    expect(light).toBe(1);
    expect(heavy).toBe(light);
  }, 60_000);

  test("and the twenty were really there, so the pin above is not measuring nothing", async () => {
    // The non-vacuity control on the case above. A revoker that matched no rows
    // would also cost one statement, and the pin would be green over an empty
    // set. `revoke` has already run for both users, so this reads the rows back.
    const revokedHeavy = await harness.adapter.unitOfWork.run((transaction) =>
      harness.ports.sessionRevoker.revoke(orderFor(heavyUserId), transaction),
    );
    expect(revokedHeavy).toBe(0);
    const rows = await harness.client.$queryRawUnsafe<readonly { count: bigint }[]>(
      `SELECT count(*) AS count FROM "OperatorSession" WHERE "userId" = $1::uuid AND "revokedAt" IS NOT NULL`,
      heavyUserId,
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(HEAVY_SESSIONS);
  }, 60_000);

  test("the operator directory costs one statement", async () => {
    const known = await measure(() =>
      harness.adapter.operators.findAccount(asIdentifier<UserId>(lightUserId)),
    );
    const unknown = await measure(() =>
      harness.adapter.operators.findAccount(asIdentifier<UserId>(harness.freshId("0119"))),
    );
    // The same cost for a miss as for a hit: a directory that fell back to a
    // second lookup on a miss would be a per-request cost paid exactly when a
    // caller is probing for accounts that do not exist.
    expect({ known, unknown }).toEqual({ known: 1, unknown: 1 });
  }, 60_000);

  test("minting and digesting an invitation token send nothing at all", async () => {
    const minted = await measure(async () => harness.adapter.invitationTokens.mint());
    const digested = await measure(async () =>
      harness.adapter.invitationTokens.digest("plt_inv_whatever"),
    );
    expect({ minted, digested }).toEqual({ minted: 0, digested: 0 });
  }, 60_000);
});
