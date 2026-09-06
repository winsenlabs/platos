// The transaction boundary, proved by FAILURE INJECTION against a real database,
// and the three scope refusals.
//
// WHY INJECTION AND NOT A ROLLBACK COUNT. A store that counted rollbacks would
// pass a suite that asserted rollbacks. Every case below forces the SECOND write
// of a multi-write unit to fail and then LOOKS FOR THE FIRST ROW — over a second
// client, on a connection this adapter's pool never touched, because durability
// is not "the row is there when the writer looks again" but "the row is there
// when somebody else looks".
//
// AND THE OTHER HALF IS THE ONE THAT SHIPPED IN `cost-monitoring`. A returned
// error `Result` RESOLVES, and a callback that resolves COMMITS. That context's
// `detect-crossings.ts` returned an error from inside `unitOfWork.run` on a
// fan-out failure and left exactly the stranded crossing the file was written to
// prevent. So this suite pins BOTH answers, because for `channels` they differ
// by which refusal you got:
//
//   A refusal the STORE minted — a guard, a probe, a scope check — leaves the
//   transaction healthy, and everything written before it COMMITS.
//
//   A refusal the DATABASE minted — a constraint, a rule — has already put the
//   transaction into the aborted state, so the COMMIT the resolved callback asks
//   for is executed as a ROLLBACK and everything written before it is gone.
//
// Both are correct and neither is obvious, and a caller that assumed the first
// while getting the second would report success for rows that no longer exist.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AgentId,
  ChannelApp,
  ChannelAppId,
  ChannelConnection,
  ChannelConnectionId,
  EnvironmentScope,
} from "@platos/context-channels/application/ports/index.js";
import { asIdentifier, environmentScope } from "@platos/context-channels/application/ports/index.js";
import type { TransactionId } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyDatabaseClient } from "./client.js";
import { CONFORMANCE_AT } from "./channels-conformance.js";
import type { ChannelsHarness } from "./channels-harness.js";
import { startChannelsHarness } from "./channels-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: ChannelsHarness;
let scope: EnvironmentScope;
let otherScope: EnvironmentScope;
let foreignAgentId: string;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;

beforeAll(async () => {
  harness = await startChannelsHarness();
  scope = await harness.freshScope();
  otherScope = await harness.freshScope();
  foreignAgentId = await harness.seedAgent(otherScope);
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
}, 600_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

function connectionIn(
  where: EnvironmentScope,
  id: string,
  overrides: Partial<ChannelConnection> = {},
): ChannelConnection {
  return {
    connectionId: asIdentifier<ChannelConnectionId>(id),
    scope: where,
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

function appIn(where: EnvironmentScope, id: string): ChannelApp {
  return {
    appId: asIdentifier<ChannelAppId>(id),
    scope: where,
    provider: "slack",
    displayName: null,
    clientId: `client-${id.slice(-8)}`,
    credentialId: null,
    scopes: [],
    distribution: "private",
    defaultAgentId: null,
    agentRouting: [],
    createdAt: CONFORMANCE_AT,
  };
}

/** Whether a row is visible to somebody who is not the writer. */
async function connectionExists(id: string): Promise<boolean> {
  const found = await observer.channelConnection.findUnique({
    where: { id },
    select: { id: true },
  });
  return found !== null;
}

async function appExists(id: string): Promise<boolean> {
  const found = await observer.channelApp.findUnique({ where: { id }, select: { id: true } });
  return found !== null;
}

describe("a write the DATABASE refuses takes everything written before it with it", () => {
  test("neither row survives when the second write violates the ancestry rule", async () => {
    const first = harness.base.freshId("0501");
    const second = harness.base.freshId("0502");
    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const good = await harness.repository.saveConnection(
        connectionIn(scope, first),
        transaction,
      );
      // THE INJECTED FAILURE. The agent is real and belongs to another PROJECT,
      // which `enforce_domain_ancestry` refuses — and the refusal aborts the
      // transaction the first row is sitting in.
      const bad = await harness.repository.saveConnection(
        connectionIn(scope, second, { defaultAgentId: asIdentifier<AgentId>(foreignAgentId) }),
        transaction,
      );
      return { good: good.ok, bad: bad.ok };
    });
    expect(outcome).toEqual({ good: true, bad: false });
    expect(await connectionExists(first)).toBe(false);
    expect(await connectionExists(second)).toBe(false);
  });

  test("the negative control: both writes land when neither is refused", async () => {
    // WITHOUT THIS, the case above passes against a store that never commits
    // anything at all.
    const first = harness.base.freshId("0503");
    const second = harness.base.freshId("0504");
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.saveConnection(connectionIn(scope, first), transaction);
      await harness.repository.saveApp(appIn(scope, second), transaction);
    });
    expect(await connectionExists(first)).toBe(true);
    expect(await appExists(second)).toBe(true);
  });

  test("a throw from the callback rolls the whole unit back", async () => {
    const first = harness.base.freshId("0505");
    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction) => {
        await harness.repository.saveConnection(connectionIn(scope, first), transaction);
        throw new Error("injected");
      }),
    ).rejects.toThrow("injected");
    expect(await connectionExists(first)).toBe(false);
  });
});

