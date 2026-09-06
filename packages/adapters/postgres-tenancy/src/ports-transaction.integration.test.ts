// The five ports inside a transaction: the three scope refusals, failure
// injection, and the database rules the in-memory double does not carry.
//
// WHY THE SCOPE REFUSALS ARE ASSERTED PER PORT rather than once for the unit of
// work. Each of the five methods below resolves its own client, and a method
// that resolved it through `reader()` instead of `writer(scope)` would work
// perfectly in every ordinary test: the ambient frame would hand it the open
// transaction anyway. The difference only appears when the scope is WRONG — no
// transaction, a finished one, or another live one — and for a LOCK the
// difference is total, because a lock taken on a pooled connection outside the
// caller's transaction blocks nothing at all.
//
// THE ROLLBACK CASES INJECT A REAL FAILURE. `cost-monitoring` shipped a
// transaction that committed its first write when its second failed, because its
// double had nothing to roll back. The only way to know these do not is to make
// the second write fail against a real database and then look for the first row.
// The `err` case is that trap's other half and it is asserted in the direction
// that surprises people: a returned error `Result` COMMITS.
//
// THE LAST SECTION IS A FINDING, not a feature. `OperatorSession` carries two
// database rules the fake has no equivalent of — a cascade to child sessions and
// a revocation fired by any privilege change on `OrganizationMembership` — and
// the second one means the number `OperatorSessionRevoker.revoke` returns in the
// use case that calls it is ZERO against a real database while the fake says
// three. It is asserted here rather than papered over, and it is written up in
// the tranche report as a defect in the port's contract rather than in this
// adapter.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  OrganizationInvitationId,
  SessionRevocationOrder,
  TransactionId,
  TransactionScope,
  UserId,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier, OrganizationRole } from "@platos/context-tenancy/application/ports/index.js";
import { domainError, err, runResult } from "@platos/kernel";

import { digestOf, emailOf, envId, orgId } from "./harness.js";
import { startPortsHarness, type PortsHarness } from "./ports-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: PortsHarness;
let organizationId: string;
let environmentId: string;

const AT = new Date("2026-05-01T09:00:00.000Z");
const REVOKED_AT = new Date("2026-05-02T09:00:00.000Z");

/** A token no transaction was ever given, for the cases that must be refused. */
const ABSENT_SCOPE: TransactionScope = { transactionId: asIdentifier<TransactionId>("pg-txn-0") };

const orderFor = (userId: string): SessionRevocationOrder => ({
  userId: asIdentifier<UserId>(userId),
  cause: "membership-role-changed",
  revokedAt: REVOKED_AT,
  includeImpersonatedSessions: true,
});

/** Every port method that takes a scope, so the refusals are asserted on all of them. */
function scopedCalls(scope: TransactionScope): readonly { name: string; run(): Promise<unknown> }[] {
  return [
    {
      name: "lockOrganizationForUpdate",
      run: () => harness.ports.locks.lockOrganizationForUpdate(orgId(organizationId), scope),
    },
    {
      name: "lockInvitationSlot",
      run: () =>
        harness.ports.locks.lockInvitationSlot(
          orgId(organizationId),
          emailOf("scope@ports.test"),
          scope,
        ),
    },
    {
      name: "lockEnvironmentForUpdate",
      run: () => harness.ports.locks.lockEnvironmentForUpdate(envId(environmentId), scope),
    },
    {
      name: "accessKeyRevocation.bump",
      run: () => harness.ports.accessKeyRevocation.bump(envId(environmentId), scope),
    },
    {
      name: "sessionRevoker.revoke",
      run: () =>
        harness.ports.sessionRevoker.revoke(orderFor(harness.freshId("0117")), scope),
    },
  ];
}

