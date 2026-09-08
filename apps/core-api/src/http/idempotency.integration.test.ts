// TWO IDENTICAL REQUESTS RACING, ONE EXECUTION — over a real socket, against a
// real Redis, through the process `main.ts` starts.
//
// This is the suite M0.4 §2's contract exists to be proved by, and nothing
// smaller would do it. Everything else about the gate is provable in memory:
// `decideIdempotency` is a rule, `classifyRequest` is a table lookup, and the
// `Map`-backed double in `idempotency.test.ts` honours reserve-once because it
// was written to. NONE of that is evidence of the property, because a
// single-threaded double cannot lose a race and a store that had quietly dropped
// its `NX` would satisfy every one of those cases.
//
// So every case here goes through `startCoreApi` — the same Nest application,
// the same middleware chain, the same body parser and the same socket `main.ts`
// binds — and the store behind it is the real `redis-cache` adapter over a real
// container. What is asserted is joined to things this dimension does not
// control: the status LINE off the wire, the status the COMMITTED taxonomy
// records for the code, and the keys Redis actually holds afterwards.
//
// THE HANDLER BEHIND *ONE* MINT PATH NOW EXISTS — WIN-267 T4 — AND THE REST
// STILL DO NOT. That sentence used to read "the handler behind the mint paths
// does not exist yet", and leaving it would have made this file's own banner the
// most confident false statement in the tree.
//
// `MINT` below is still `/api/v1/agent/access-key`, which belongs to WIN-261
// (M3.1) and is still unserved: the winner of a race there reaches the
// framework's own 404, so "exactly one execution" is measured as "exactly one
// caller got past the gate", which is precisely the property the GATE is
// responsible for.
//
// `SERVED_MINT` is the one T4 serves, and the cases over it measure something
// strictly stronger — that exactly one caller reached A HANDLER — because the
// answer now comes from `secret-mint.controller.ts` rather than from the
// framework. The instrument for that is `errorId`: `failure.ts` mints a fresh
// one on EVERY execution, so two responses carrying the SAME errorId is proof
// the handler ran once and the second answer was replayed bytes. It is not a
// number this suite controls, which is the only kind of evidence worth having
// here.
//
// WHAT IS *NOT* PROVED, SAID PLAINLY: no case below shows one ROW in the vault,
// because `identity-access` is unassembled in this build — four of its eight
// driven ports have no adapter — so the mint refuses at its first gate with
// `MINT_CONTEXT_UNCOMPOSED` before it ever reaches `secrets`. Exactly-once
// EXECUTION is proved end to end; exactly-one-ROW is not, and closing that gap
// needs those four adapters, not another case here.
//
// IT FAILS WHEN DOCKER IS ABSENT RATHER THAN SKIPPING. A skipped integration
// suite and a passing one look identical in a CI summary.

import { readFileSync } from "node:fs";

import { buildRedisCacheAdapter, createRedisConnection } from "@platos/adapter-redis-cache";
import type { RedisConnection } from "@platos/adapter-redis-cache";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SuppliedAdapters } from "../composition/adapter-bindings.js";
import { loadCoreApiConfiguration } from "../config/load.js";
import { createProcessLogger } from "../runtime/process-ports.js";
import { startCoreApi, type RunningCoreApi } from "../runtime/lifecycle.js";

const TAXONOMY = JSON.parse(
  readFileSync(new URL("../../../../docs/error-taxonomy.json", import.meta.url), "utf8"),
) as { readonly codes: Readonly<Record<string, { readonly status: number }>> };

/** The status the committed taxonomy records — never a literal written here. */
function committedStatus(code: string): number {
  const entry = TAXONOMY.codes[code];
  if (entry === undefined) throw new Error(`${code} is not in the committed taxonomy`);
  return entry.status;
}

const MINT = "/api/v1/agent/access-key";
const ORDINARY = "/api/v1/agent/agents";

