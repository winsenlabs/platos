// The transaction boundary, proved by FAILURE INJECTION against a real database,
// and the three scope refusals.
//
// WHY INJECTION AND NOT A ROLLBACK COUNT. A store that counted rollbacks would
// pass a suite that asserted rollbacks. Every case below forces the SECOND write
// of a multi-statement operation to fail and then LOOKS FOR THE FIRST ROW — over
// a second client, on a connection this adapter's pool never touched, because
// durability is not "the row is there when the writer looks again" but "the row
// is there when somebody else looks".
//
// THE MULTI-STATEMENT OPERATION ON THIS PORT IS THE DEFAULT ROTATION.
// `application/provider-key-store.ts` demotes the incumbent and then writes the
// challenger inside ONE `UnitOfWork.run`, and its own header says why: "THE
// DEMOTION AND THE PROMOTION SHARE ONE TRANSACTION. That is what makes the
// store's partial unique index a backstop rather than a race." A rotation whose
// second half failed and whose first half survived leaves an environment with NO
// default key for that provider — produced by an operation that reported a clean
// refusal.
//
// AND THIS SUITE STATES BOTH HALVES OF THAT, because they are different claims:
//
//   A REJECTED callback rolls both writes back. That is `UnitOfWork.run`'s own
//   contract and the case below forces it with the adapter's OWN write-shape
//   guard rather than with a simulated throw.
//
//   A RETURNED error `Result` COMMITS. `UnitOfWork.run` commits when its
//   callback RESOLVES, and every refusal this store answers with is a resolved
//   `Result`. `providers-guards.ts` explains the savepoint that makes that
//   commit HONEST rather than empty — without it the earlier writes would be
//   silently discarded at COMMIT with no error at all — and the case below
//   measures the commit rather than assuming it. It is the same shape as the
//   `cost-monitoring` defect that shipped: an error `Result` returned from
//   inside the callback resolves, which commits.
//
// AND `touchProviderKey` IS OUTSIDE ALL OF IT, which is the one place this port
// differs from every other in this directory. Its own documentation forbids the
// enlistment — "a failed write of this timestamp would roll back the turn that
// succeeded" — so the last case here opens a transaction, touches a key inside
// it, and then REJECTS: the turn's writes vanish and the timestamp stays.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentScope,
  ProviderId,
  ProviderKey,
  ProviderKeyId,
} from "@platos/context-providers/application/ports/index.js";
import { asProvidersIdentifier } from "@platos/context-providers/application/ports/index.js";
import type { TransactionId } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";
import { runResult } from "@platos/kernel";

import type { TenancyDatabaseClient } from "./client.js";
import type { ProvidersHarness } from "./providers-harness.js";
import { startProvidersHarness } from "./providers-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: ProvidersHarness;
let scope: EnvironmentScope;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;
let incumbentCredential: string;
let challengerCredential: string;

const AT = new Date("2026-05-01T09:00:00.000Z");
const LATER = new Date("2026-05-01T10:00:00.000Z");
const ANTHROPIC = asProvidersIdentifier<ProviderId>("anthropic");

function uuid(slot: string): string {
  return `fa000000-${slot}-4000-8000-000000000000`;
}

const INCUMBENT = uuid("0001");
const CHALLENGER = uuid("0002");

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