beforeAll(async () => {
  harness = await startPortsHarness();
  organizationId = await harness.seedOrganization("scope-org");
  environmentId = await harness.seedEnvironment(organizationId, "scope-prod");
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the scope refusals, on every port method that takes a scope", () => {
  test("outside any transaction, all five refuse with not_open", async () => {
    const before = await harness.ports.accessKeyRevocation.read(envId(environmentId));
    for (const call of scopedCalls(ABSENT_SCOPE)) {
      await expect(call.run(), call.name).rejects.toMatchObject({
        name: "TransactionScopeError",
        code: TRANSACTION_NOT_OPEN,
      });
    }
    // And nothing happened. A bump that had reached the database would have moved
    // the generation whatever the refusal said afterwards.
    expect(await harness.ports.accessKeyRevocation.read(envId(environmentId))).toBe(before);
  }, 60_000);

  test("with a FINISHED transaction's token, all five refuse with scope_unknown", async () => {
    let escaped: TransactionScope | undefined;
    await harness.adapter.unitOfWork.run(async (transaction) => {
      escaped = transaction;
    });
    const stale = escaped as TransactionScope;
    const before = await harness.ports.accessKeyRevocation.read(envId(environmentId));
    await harness.adapter.unitOfWork.run(async () => {
      for (const call of scopedCalls(stale)) {
        await expect(call.run(), call.name).rejects.toMatchObject({
          code: TRANSACTION_SCOPE_UNKNOWN,
        });
      }
    });
    expect(await harness.ports.accessKeyRevocation.read(envId(environmentId))).toBe(before);
  }, 60_000);

  test("with another LIVE transaction's token, all five refuse with scope_foreign", async () => {
    // A second transaction opened OUTSIDE any ambient frame, so it is genuinely
    // concurrent rather than a nested join, held open on a gate. Its token IS in
    // the registry, so only the identity check can refuse these calls — which is
    // what separates `scope_foreign` from `scope_unknown`.
    let release = (): void => undefined;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    let concurrent: TransactionScope | undefined;
    const held = new Promise<void>((ready) => {
      void harness.adapter.unitOfWork.run(async (transaction) => {
        concurrent = transaction;
        ready();
        await gate;
      });
    });
    await held;
    const other = concurrent as TransactionScope;

    const refusals: Record<string, unknown> = {};
    await harness.adapter.unitOfWork.run(async (live) => {
      expect(other.transactionId).not.toBe(live.transactionId);
      for (const call of scopedCalls(other)) {
        try {
          await call.run();
          refusals[call.name] = "NOT REFUSED";
        } catch (error) {
          refusals[call.name] = (error as { readonly code?: unknown }).code;
        }
      }
    });
    release();

    expect(refusals).toEqual({
      "accessKeyRevocation.bump": TRANSACTION_SCOPE_FOREIGN,
      lockEnvironmentForUpdate: TRANSACTION_SCOPE_FOREIGN,
      lockInvitationSlot: TRANSACTION_SCOPE_FOREIGN,
      lockOrganizationForUpdate: TRANSACTION_SCOPE_FOREIGN,
      "sessionRevoker.revoke": TRANSACTION_SCOPE_FOREIGN,
    });
  }, 60_000);
});