/**
 * The one-time-secret mint WIN-267 T4 SERVES, and a request shape it refuses.
 *
 * The id is deliberately malformed. `secret-mint.controller.ts` refuses it with
 * `TRANSPORT_REQUEST_INVALID` — a 400, which `settlementFor` RECORDS — before it
 * touches a context, and that is what makes exactly-once EXECUTION observable
 * here: a recordable answer is one a replay can hand back, and the composed
 * build's other answer on this route (`MINT_CONTEXT_UNCOMPOSED`, 503) is
 * deliberately released rather than recorded, so it cannot be used to measure
 * a replay. Both facts are asserted below rather than assumed.
 */
const SERVED_MINT = "/api/v1/agent/channels/!!/rotate-secret";

/** The same served route with a WELL-FORMED id, which reaches past the route's
 * own validation and into the mint proper. */
const SERVED_MINT_VALID = "/api/v1/agent/channels/chan-1/rotate-secret";

/** The identifier `failure.ts` mints once per EXECUTION. Two responses sharing
 * one are two answers from a single run of the handler. */
function errorIdOf(response: WireResponse): string {
  const payload = JSON.parse(response.text) as { error?: { errorId?: string } };
  if (payload.error?.errorId === undefined) throw new Error(`no errorId in ${response.text}`);
  return payload.error.errorId;
}

let container: StartedRedisContainer;
let url: string;
/**
 * The connection the harness sweeps with, and the one the process is composed
 * over.
 *
 * ONE connection for both, and it is a deliberate choice rather than thrift:
 * every case here is about the SERVER deciding a race, and a suite that opened a
 * fresh socket per case would be asserting that a client can lose to itself. The
 * contenders inside a case are separate HTTP requests through one process, which
 * is exactly the shape production has — many requests, one pool.
 */
let driver: RedisConnection;
let running: RunningCoreApi | null = null;
let sequence = 0;

/** A fresh key per case, so no case can inherit another's reservation. */
function freshKey(): string {
  sequence += 1;
  return `k-${String(sequence).padStart(4, "0")}`;
}

interface WireResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