function key(
  id: string,
  credentialId: string,
  label: string,
  credentialName: string,
  isDefault: boolean,
  overrides: Partial<ProviderKey> = {},
): ProviderKey {
  return {
    providerKeyId: asProvidersIdentifier<ProviderKeyId>(id),
    environmentId: scope.environmentId,
    credentialId: asProvidersIdentifier(credentialId),
    provider: ANTHROPIC,
    label,
    credentialName: asProvidersIdentifier(credentialName),
    isDefault,
    createdBy: asProvidersIdentifier("operator-1"),
    lastUsedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

beforeAll(async () => {
  harness = await startProvidersHarness();
  scope = await harness.freshScope();
  incumbentCredential = await harness.seedCredential(scope, {
    provider: "anthropic",
    name: "ANTHROPIC_INCUMBENT",
  });
  challengerCredential = await harness.seedCredential(scope, {
    provider: "anthropic",
    name: "ANTHROPIC_CHALLENGER",
  });
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
  // The incumbent default, written before anything under test runs.
  await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.repository.insertProviderKey(
      key(INCUMBENT, incumbentCredential, "incumbent", "ANTHROPIC_INCUMBENT", true),
      transaction,
    ),
  );
}, 300_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

describe("a demotion and a promotion are one transaction or neither", () => {
  test("the promotion REJECTS and the demotion does not survive it", async () => {
    // THE FAILURE IS THE ADAPTER'S OWN GUARD, not a throw this suite invents.
    // `ProviderKey.createdAt` reaches a `TIMESTAMP(3)`, and `requireInstant`
    // refuses an `Invalid Date` by THROWING — which is what the port's "a
    // rejected promise is a defect, not an outcome" leaves room for, and which
    // is exactly how a defect in a caller reaches this boundary.
    await expect(
      runResult(harness.base.adapter.unitOfWork, async (transaction) => {
        const demoted = await harness.repository.updateProviderKey(
          key(INCUMBENT, incumbentCredential, "incumbent", "ANTHROPIC_INCUMBENT", false, {
            updatedAt: LATER,
          }),
          transaction,
        );
        expect(demoted.ok).toBe(true);
        return harness.repository.insertProviderKey(
          key(CHALLENGER, challengerCredential, "challenger", "ANTHROPIC_CHALLENGER", true, {
            createdAt: new Date("nonsense"),
          }),
          transaction,
        );
      }),
    ).rejects.toThrow();

    // OVER THE SECOND CLIENT. The incumbent is STILL the default: the demotion
    // rolled back with the promotion it belonged to, so the environment did not
    // end up with no default key for this provider.
    const row = await observer.providerKey.findUniqueOrThrow({ where: { id: INCUMBENT } });
    expect(row.isDefault).toBe(true);
    expect(row.updatedAt).toEqual(AT);
    expect(await observer.providerKey.count({ where: { id: CHALLENGER } })).toBe(0);
  });

  test("and a rotation that is not interfered with COMMITS both rows", async () => {
    // THE NEGATIVE CONTROL. Without it the case above would pass against a store
    // that never wrote anything at all.
    const rotated = await runResult(harness.base.adapter.unitOfWork, async (transaction) => {
      const demoted = await harness.repository.updateProviderKey(
        key(INCUMBENT, incumbentCredential, "incumbent", "ANTHROPIC_INCUMBENT", false, {
          updatedAt: LATER,
        }),
        transaction,
      );
      if (!demoted.ok) return demoted;
      return harness.repository.insertProviderKey(
        key(CHALLENGER, challengerCredential, "challenger", "ANTHROPIC_CHALLENGER", true),
        transaction,
      );
    });
    expect(rotated.ok).toBe(true);
    const incumbent = await observer.providerKey.findUniqueOrThrow({ where: { id: INCUMBENT } });
    expect(incumbent.isDefault).toBe(false);
    expect(incumbent.updatedAt).toEqual(LATER);
    const challenger = await observer.providerKey.findUniqueOrThrow({ where: { id: CHALLENGER } });
    expect(challenger.isDefault).toBe(true);
  });
});

describe("a RETURNED error Result commits what came before it", () => {
  test("the earlier write survives a refusal the store reports as a value", async () => {
    // THIS IS NOT A DEFECT AND IT IS NOT AN ACCIDENT. `UnitOfWork.run` commits
    // when its callback RESOLVES, and a refusal this store recognises is a
    // resolved `Result` rather than a rejection. Without the savepoint in
    // `providers-guards.ts` the earlier write would NOT have survived — the
    // refusal would have aborted the transaction and the COMMIT would have been
    // executed as a ROLLBACK with no error — so what this case measures is that
    // the commit is HONEST rather than empty.
    //
    // Which of the two a caller wants is the caller's decision and this adapter
    // does not make it. What it removes is the outcome where the answer depends
    // on whether the store happened to raise.
    const third = await harness.seedCredential(scope, {
      provider: "anthropic",
      name: "ANTHROPIC_THIRD",
    });
    const outcome = await runResult(harness.base.adapter.unitOfWork, async (transaction) => {
      const written = await harness.repository.insertProviderKey(
        key(uuid("0003"), third, "third", "ANTHROPIC_THIRD", false),
        transaction,
      );
      expect(written.ok).toBe(true);
      // Refused by the label index: `third` is now taken.
      return harness.repository.insertProviderKey(
        key(uuid("0004"), third, "third", "ANTHROPIC_THIRD", false),
        transaction,
      );
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "PROVIDERS_KEY_ALREADY_EXISTS" } });
    expect(await observer.providerKey.count({ where: { id: uuid("0003") } })).toBe(1);
    expect(await observer.providerKey.count({ where: { id: uuid("0004") } })).toBe(0);
  });
});

describe("touchProviderKey is outside the caller's unit of work", () => {
  test("the timestamp survives a transaction that rolled everything else back", async () => {
    // The port's instruction, measured: "Deliberately NOT transactional. It is
    // bookkeeping on a read path, and enlisting it in the caller's unit of work
    // would make a failed write of this timestamp roll back the turn that
    // succeeded." A store that resolved this write through `reader()` — which
    // returns the ambient transaction's own client whenever one is open — would
    // lose the timestamp here, and every other case in every other suite would
    // still be green.
    const before = await observer.providerKey.findUniqueOrThrow({ where: { id: CHALLENGER } });
    expect(before.lastUsedAt).toBeNull();

    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction) => {
        await harness.repository.updateProviderKey(
          key(CHALLENGER, challengerCredential, "challenger", "ANTHROPIC_CHALLENGER", true, {
            label: "renamed inside a doomed transaction",
            updatedAt: LATER,
          }),
          transaction,
        );
        await harness.repository.touchProviderKey(
          asProvidersIdentifier<ProviderKeyId>(CHALLENGER),
          LATER,
        );
        throw new Error("the turn failed");
      }),
    ).rejects.toThrow("the turn failed");

    const after = await observer.providerKey.findUniqueOrThrow({ where: { id: CHALLENGER } });
    // The rename went with the transaction. The usage timestamp did not.
    expect(after.label).toBe("challenger");
    expect(after.lastUsedAt).toEqual(LATER);
    // AND `updatedAt` DID NOT MOVE. `ProviderKey.updatedAt` is `@updatedAt`, so
    // a delegate write would have re-dated the row on the way past; the touch is
    // a raw single-column UPDATE for exactly that reason.
    expect(after.updatedAt).toEqual(AT);
  });
});