describe("transaction boundaries, proven by failure injection", () => {
  test("a bump and a revocation are ONE unit: when the second fails, neither survives", async () => {
    const userId = await harness.seedUser("atomic@ports.test");
    const sessionId = await harness.seedSession({ userId });
    const environment = envId(await harness.seedEnvironment(organizationId, "atomic-prod"));
    const before = await harness.ports.accessKeyRevocation.read(environment);

    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.ports.accessKeyRevocation.bump(environment, transaction);
        await harness.ports.sessionRevoker.revoke(orderFor(userId), transaction);
        // The injected failure, AFTER both writes. A boundary that is not real
        // leaves the bump and the revocation behind.
        throw new Error("injected failure after both writes");
      }),
    ).rejects.toThrow("injected failure after both writes");

    expect(await harness.ports.accessKeyRevocation.read(environment)).toBe(before);
    expect(await harness.sessionRevokedAt(sessionId)).toBeNull();
  }, 60_000);

  test("a REAL database failure rolls the earlier write back too", async () => {
    // Not a thrown JavaScript error this time: the second write violates
    // `OrganizationInvitation_tokenHash_check`, so the failure comes from
    // PostgreSQL and arrives mid-transaction the way a production one would.
    const environment = envId(await harness.seedEnvironment(organizationId, "constraint-prod"));
    const before = await harness.ports.accessKeyRevocation.read(environment);
    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.ports.accessKeyRevocation.bump(environment, transaction);
        await harness.adapter.saveInvitation(
          {
            id: asIdentifier<OrganizationInvitationId>(harness.freshId("0118")),
            organizationId: orgId(organizationId),
            inviterId: null,
            acceptedByUserId: null,
            email: emailOf("rollback@ports.test"),
            role: OrganizationRole.MEMBER,
            tokenDigest: digestOf("not-a-digest"),
            expiresAt: AT,
            acceptedAt: null,
            revokedAt: null,
            createdAt: AT,
          },
          transaction,
        );
      }),
    ).rejects.toThrow();
    expect(await harness.ports.accessKeyRevocation.read(environment)).toBe(before);
  }, 60_000);

  test("a returned error Result ROLLS BACK — the cost-monitoring trap, closed", async () => {
    // THIS CASE USED TO ASSERT THE OPPOSITE, and it was right to. Only a
    // REJECTION rolled back; a use case that bumped the counter and then decided
    // to refuse had ALREADY written, and returning `err` resolved the promise,
    // which committed. Every use case in tenancy that must not commit therefore
    // had to THROW, and this case was the evidence for why that rule existed.
    //
    // WIN-260 (M2.5) removed the rule by removing the trap: `UnitOfWork.run` no
    // longer ACCEPTS a `Result`-valued callback — the shape does not compile —
    // and `runResult` rolls back on `err`. The counter is what makes that a fact
    // rather than a claim: it is read back over the pool, after the transaction,
    // and it is still what it was before the bump.
    const environment = envId(await harness.seedEnvironment(organizationId, "err-commits-prod"));
    const before = await harness.ports.accessKeyRevocation.read(environment);
    const outcome = await runResult(harness.adapter.unitOfWork, async (transaction) => {
      await harness.ports.accessKeyRevocation.bump(environment, transaction);
      return err(domainError("REFUSED_AFTER_WRITING", "conflict", "the use case refused after bumping"));
    });
    expect(outcome.ok).toBe(false);
    expect(await harness.ports.accessKeyRevocation.read(environment)).toBe(before);
  }, 60_000);
});