async function post(
  path: string,
  options: { key?: string | null; body?: string; credential?: string } = {},
): Promise<WireResponse> {
  const api = running;
  if (api === null) throw new Error("the process is not running");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${options.credential ?? "caller-alpha"}`,
  };
  if (options.key !== undefined && options.key !== null) headers["idempotency-key"] = options.key;
  const response = await fetch(`http://${api.host}:${api.port}${path}`, {
    method: "POST",
    headers,
    body: options.body ?? "{}",
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function codeOf(response: WireResponse): string {
  const payload = JSON.parse(response.text) as { error?: { code?: string } };
  if (payload.error?.code === undefined) throw new Error(`no error code in ${response.text}`);
  return payload.error.code;
}

/** How many reservations this suite's namespace is holding right now. */
async function reservationCount(): Promise<number> {
  let cursor = "0";
  let total = 0;
  do {
    const [next, keys] = await driver.scanPrefix(cursor, "platos:http:idem:*", 512);
    cursor = next;
    total += keys.length;
  } while (cursor !== "0");
  return total;
}

async function startProcess(withStore: boolean): Promise<void> {
  const outcome = loadCoreApiConfiguration({
    PLATOS_ENVIRONMENT: "test",
    PLATOS_CORE_API_PORT: "0",
    PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS: "2000",
  });
  if (!outcome.ok) throw new Error("harness configuration must be valid");
  const adapters: SuppliedAdapters | undefined = withStore
    ? { "redis-cache": buildRedisCacheAdapter(driver) }
    : undefined;
  running = await startCoreApi({
    configuration: outcome.value,
    adapters,
    logger: createProcessLogger({ minimumLevel: "error", write: () => undefined }),
  });
}

beforeAll(async () => {
  container = await new RedisContainer("redis:7-alpine").start();
  url = container.getConnectionUrl();
  driver = createRedisConnection({ url });
}, 180_000);

beforeEach(async () => {
  // Through `scanPrefix` and `remove` rather than `FLUSHDB`, because `FLUSHDB`
  // is deliberately not on `RedisConnection` — a harness that reached past the
  // interface to call it would be the first step towards a store doing the same.
  let cursor = "0";
  do {
    const [next, keys] = await driver.scanPrefix(cursor, "*", 512);
    cursor = next;
    await driver.remove(keys);
  } while (cursor !== "0");
  await startProcess(true);
});

afterEach(async () => {
  if (running !== null) await running.stop("test-teardown");
  running = null;
});

afterAll(async () => {
  await driver.close();
  await container.stop();
});

describe("the refusal M0.4 §2 names, on a real socket", () => {
  it("answers IDEMPOTENCY_KEY_REQUIRED when a one-time-secret mint arrives with no key", async () => {
    const response = await post(MINT);
    // The status is read out of the COMMITTED taxonomy, not written here, so a
    // mutation to the category table cannot move both sides of this assertion.
    expect(response.status).toBe(committedStatus("IDEMPOTENCY_KEY_REQUIRED"));
    expect(codeOf(response)).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("writes M0.4 §2's envelope, with the request id the edge decided on", async () => {
    const response = await post(MINT);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const payload = JSON.parse(response.text) as { error: Record<string, unknown> };
    expect(Object.keys(payload)).toEqual(["error"]);
    expect(payload.error.version).toBe("1");
    // `traceRef` is the id `runtime/correlation.ts` put on the response header —
    // the whole point of the envelope carrying one is that an operator can find
    // the request from the failure.
    expect(payload.error.traceRef).toBe(response.headers.get("x-request-id"));
    expect(String(payload.error.traceRef).length).toBeGreaterThan(0);
  });

  it("answers IDEMPOTENCY_KEY_MALFORMED for a key that is not a key", async () => {
    const response = await post(MINT, { key: "has spaces" });
    expect(response.status).toBe(committedStatus("IDEMPOTENCY_KEY_MALFORMED"));
    expect(codeOf(response)).toBe("IDEMPOTENCY_KEY_MALFORMED");
  });

  it("refuses BEFORE reserving, so a missing key leaves no record behind", async () => {
    await post(MINT);
    expect(await reservationCount()).toBe(0);
  });

  it("does not refuse an ordinary side-effecting route for a missing key", async () => {
    const response = await post(ORDINARY);
    // 404, because WIN-267 has not landed the handler. What matters is that it
    // is NOT the gate's 400: the contract requires a key on the mints and
    // accepts one everywhere else.
    expect(response.status).toBe(404);
    expect(await reservationCount()).toBe(0);
  });

  it("does not refuse a READ of a mint path", async () => {
    const api = running;
    if (api === null) throw new Error("the process is not running");
    const response = await fetch(`http://${api.host}:${api.port}${MINT}`);
    expect(response.status).toBe(404);
  });
});

/**
 * What happened to one contender.
 *
 * THE THREE ARE NOT TOLD APART BY STATUS, and that is the trap this helper
 * exists to avoid. A contender that got past the gate reaches the framework's
 * 404, and so does a contender that REPLAYED the winner's recorded 404 — the
 * whole point of a replay being byte-identical. Counting by status alone would
 * have called eight replays eight executions. The replay header and the failure
 * envelope are what separate them.
 */
function outcomeOf(response: WireResponse): "admitted" | "replayed" | "refused" {
  if (response.headers.get("idempotency-replayed") === "true") return "replayed";
  return response.status === 404 ? "admitted" : "refused";
}

interface Tally {
  admitted: number;
  replayed: number;
  refused: number;
}

function tally(responses: readonly WireResponse[]): Tally {
  const counts: Tally = { admitted: 0, replayed: 0, refused: 0 };
  for (const response of responses) counts[outcomeOf(response)] += 1;
  return counts;
}

describe("two identical requests racing", () => {
  it("lets exactly ONE past the gate and refuses the other", async () => {
    const key = freshKey();
    // SEPARATE fetches, issued together. The ordering is the server's — Redis
    // decides who wins the `NX`, not this process.
    const contenders = await Promise.all([post(MINT, { key }), post(MINT, { key })]);
    expect(tally(contenders).admitted).toBe(1);
    const loser = contenders.find((response) => outcomeOf(response) !== "admitted");
    if (loser === undefined) throw new Error("expected a second outcome");
    // The loser either found the twin still running or found its settled record.
    // Both are correct and which one happens is the server's timing; what must
    // never happen is a SECOND execution.
    if (outcomeOf(loser) === "refused") {
      expect(loser.status).toBe(committedStatus("IDEMPOTENCY_REQUEST_IN_FLIGHT"));
      expect(codeOf(loser)).toBe("IDEMPOTENCY_REQUEST_IN_FLIGHT");
    } else {
      expect(loser.status).toBe(404);
    }
    // ONE reservation in the keyspace, not two. Read back from the server.
    expect(await reservationCount()).toBe(1);
  });

  it("admits exactly one of EIGHT contenders and holds one reservation", async () => {
    const key = freshKey();
    const contenders = await Promise.all(
      Array.from({ length: 8 }, async () => await post(MINT, { key })),
    );
    const counts = tally(contenders);
    expect(counts.admitted).toBe(1);
    expect(counts.admitted + counts.replayed + counts.refused).toBe(8);
    expect(await reservationCount()).toBe(1);
  });

  it("admits exactly one contender per key when eight DIFFERENT keys race", async () => {
    // The control. If the gate were refusing everything after the first request
    // for some reason unrelated to the key, the case above would still pass and
    // this one would not.
    const contenders = await Promise.all(
      Array.from({ length: 8 }, async () => await post(MINT, { key: freshKey() })),
    );
    expect(tally(contenders)).toEqual({ admitted: 8, replayed: 0, refused: 0 });
    expect(await reservationCount()).toBe(8);
  });
});

describe("replay", () => {
  it("returns the first answer byte for byte, marked Idempotency-Replayed", async () => {
    const key = freshKey();
    const first = await post(MINT, { key });
    expect(first.headers.get("idempotency-replayed")).toBeNull();

    const second = await post(MINT, { key });
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.status).toBe(first.status);
    expect(second.text).toBe(first.text);
    expect(second.headers.get("content-type")).toBe(first.headers.get("content-type"));
  });

  it("still holds ONE reservation after the replay", async () => {
    const key = freshKey();
    await post(MINT, { key });
    await post(MINT, { key });
    expect(await reservationCount()).toBe(1);
  });

  it("refuses a DIFFERENT body under the same key rather than replaying", async () => {
    const key = freshKey();
    await post(MINT, { key, body: '{"a":1}' });
    const second = await post(MINT, { key, body: '{"a":2}' });
    expect(second.status).toBe(committedStatus("IDEMPOTENCY_REQUEST_MISMATCH"));
    expect(codeOf(second)).toBe("IDEMPOTENCY_REQUEST_MISMATCH");
    expect(second.headers.get("idempotency-replayed")).toBeNull();
  });

  it("never hands one caller's answer to a caller with a different credential", async () => {
    // THE SECURITY CASE. Two callers may choose the same `Idempotency-Key`;
    // nothing stops them. On these operations the recorded body IS a secret, so
    // the second caller must get its own reservation rather than the first
    // caller's response.
    const key = freshKey();
    const alpha = await post(MINT, { key, credential: "caller-alpha" });
    const beta = await post(MINT, { key, credential: "caller-beta" });
    expect(beta.headers.get("idempotency-replayed")).toBeNull();
    expect(beta.status).toBe(alpha.status);
    // TWO reservations, because the scope carries the credential.
    expect(await reservationCount()).toBe(2);
  });

  it("keeps two operations apart even when both carry one key", async () => {
    const key = freshKey();
    await post(MINT, { key });
    await post("/api/v1/agent/channels/c1/rotate-secret", { key });
    expect(await reservationCount()).toBe(2);
  });
});

describe("failing closed", () => {
  it("refuses a keyed request when no RequestIdempotency adapter is bound", async () => {
    if (running !== null) await running.stop("switch-to-unbound");
    running = null;
    await startProcess(false);
    const response = await post(MINT, { key: freshKey() });
    expect(response.status).toBe(committedStatus("IDEMPOTENCY_STORE_UNAVAILABLE"));
    expect(codeOf(response)).toBe("IDEMPOTENCY_STORE_UNAVAILABLE");
    expect(response.headers.get("retry-after")).toBe("1");
  });

  it("still refuses a keyless mint when no adapter is bound", async () => {
    // The header check is store-free, so an install with no Redis answers the
    // caller's actual defect rather than hiding it behind a 503.
    if (running !== null) await running.stop("switch-to-unbound");
    running = null;
    await startProcess(false);
    const response = await post(MINT);
    expect(codeOf(response)).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// WIN-267 T4. THE MINT THAT HAS A HANDLER.
//
// Everything above measures the GATE. These measure the gate AND the handler
// behind it, which is the thing T4 changed and the only thing that can tell a
// reserved key apart from a served operation.
// ---------------------------------------------------------------------------

/** What happened to one contender at the SERVED mint, where an admitted request
 * answers 400 rather than the framework's 404 and `outcomeOf` would misread it. */
function servedOutcome(response: WireResponse): "admitted" | "replayed" | "refused" {
  if (response.headers.get("idempotency-replayed") === "true") return "replayed";
  return codeOf(response) === "IDEMPOTENCY_REQUEST_IN_FLIGHT" ? "refused" : "admitted";
}

describe("the one-time-secret mint WIN-267 T4 serves", () => {
  it("routes the winner into the HANDLER, where before it reached the framework's 404", async () => {
    // THE CASE THAT SHOWS THIS TRANCHE DID SOMETHING. `MINT_CONTEXT_UNCOMPOSED`
    // is minted in exactly one place in the process — `mint-errors.ts` — so
    // reading it off the wire is proof the request reached
    // `secret-mint.controller.ts` and not `NotFoundController`.
    const served = await post(SERVED_MINT_VALID, { key: freshKey() });
    expect(codeOf(served)).toBe("MINT_CONTEXT_UNCOMPOSED");
    expect(served.status).toBe(committedStatus("MINT_CONTEXT_UNCOMPOSED"));
  });

  it("leaves the mints T4 did NOT take reaching the framework's 404, unchanged", async () => {
    // THE CONTROL, and it is the half that makes the case above mean something.
    // If this branch had accidentally mounted a catch-all business route, the
    // case above would pass for the wrong reason and this one would fail.
    // `/api/v1/agent/access-key` is WIN-261's (M3.1) and is still unserved.
    const unserved = await post(MINT, { key: freshKey() });
    expect(unserved.status).toBe(404);
    expect(codeOf(unserved)).toBe("TRANSPORT_ROUTE_NOT_FOUND");
  });

  it("executes the handler EXACTLY ONCE when two identical requests race", async () => {
    // The property the whole tranche is for, measured on a real socket against a
    // real Redis, with the ordering decided by the server's `NX` rather than by
    // this process.
    const key = freshKey();
    const contenders = await Promise.all([
      post(SERVED_MINT, { key }),
      post(SERVED_MINT, { key }),
    ]);
    const outcomes = contenders.map(servedOutcome);
    expect(outcomes.filter((outcome) => outcome === "admitted")).toHaveLength(1);
    // ONE reservation in the keyspace, read back from the server.
    expect(await reservationCount()).toBe(1);

    // AND THE PROOF THAT THE SECOND ANSWER WAS NOT A SECOND EXECUTION.
    // `failure.ts` mints a fresh `errorId` per execution, so a replay carrying
    // the winner's errorId is the handler having run once. A follow-up is used
    // rather than the racing loser because the loser may legitimately have been
    // refused in flight, which is a different — and equally correct — outcome.
    const winner = contenders[outcomes.indexOf("admitted")] as WireResponse;
    const followUp = await post(SERVED_MINT, { key });
    expect(followUp.headers.get("idempotency-replayed")).toBe("true");
    expect(followUp.text).toBe(winner.text);
    expect(errorIdOf(followUp)).toBe(errorIdOf(winner));
  });

  it("admits exactly one of EIGHT racing contenders and still holds ONE reservation", async () => {
    const key = freshKey();
    const contenders = await Promise.all(
      Array.from({ length: 8 }, async () => await post(SERVED_MINT, { key })),
    );
    const outcomes = contenders.map(servedOutcome);
    expect(outcomes.filter((outcome) => outcome === "admitted")).toHaveLength(1);
    expect(outcomes).toHaveLength(8);
    expect(await reservationCount()).toBe(1);
  });

  it("admits all EIGHT when the keys DIFFER, so the refusal is the key and not the route", async () => {
    // The control for the two cases above. Without it, a mint that refused
    // everything after its first request would satisfy both of them.
    const contenders = await Promise.all(
      Array.from({ length: 8 }, async () => await post(SERVED_MINT, { key: freshKey() })),
    );
    expect(contenders.map(servedOutcome)).toEqual(Array.from({ length: 8 }, () => "admitted"));
    expect(await reservationCount()).toBe(8);
  });

  it("does NOT poison the key when the handler answers 503, which the 404 used to do", async () => {
    // THE DEFECT T4 REMOVES, stated as a property rather than as prose.
    //
    // Before this tranche the winner reached `NotFoundController`, whose 404 is
    // below 500 and is therefore RECORDED — so every honest retry of that key
    // was answered with that 404 for the reservation's full 24 hours. The mint's
    // own `MINT_CONTEXT_UNCOMPOSED` is a 503, which `settlementFor` RELEASES, so
    // the caller may retry the same key and be served.
    const key = freshKey();
    const first = await post(SERVED_MINT_VALID, { key });
    expect(codeOf(first)).toBe("MINT_CONTEXT_UNCOMPOSED");
    // Released, not recorded: nothing is left holding the key.
    expect(await reservationCount()).toBe(0);

    const retry = await post(SERVED_MINT_VALID, { key });
    expect(retry.headers.get("idempotency-replayed")).toBeNull();
    expect(codeOf(retry)).toBe("MINT_CONTEXT_UNCOMPOSED");
    // A DIFFERENT errorId — the handler genuinely ran a second time, which is
    // the whole difference between a released reservation and a poisoned key.
    expect(errorIdOf(retry)).not.toBe(errorIdOf(first));
  });

  it("records the handler's 400 and releases its 503, joined to settlementFor's own rule", async () => {
    // The two settlements side by side, so the case above cannot be read as a
    // quirk of one path. Same route, same key discipline, different status
    // class, opposite outcome.
    const recorded = freshKey();
    await post(SERVED_MINT, { key: recorded });
    expect(await reservationCount()).toBe(1);

    const released = freshKey();
    await post(SERVED_MINT_VALID, { key: released });
    expect(await reservationCount()).toBe(1);
  });

  it("still refuses the served mint outright when it arrives with no key", async () => {
    // The policy binds the route T4 mounted, not merely a template in a table.
    const response = await post(SERVED_MINT_VALID);
    expect(response.status).toBe(committedStatus("IDEMPOTENCY_KEY_REQUIRED"));
    expect(codeOf(response)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(await reservationCount()).toBe(0);
  });
});
