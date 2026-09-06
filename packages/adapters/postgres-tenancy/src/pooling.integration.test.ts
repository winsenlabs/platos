// THE POOL AND THE TIMEOUTS, ASKED OF A REAL SERVER.
//
// `client.test.ts` next door proves what `buildDatasourceUrl` WRITES. It cannot
// prove what the server RECEIVES, and that gap is where WIN-258 T7 found the
// defect this suite exists to keep closed: the adapter wrote
// `statement_timeout=<ms>` onto the datasource URL, the driver recognises a
// CLOSED list of connection-string parameters and silently discards the rest, so
// the setting was validated, serialised, sent and thrown away. Every reader of
// `client.ts` would have said the adapter had a statement timeout. It had none,
// and no unit test in this package could have said otherwise, because a URL is
// exactly as convincing wrong as it is right.
//
// SO EVERY CASE HERE ASKS THE SERVER, TWICE OVER. First `current_setting`, which
// is the server repeating the value back; then a statement that must be REFUSED,
// because a setting the server reports and does not enforce is still not a
// timeout. Each refusal is asserted by its OWN code, so a case cannot pass on a
// refusal that came from somewhere else: 57014 for a statement that ran too long
// and 55P03 for one that waited too long for a lock.
//
// THE THIRD ONE DOES NOT ARRIVE AS A SQLSTATE AND THE CASE SAYS SO. PostgreSQL
// does not cancel a statement when a transaction sits idle past
// `idle_in_transaction_session_timeout` — it TERMINATES the backend, so what
// reaches the caller is a closed socket and the client's own `P1017`. The
// setting still does its job, and the case proves the job rather than the code:
// the abandoned transaction's row is absent from a connection this client never
// touched.
//
// THE FIRST CASE IS THE OLD SHAPE, KEPT DELIBERATELY. It builds the URL the way
// T5 shipped it and asserts the server reports `'0'`. Without it the fix is a
// change nobody can see the point of, and a revert to the query-parameter form
// would go green.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { TenancyDatabaseClient, TenancyPoolSettings } from "./client.js";
import { createTenancyDatabaseClient } from "./client.js";
import type { TenancyHarness } from "./harness.js";
import { startTenancyHarness } from "./harness.js";

let harness: TenancyHarness;

/** Every client a case opens, disconnected in `afterAll` even on a failure. */
const opened: TenancyDatabaseClient[] = [];

beforeAll(async () => {
  harness = await startTenancyHarness();
}, 180_000);

afterAll(async () => {
  await Promise.all(opened.map((client) => client.$disconnect().catch(() => undefined)));
  await harness?.stop();
});

/** A client over the SAME database, with settings of this case's own choosing. */
function open(pool: TenancyPoolSettings): TenancyDatabaseClient {
  const client = createTenancyDatabaseClient({ databaseUrl: harness.databaseUrl, ...pool });
  opened.push(client);
  return client;
}

/** A client over a URL a case wrote itself, for the shapes the adapter refuses to write. */
function openRaw(build: (url: URL) => void): TenancyDatabaseClient {
  const url = new URL(harness.databaseUrl);
  build(url);
  const client = createTenancyDatabaseClient({ databaseUrl: url.toString() });
  opened.push(client);
  return client;
}

/**
 * How a call was refused: the server's SQLSTATE when there is one, the client's
 * own code when there is not, and `<resolved>` when it was not refused at all.
 *
 * ALL THREE BRANCHES ARE LOAD-BEARING. The client reports a raw-query failure as
 * its own `P2010` and carries the server's five-character code in `meta.code`, so
 * matching on `P2010` alone would make a statement timeout, a lock timeout and a
 * syntax error the same assertion — the shared-code mistake this tranche's own
 * transaction guards were split to avoid. And `<resolved>` is here because the
 * first draft of this helper answered `null` BOTH when a call succeeded and when
 * it failed with no SQLSTATE, which made the idle-timeout case below read as a
 * timeout that never fired when in fact it had fired and killed the connection.
 */
function refusalCode(error: unknown): string {
  const carrier = error as {
    readonly code?: unknown;
    readonly meta?: { readonly code?: unknown };
  } | null;
  if (typeof carrier?.meta?.code === "string") return carrier.meta.code;
  if (typeof carrier?.code === "string") return carrier.code;
  return "<unclassified>";
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "<resolved>";
  } catch (error) {
    return refusalCode(error);
  }
}