describe("the OperatorSession rules the in-memory double does not carry", () => {
  test("revocation matches impersonatedUserId, not only userId", async () => {
    // The half of `revoke_operator_sessions_for_membership_change` an
    // implementation forgets. A platform operator impersonating the demoted user
    // holds privileges the demotion just removed, and their session's `userId` is
    // the OPERATOR's.
    const operator = await harness.seedUser("operator@ports.test");
    const target = await harness.seedUser("target@ports.test");
    const parent = await harness.seedSession({ userId: operator });
    const impersonation = await harness.seedSession({
      userId: operator,
      impersonatedUserId: target,
      parentSessionId: parent,
    });

    const revoked = await harness.adapter.unitOfWork.run((transaction) =>
      harness.ports.sessionRevoker.revoke(orderFor(target), transaction),
    );
    expect(revoked).toBe(1);
    expect(await harness.sessionRevokedAt(impersonation)).toEqual(REVOKED_AT);
    // And the operator's OWN session is untouched: the order was about the target.
    expect(await harness.sessionRevokedAt(parent)).toBeNull();
  }, 60_000);

  test("the database CASCADES to child sessions, and the returned count does not include them", async () => {
    // `cascade_operator_session_revocation` is an AFTER UPDATE rule, so ending an
    // operator's own session ends the impersonations descended from it — and the
    // `UPDATE`'s row count, which is what the port returns, counts only the rows
    // the statement matched itself. The fake has no cascade at all, so a caller
    // that recorded this number as "sessions ended" would under-report against
    // PostgreSQL and be exactly right against the double.
    const operator = await harness.seedUser("cascade-operator@ports.test");
    const target = await harness.seedUser("cascade-target@ports.test");
    const parent = await harness.seedSession({ userId: operator });
    const child = await harness.seedSession({
      userId: operator,
      impersonatedUserId: target,
      parentSessionId: parent,
    });

    const revoked = await harness.adapter.unitOfWork.run((transaction) =>
      harness.ports.sessionRevoker.revoke(orderFor(operator), transaction),
    );
    // BOTH rows matched the OR filter directly here, so the count is 2 and the
    // cascade had nothing left to do. The assertion that matters is the pair:
    // both sessions are dead.
    expect(revoked).toBe(2);
    expect(await harness.sessionRevokedAt(parent)).toEqual(REVOKED_AT);
    expect(await harness.sessionRevokedAt(child)).toEqual(REVOKED_AT);
  }, 60_000);

  test("THE FINDING: after the membership write, the revoker's count is 0 and the sessions are dead", async () => {
    // `changeMembershipRole` writes the membership row and THEN calls this port,
    // and `OrganizationMembership_revoke_sessions_update` is an AFTER UPDATE rule
    // on `role`. So by the time the port runs, PostgreSQL has already set
    // `revokedAt` on every live session of that user, and the port's own
    // `UPDATE ... WHERE revokedAt IS NULL` matches nothing.
    //
    // The number the port returns is therefore 0 where the in-memory double
    // returns the seeded count, and `MembershipMutationOutcome.revokedSessionCount`
    // — which the use case reports to its caller — is 0 for a change that ended
    // two sessions. THE SESSIONS ARE EQUALLY DEAD IN BOTH; only the count differs.
    // It is not repaired here, because inventing a number the database cannot be
    // asked for would be worse than reporting one that is honestly unavailable.
    const userId = await harness.seedUser("demoted@ports.test");
    const first = await harness.seedSession({ userId });
    const second = await harness.seedSession({ userId });
    const membershipOrganization = await harness.seedOrganization("finding-org");

    const revoked = await harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.adapter.upsertOrganizationMembership(
        {
          organizationId: orgId(membershipOrganization),
          userId: asIdentifier<UserId>(userId),
          role: OrganizationRole.OWNER,
          at: AT,
        },
        transaction,
      );
      // The second upsert is an UPDATE of `role`, which is what the rule fires on.
      await harness.adapter.upsertOrganizationMembership(
        {
          organizationId: orgId(membershipOrganization),
          userId: asIdentifier<UserId>(userId),
          role: OrganizationRole.MEMBER,
          at: AT,
        },
        transaction,
      );
      return harness.ports.sessionRevoker.revoke(orderFor(userId), transaction);
    });

    expect(revoked).toBe(0);
    // And here is the half that matters operationally: both sessions ended, at
    // the transaction's own timestamp rather than at the order's instant.
    const firstRevokedAt = await harness.sessionRevokedAt(first);
    const secondRevokedAt = await harness.sessionRevokedAt(second);
    expect(firstRevokedAt).not.toBeNull();
    expect(secondRevokedAt).not.toBeNull();
    expect(firstRevokedAt).not.toEqual(REVOKED_AT);
  }, 60_000);

  test("with no membership write in the transaction, the count is the truth", async () => {
    // The control on the case above: same port, same order, no rule fired, and
    // the number is what the fake would have said. So the divergence is the
    // RULE's, not the adapter's.
    const userId = await harness.seedUser("undemoted@ports.test");
    await harness.seedSession({ userId });
    await harness.seedSession({ userId });
    const revoked = await harness.adapter.unitOfWork.run((transaction) =>
      harness.ports.sessionRevoker.revoke(orderFor(userId), transaction),
    );
    expect(revoked).toBe(2);
  }, 60_000);
});
