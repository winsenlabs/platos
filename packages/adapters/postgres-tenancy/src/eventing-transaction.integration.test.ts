// The transaction boundary, proved by FAILURE INJECTION against a real database,
// and the three scope refusals.
//
// WHY INJECTION AND NOT A ROLLBACK COUNT. A store that counted rollbacks would
// pass a suite that asserted rollbacks. Every case below forces the SECOND write
// of a multi-statement unit of work to fail and then LOOKS FOR THE FIRST ROW —
// over a SECOND client, on a connection this adapter's pool never touched,
// because durability is not "the row is there when the writer looks again" but
// "the row is there when somebody else looks".
//
// *** THE `Result` HALF IS MEASURED, AND IT IS THE `cost-monitoring` TRAP. ***
// `eventing-refusal.ts` turns a driver error into an error `Result`, and an error
// `Result` RESOLVES — so the callback returns normally and the unit of work
// issues COMMIT. Whether that COMMIT is a commit or a rollback is a fact about
// PostgreSQL rather than about this package, and the only honest way to know is
// to look for the row from outside.
//
// *** AND IT FOUND SOMETHING WORTH NAMING. *** A caught name clash leaves the
// transaction ABORTED (25P02), so a unit of work that inserted a good rule and
// THEN hit the unique index loses BOTH — including the one whose `Result` said
// `ok`. That is inherent to PostgreSQL without savepoints, which Prisma's
// interactive transaction API does not expose, and it is pinned here as a case
// rather than left as a comment: a caller composing `insertRule` with anything
// else must treat `EVENTING_RULE_NAME_TAKEN` as terminal for the whole unit of
// work. `registerNotificationRule` already does — its unit of work holds that
// one statement and nothing else.
//
// THE GUARDS ARE THE OTHER HALF OF THE SAME MEASUREMENT. A refusal caught in
// TypeScript sends no statement, so the transaction is untouched and the NEXT
// write commits. Both cases are here, side by side, because the difference
// between them is the entire argument for `eventing-guards.ts`.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  NotificationRule,
  NotificationRuleId,
  PrincipalId,
  TransactionScope,
} from "@platos/context-eventing/application/ports/index.js";
import {
  asIdentifier,
  createNotificationRule,
  parseDestination,
  parseRuleFilter,
  parseRuleName,
} from "@platos/context-eventing/application/ports/index.js";

import type { TenancyDatabaseClient } from "./client.js";
import {
  startEventingHarness,
  type EventingHarness,
  type EventingTenant,
} from "./eventing-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: EventingHarness;
let tenant: EventingTenant;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;