describe("a refusal the STORE minted resolves, and a resolved callback COMMITS", () => {
  test("a guard refusal leaves the earlier write committed", async () => {
    // THE `cost-monitoring` TRAP, measured here rather than assumed away. The
    // second call never reaches the database — the identifier guard refuses it —
    // so the transaction is healthy, the callback resolves, and the COMMIT is a
    // real commit. A use case that treated "I returned an error" as "nothing was
    // written" would be wrong about the first row.
    const first = harness.base.freshId("0506");
    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.saveConnection(connectionIn(scope, first), transaction);
      const refused = await harness.repository.saveConnection(
        connectionIn(scope, "conn-not-a-uuid"),
        transaction,
      );
      return refused.ok;
    });
    expect(outcome).toBe(false);
    expect(await connectionExists(first)).toBe(true);
  });

  test("a scope refusal leaves the earlier write committed too", async () => {
    const first = harness.base.freshId("0507");
    const unknownEnvironment = environmentScope(
      scope.organizationId,
      scope.projectId,
      asIdentifier(harness.base.freshId("0508")),
    );
    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.saveConnection(connectionIn(scope, first), transaction);
      const refused = await harness.repository.saveConnection(
        connectionIn(unknownEnvironment, harness.base.freshId("0509")),
        transaction,
      );
      return refused.ok;
    });
    expect(outcome).toBe(false);
    expect(await connectionExists(first)).toBe(true);
  });

  test("the link probe refuses without touching the database, so the unit still commits", async () => {
    // The conflicting insert is answered from the PROBE, not from a failed
    // INSERT, which is what keeps this transaction usable. See
    // `channels-links.ts`: reading the winner back after the violation is what
    // the aborted transaction refuses.
    const connectionId = harness.base.freshId("050a");
    const thread = await harness.seedThread(scope);
    const other = await harness.seedThread(scope);
    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.saveConnection(connectionIn(scope, connectionId), transaction),
    );
    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertThreadLink(
        {
          linkId: asIdentifier(harness.base.freshId("050b")),
          owner: { kind: "connection", connectionId: asIdentifier(connectionId) },
          channelThreadKey: asIdentifier("channel:C0TX:1.0"),
          threadId: asIdentifier(thread.threadId),
          createdAt: CONFORMANCE_AT,
        },
        transaction,
      ),
    );
    const laterApp = harness.base.freshId("050c");
    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.saveApp(appIn(scope, laterApp), transaction);
      const conflicted = await harness.repository.insertThreadLink(
        {
          linkId: asIdentifier(harness.base.freshId("050d")),
          owner: { kind: "connection", connectionId: asIdentifier(connectionId) },
          channelThreadKey: asIdentifier("channel:C0TX:1.0"),
          threadId: asIdentifier(other.threadId),
          createdAt: CONFORMANCE_AT,
        },
        transaction,
      );
      return conflicted.ok ? "" : conflicted.error.code;
    });
    expect(outcome).toBe("CHANNELS_THREAD_LINK_CONFLICT");
    expect(await appExists(laterApp)).toBe(true);
  });
});

describe("the three refusals a write carrying the wrong token gets", () => {
  test("a write outside any transaction is not_open", async () => {
    // The scope is well-formed and no transaction is open, which is a DIFFERENT
    // mistake from carrying a token whose transaction has finished.
    const outside = { transactionId: asTenancyIdentifier<TransactionId>("pg-txn-none") };
    await expect(
      harness.repository.saveConnection(
        connectionIn(scope, harness.base.freshId("050e")),
        outside,
      ),
    ).rejects.toMatchObject({ code: TRANSACTION_NOT_OPEN });
  });

  test("a token whose transaction has already finished is scope_unknown", async () => {
    let expired = { transactionId: asTenancyIdentifier<TransactionId>("pg-txn-none") };
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      expired = transaction as typeof expired;
    });
    await harness.base.adapter.unitOfWork.run(async () => {
      await expect(
        harness.repository.saveConnection(
          connectionIn(scope, harness.base.freshId("050f")),
          expired,
        ),
      ).rejects.toMatchObject({ code: TRANSACTION_SCOPE_UNKNOWN });
    });
  });

  test("another live transaction's token is scope_foreign", async () => {
    // The second transaction is opened OUTSIDE any ambient frame and held open
    // while the first tries to write with its token, so BOTH are live and the
    // refusal cannot be the expired one.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let foreign: { transactionId: TransactionId } | null = null;
    const other = harness.base.adapter.unitOfWork.run(async (transaction) => {
      foreign = transaction as { transactionId: TransactionId };
      await held;
    });
    while (foreign === null) await new Promise((resolve) => setTimeout(resolve, 5));
    await harness.base.adapter.unitOfWork.run(async () => {
      await expect(
        harness.repository.saveConnection(
          connectionIn(scope, harness.base.freshId("0510")),
          foreign as unknown as { transactionId: TransactionId },
        ),
      ).rejects.toMatchObject({ code: TRANSACTION_SCOPE_FOREIGN });
    });
    release();
    await other;
  });

  test("the three refusals carry three DISTINCT codes", () => {
    // Two guards returning one code cannot be told apart in a log, which is how
    // two defects hid behind one code in `privacy` and in `identity-access`.
    const codes = [TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_UNKNOWN, TRANSACTION_SCOPE_FOREIGN];
    expect(new Set(codes).size).toBe(3);
    expect(codeOf({ code: TRANSACTION_NOT_OPEN })).toBe(TRANSACTION_NOT_OPEN);
  });
});