const settingsOf = async (
  client: TenancyDatabaseClient,
): Promise<Record<string, string>> => {
  const [row] = await client.$queryRawUnsafe<readonly Record<string, string>[]>(
    `SELECT current_setting('statement_timeout') AS statement_timeout,
            current_setting('lock_timeout') AS lock_timeout,
            current_setting('idle_in_transaction_session_timeout') AS idle_timeout`,
  );
  return row as Record<string, string>;
};

const settle = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

describe("the server timeouts reach the server", () => {
  test("the QUERY-PARAMETER shape T5 shipped installs nothing at all", async () => {
    const client = openRaw((url) => {
      url.searchParams.set("statement_timeout", "250");
    });
    const settings = await settingsOf(client);
    // `'0'` is PostgreSQL for "no timeout". The parameter was on the URL, the
    // connection opened without complaint, and the server never heard of it.
    expect(settings.statement_timeout).toBe("0");
    const started = Date.now();
    await client.$queryRawUnsafe("SELECT pg_sleep(0.75)::text AS slept");
    expect(Date.now() - started).toBeGreaterThan(700);
  });

  test("the OPTIONS shape reports all three settings back, with their units", async () => {
    const client = open({
      statementTimeoutMs: 400,
      lockTimeoutMs: 200,
      idleInTransactionSessionTimeoutMs: 900,
    });
    expect(await settingsOf(client)).toEqual({
      statement_timeout: "400ms",
      lock_timeout: "200ms",
      idle_timeout: "900ms",
    });
  });

  test("a caller's own options survive, and the adapter's timeout is the one in force", async () => {
    // `-c` flags are applied left to right and the last wins, which is why
    // `buildDatasourceUrl` appends rather than replacing. Both halves are
    // asserted: the caller's unrelated setting is still there, and the adapter's
    // statement timeout beat the caller's.
    const url = new URL(harness.databaseUrl);
    url.searchParams.set("options", "-c application_name=caller -c statement_timeout=30s");
    const client = createTenancyDatabaseClient({
      databaseUrl: url.toString(),
      statementTimeoutMs: 350,
    });
    opened.push(client);
    const [row] = await client.$queryRawUnsafe<readonly Record<string, string>[]>(
      `SELECT current_setting('application_name') AS name,
              current_setting('statement_timeout') AS statement_timeout`,
    );
    expect(row).toEqual({ name: "caller", statement_timeout: "350ms" });
  });
});