let sequence = 0;
function freshRuleId(): string {
  sequence += 1;
  return `bcbcbcbc-0001-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function ruleFor(scope: NotificationRule["scope"], name: string): NotificationRule {
  const filter = parseRuleFilter({ eventTypes: ["run.completed"] });
  const destination = parseDestination({ type: "slack", url: "https://hooks.example/x" });
  const parsedName = parseRuleName(name);
  if (!filter.ok || !destination.ok || !parsedName.ok) throw new Error("fixture must parse");
  return createNotificationRule(
    {
      ruleId: asIdentifier<NotificationRuleId>(freshRuleId()),
      scope,
      name: parsedName.value,
      filter: filter.value,
      destination: destination.value,
      createdBy: asIdentifier<PrincipalId>("operator-a"),
    },
    new Date("2026-06-01T09:00:00.000Z"),
  );
}

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

/** How many rules the SECOND client can see in this environment. */
async function seenByObserver(name: string): Promise<number> {
  return observer.notificationRule.count({
    where: { environmentId: tenant.environmentId, name },
  });
}

beforeAll(async () => {
  harness = await startEventingHarness();
  tenant = await harness.freshTenant();
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
}, 300_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

describe("a unit of work commits whole or not at all", () => {
  test("a throw after a successful insert leaves NO row for a second connection", async () => {
    const rule = ruleFor(tenant.scope, "rollback-on-throw");
    await harness
      .run(async (transaction) => {
        const written = await harness.repository.insertRule(rule, transaction);
        expect(written.ok).toBe(true);
        // The injected failure. It is deliberately AFTER the write and outside
        // the store, so what is measured is the boundary rather than the guard.
        throw new Error("injected: the caller's own second step failed");
      })
      .catch(() => undefined);

    expect(await seenByObserver("rollback-on-throw")).toBe(0);
  }, 300_000);

  test("an error `Result` from the SECOND write takes the FIRST write with it", async () => {
    // The `cost-monitoring` trap, and this context's own sharpest form of it.
    // Both inserts are the ADAPTER's own statements; nothing is simulated. The
    // second is refused by `@@unique([environmentId, name])`, which aborts the
    // block — so the COMMIT the resolved callback issues is turned into a
    // ROLLBACK by PostgreSQL, and the row whose `Result` said `ok` is not there
    // either.
    const first = ruleFor(tenant.scope, "clash-first");
    const seed = ruleFor(tenant.scope, "clash-taken");
    const seeded = await harness.run((t) => harness.repository.insertRule(seed, t));
    expect(seeded.ok).toBe(true);

    const clashing: NotificationRule = { ...ruleFor(tenant.scope, "clash-taken") };
    const outcome = await harness.run(async (transaction) => {
      const written = await harness.repository.insertRule(first, transaction);
      expect(written.ok).toBe(true);
      return harness.repository.insertRule(clashing, transaction);
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error.code).toBe("EVENTING_RULE_NAME_TAKEN");
    // The ACCEPTED row is absent, which is the finding.
    expect(await seenByObserver("clash-first")).toBe(0);
    // And the row that was already committed before this unit of work is
    // untouched, which is what makes the case a rollback rather than a wipe.
    expect(await seenByObserver("clash-taken")).toBe(1);
  }, 300_000);

  test("a GUARD refusal sends no statement, so the same unit of work still commits", async () => {
    // The other half of the measurement above, and the whole argument for
    // refusing in TypeScript. Same shape, same transaction, one refusal caught
    // before the driver saw it — and the good row survives.
    const good = ruleFor(tenant.scope, "guard-survivor");
    const doomed: NotificationRule = {
      ...ruleFor(tenant.scope, "guard-doomed"),
      ruleId: asIdentifier<NotificationRuleId>("not-a-uuid"),
    };
    const outcome = await harness.run(async (transaction) => {
      const refused = await harness.repository.insertRule(doomed, transaction);
      expect(refused.ok).toBe(false);
      return harness.repository.insertRule(good, transaction);
    });
    expect(outcome.ok).toBe(true);
    expect(await seenByObserver("guard-survivor")).toBe(1);
    expect(await seenByObserver("guard-doomed")).toBe(0);
  }, 300_000);

  test("a delete and an insert in one unit of work are one atom", async () => {
    // The erasure path in miniature: `privacy` composes several targets in ONE
    // transaction, so a failure in a LATER target must take this one's scrub
    // back. Here the later step throws and the earlier delete is undone.
    const doomed = ruleFor(tenant.scope, "atomic-delete");
    const seeded = await harness.run((t) => harness.repository.insertRule(doomed, t));
    expect(seeded.ok).toBe(true);
    expect(await seenByObserver("atomic-delete")).toBe(1);

    await harness
      .run(async (transaction) => {
        const removed = await harness.repository.deleteRule(tenant.scope, doomed.ruleId, transaction);
        expect(removed.ok && removed.value).toBe(true);
        throw new Error("injected: a later erasure target refused");
      })
      .catch(() => undefined);

    expect(await seenByObserver("atomic-delete")).toBe(1);
  }, 300_000);

  test("the raw anonymisation rolls back with its unit of work", async () => {
    // `anonymizeRulesForSubject` is the one write in this store that is raw SQL
    // rather than a delegate call. A raw statement is inside the transaction
    // exactly as a delegate call is — but that is a claim about how the client
    // routes `$executeRaw`, not an axiom, and it is the claim the whole erasure
    // path rests on.
    const rule = ruleFor(tenant.scope, "raw-rollback");
    const seeded = await harness.run((t) => harness.repository.insertRule(rule, t));
    expect(seeded.ok).toBe(true);

    await harness
      .run(async (transaction) => {
        const scrubbed = await harness.repository.anonymizeRulesForSubject(
          { scope: tenant.scope, principalId: "operator-a" },
          "erased:subject-removed",
          transaction,
        );
        expect(scrubbed.ok && scrubbed.value > 0).toBe(true);
        throw new Error("injected: the erasure operation refused after this target ran");
      })
      .catch(() => undefined);

    const row = await observer.notificationRule.findFirst({
      where: { environmentId: tenant.environmentId, name: "raw-rollback" },
      select: { createdBy: true },
    });
    expect(row?.createdBy).toBe("operator-a");
  }, 300_000);
});

describe("the three scope refusals are three distinct codes", () => {
  test("a write with NO open transaction is `not_open`", async () => {
    const rule = ruleFor(tenant.scope, "no-transaction");
    const stray: TransactionScope = { transactionId: asIdentifier("pg-txn-does-not-exist") };
    const raised = await harness.repository
      .insertRule(rule, stray)
      .then(() => "RESOLVED")
      .catch((error: unknown) => codeOf(error));
    expect(raised).toBe(TRANSACTION_NOT_OPEN);
    expect(await seenByObserver("no-transaction")).toBe(0);
  }, 300_000);

  test("a write with a FINISHED transaction's token is `scope_unknown`", async () => {
    // The token is real and was minted by this very adapter; it has simply
    // outlived its transaction. A single shared code would make this
    // indistinguishable from the case above in a log.
    let stale: TransactionScope | null = null;
    await harness.run(async (transaction) => {
      stale = transaction;
      return undefined;
    });
    const rule = ruleFor(tenant.scope, "stale-token");
    const raised = await harness
      .run(async () => {
        if (stale === null) throw new Error("the fixture must capture a token");
        return harness.repository.insertRule(rule, stale);
      })
      .then(() => "RESOLVED")
      .catch((error: unknown) => codeOf(error));
    expect(raised).toBe(TRANSACTION_SCOPE_UNKNOWN);
    expect(await seenByObserver("stale-token")).toBe(0);
  }, 300_000);

  test("a write with ANOTHER LIVE transaction's token is `scope_foreign`", async () => {
    // The concurrent unit of work is opened from OUTSIDE any frame, deliberately.
    // `UnitOfWork.run` JOINS an open transaction rather than opening a second
    // one, so a nested call carries the SAME id and could never be foreign; the
    // foreign token has to come from a genuinely separate async context.
    let openConcurrent: (scope: TransactionScope) => void = () => undefined;
    let releaseConcurrent: () => void = () => undefined;
    const opened = new Promise<TransactionScope>((resolve) => {
      openConcurrent = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseConcurrent = resolve;
    });
    const held = harness.base.adapter.unitOfWork.run(async (concurrent) => {
      openConcurrent(concurrent);
      await release;
    });

    const other = await opened;
    const rule = ruleFor(tenant.scope, "foreign-token");
    const thrown = await harness.run((live) => {
      expect(live.transactionId).not.toBe(other.transactionId);
      return harness.repository
        .insertRule(rule, other)
        .then(() => null)
        .catch((error: unknown) => error);
    });
    releaseConcurrent();
    await held;
    expect(codeOf(thrown)).toBe(TRANSACTION_SCOPE_FOREIGN);
    expect(await seenByObserver("foreign-token")).toBe(0);
  }, 300_000);

  test("the three codes are distinct strings", () => {
    // The acceptance condition stated directly: two guards sharing one code
    // cannot be told apart, whatever else a suite proves about them.
    expect(
      new Set([TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_UNKNOWN, TRANSACTION_SCOPE_FOREIGN]).size,
    ).toBe(3);
  });
});