describe("the three transaction-scope refusals, on this context's writes", () => {
  test("a write with NO open transaction is refused with not_open", async () => {
    let refusal = "<no refusal>";
    try {
      await harness.repository.insertProviderKey(
        key(uuid("0005"), incumbentCredential, "orphan", "ANTHROPIC_INCUMBENT", false),
        { transactionId: asIdentifier<TransactionId>("pg-txn-999") },
      );
    } catch (error) {
      refusal = codeOf(error);
    }
    expect(refusal).toBe(TRANSACTION_NOT_OPEN);
  });

  test("a write carrying a FINISHED transaction's token is refused with scope_unknown", async () => {
    let stale = { transactionId: asIdentifier<TransactionId>("pg-txn-0") };
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      stale = transaction as typeof stale;
    });
    let refusal = "<no refusal>";
    try {
      await runResult(harness.base.adapter.unitOfWork, () =>
        harness.repository.insertProviderKey(
          key(uuid("0006"), incumbentCredential, "stale", "ANTHROPIC_INCUMBENT", false),
          stale,
        ),
      );
    } catch (error) {
      refusal = codeOf(error);
    }
    // THREE DISTINCT CODES, AND THIS IS THE ONE THAT SEPARATES A CLOSED
    // TRANSACTION FROM ANOTHER LIVE ONE. A single shared code would make the two
    // indistinguishable in a log.
    expect(refusal).toBe(TRANSACTION_SCOPE_UNKNOWN);
  });

  test("a write carrying ANOTHER live transaction's token is refused with scope_foreign", async () => {
    // The second transaction is opened OUTSIDE any ambient frame and held on a
    // gate, so it is genuinely CONCURRENT rather than a nested join —
    // `UnitOfWork.run` joins an open transaction, which is its contract, so a
    // run started inside the outer callback would hand back the outer's own
    // token and this case would measure nothing.
    let release = (): void => undefined;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    let concurrent: { readonly transactionId: TransactionId } | undefined;
    const held = new Promise<void>((ready) => {
      void harness.base.adapter.unitOfWork.run(async (transaction) => {
        concurrent = transaction;
        ready();
        await gate;
      });
    });
    await held;
    const foreign = concurrent as { readonly transactionId: TransactionId };

    let refusal = "<no refusal>";
    await harness.base.adapter.unitOfWork.run(async (live) => {
      expect(foreign.transactionId).not.toBe(live.transactionId);
      try {
        await harness.repository.insertProviderKey(
          key(uuid("0007"), incumbentCredential, "foreign", "ANTHROPIC_INCUMBENT", false),
          foreign,
        );
      } catch (error) {
        refusal = codeOf(error);
      }
    });
    release();
    expect(refusal).toBe(TRANSACTION_SCOPE_FOREIGN);
  });
});