describe("each timeout REFUSES, with its own SQLSTATE", () => {
  test("a statement that outruns statementTimeoutMs is cancelled with 57014", async () => {
    const client = open({ statementTimeoutMs: 250 });
    const started = Date.now();
    expect(await refusal(client.$queryRawUnsafe("SELECT pg_sleep(3)::text AS slept"))).toBe(
      "57014",
    );
    // AND IT WAS CANCELLED WHEN IT SAID IT WOULD BE, not merely at some point
    // before the sleep ended. A refusal at 2.9s would also be "not null".
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("a statement under the limit is NOT cancelled — the negative control", async () => {
    const client = open({ statementTimeoutMs: 2000 });
    await expect(client.$queryRawUnsafe("SELECT pg_sleep(0.2)::text AS slept")).resolves.toEqual([
      { slept: "" },
    ]);
  });

  test("a statement that waits for a row lock past lockTimeoutMs is cancelled with 55P03", async () => {
    const organizationId = await harness.seedOrganization(`t7-lock-${harness.freshId("0091")}`);
    const holder = open({ connectionLimit: 4, poolTimeoutSeconds: 10 });
    const waiter = open({ connectionLimit: 4, poolTimeoutSeconds: 10, lockTimeoutMs: 200 });

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = holder.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`;
      await held;
    });
    // The holder must be INSIDE its transaction before the waiter starts, or the
    // waiter would acquire freely and the case would prove nothing.
    await settle(200);

    const started = Date.now();
    const code = await refusal(
      waiter.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`;
      }),
    );
    const waited = Date.now() - started;
    release();
    await holding;

    expect(code).toBe("55P03");
    // It WAITED, and it stopped waiting when it was told to. A lock that refused
    // instantly would be a lock nobody ever queues behind.
    expect(waited).toBeGreaterThan(150);
    expect(waited).toBeLessThan(1500);
  });

  test("the same acquisition against an UNHELD row is not refused — the negative control", async () => {
    const organizationId = await harness.seedOrganization(`t7-free-${harness.freshId("0092")}`);
    const waiter = open({ lockTimeoutMs: 200 });
    await expect(
      waiter.$transaction(async (transaction) =>
        transaction.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`,
      ),
    ).resolves.toHaveLength(1);
  });

  test("a transaction left idle past idleInTransactionSessionTimeoutMs loses its session, and its write", async () => {
    const client = open({ idleInTransactionSessionTimeoutMs: 200 });
    const abandoned = harness.freshId("0093");
    const code = await refusal(
      client.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`
            INSERT INTO "Organization" (id, slug, name, "createdAt", "updatedAt")
            VALUES (${abandoned}::uuid, ${`t7-idle-${abandoned}`}, 'idle', now(), now())
          `;
          // NOT a slow statement — an idle GAP, which is the failure this setting
          // exists for and the one `statement_timeout` cannot see. A transaction
          // stuck here holds its connection, its snapshot and every row lock it
          // has taken for as long as the process lives.
          await settle(900);
          await transaction.$queryRawUnsafe("SELECT 3 AS three");
        },
        { timeout: 20_000 },
      ),
    );
    // `P1017`, NOT `25P03`, and the difference is worth stating rather than
    // hiding behind a looser assertion. PostgreSQL does not cancel the statement
    // here — it TERMINATES the backend, reporting 25P03 as a FATAL to a
    // connection that is then gone. What reaches the caller is a closed socket,
    // so the client's own "server has closed the connection" is the only code
    // there can be, and an operator cannot tell this apart from a network drop
    // by the code alone. The setting still does exactly what it is for: the
    // connection is reclaimed rather than held.
    expect(code).toBe("P1017");
    // AND THE WORK IS GONE, seen from a connection this client never touched —
    // which is the claim that actually matters. A terminated backend rolls its
    // open transaction back.
    const survivors = await harness.client.organization.findMany({
      where: { id: abandoned },
      select: { id: true },
    });
    expect(survivors).toEqual([]);
  });

  test("the same gap under a LONGER idle timeout commits — the negative control", async () => {
    const client = open({ idleInTransactionSessionTimeoutMs: 5000 });
    const kept = harness.freshId("0094");
    await client.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`
          INSERT INTO "Organization" (id, slug, name, "createdAt", "updatedAt")
          VALUES (${kept}::uuid, ${`t7-kept-${kept}`}, 'kept', now(), now())
        `;
        await settle(900);
        await transaction.$queryRawUnsafe("SELECT 3 AS three");
      },
      { timeout: 20_000 },
    );
    const survivors = await harness.client.organization.findMany({
      where: { id: kept },
      select: { id: true },
    });
    expect(survivors).toEqual([{ id: kept }]);
  });
});

describe("the pool is sized, and saturation is an error rather than a hang", () => {
  test("a second query on a one-connection pool is refused with P2024, at the timeout", async () => {
    const client = open({ connectionLimit: 1, poolTimeoutSeconds: 1 });
    const started = Date.now();
    // EACH ONE IS TIMED AS IT SETTLES, not the pair. `Promise.allSettled` does
    // not resolve until the 2.5-second holder does, so timing the pair would
    // measure the query that WON and say nothing about the one that waited — the
    // first draft of this case asserted exactly that and was measuring the wrong
    // promise.
    const settled = (work: Promise<unknown>): Promise<{ code: string; at: number }> =>
      work.then(
        () => ({ code: "ok", at: Date.now() - started }),
        (reason: { readonly code?: string }) => ({
          code: reason.code ?? "unclassified",
          at: Date.now() - started,
        }),
      );
    const outcomes = await Promise.all([
      settled(client.$queryRawUnsafe("SELECT pg_sleep(2.5)::text AS a")),
      settled(client.$queryRawUnsafe("SELECT pg_sleep(2.5)::text AS b")),
    ]);
    const refused = outcomes.filter((outcome) => outcome.code !== "ok");
    // ONE of them got the connection; the other waited its second and was told
    // so. `P2024` is the driver's own pool-timeout code and not a SQLSTATE,
    // because the server was never reached — which is the whole point of sizing
    // the pool rather than letting the database absorb the load.
    expect(outcomes.filter((outcome) => outcome.code === "ok")).toHaveLength(1);
    expect(refused.map((outcome) => outcome.code)).toEqual(["P2024"]);
    // It gave up at ITS timeout rather than queueing behind a 2.5-second sleep.
    const waited = refused[0]?.at ?? 0;
    expect(waited).toBeGreaterThan(900);
    expect(waited).toBeLessThan(2000);
  });

  test("the same two queries on a two-connection pool BOTH land — the negative control", async () => {
    const client = open({ connectionLimit: 2, poolTimeoutSeconds: 5 });
    const outcomes = await Promise.allSettled([
      client.$queryRawUnsafe("SELECT pg_sleep(0.4)::text AS a"),
      client.$queryRawUnsafe("SELECT pg_sleep(0.4)::text AS b"),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});
