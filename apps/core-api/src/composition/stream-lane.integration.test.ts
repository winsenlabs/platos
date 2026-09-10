// THE STREAM LANE, OVER A REAL SOCKET, AGAINST A REAL DATABASE AND A REAL REDIS.
//
// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS AND WHY NOTHING SMALLER WOULD DO
//
// WIN-272's acceptance is four claims and every one of them is about a
// CONNECTION, not about a function:
//
//   "no duplicate tool-result or trailing invalid frames" — a claim about what a
//   reader receives, in order, on one socket;
//   "event ordering and conservation is proven under reconnect" — a claim about
//   TWO sockets and a position carried between them;
//   "clients resume without missing or double-applying state" — the same, with the
//   client's own admission rule applied to what actually arrived;
//   "security and load tests cover slow consumers and oversized payloads" — one of
//   which is a socket state and the other a producer defect.
//
// `transports/ws/sse.test.ts` proves the mechanics against doubles, including the
// two branches a socket cannot reach in a test. This suite proves the LANE: the
// version prefix, the authentication seam, the four-gate authorization, the
// journal key that carries the tenancy boundary, the SSE bytes, the resume header
// and the credential fence — end to end, with nothing doubled. The journal is
// `redis-streams` over Redis 7; the store is `postgres-tenancy` over PostgreSQL
// 16; the hasher is `node-crypto-digest`; and the composition is `main.ts`'s,
// copied call for call, because a suite that wired its own would be proving that
// a bundle this file assembled works.
//
// ---------------------------------------------------------------------------
// WHY IT LIVES IN `composition/` AND NOT IN `transports/`
//
// The same reason `identity-rest.integration.test.ts` does, and it is a rule
// rather than a preference: this suite is the PRODUCER, so it appends frames
// through `construction.adapters["redis-streams"].journal`, and rule (C8) in
// `scripts/arch/composition-root.mjs` refuses any file under
// `apps/core-api/src/transports/**` that reads an `adapters` property at all.
// Seeding frames any other way — a second Redis client, or an HTTP route invented
// to accept them — would either break SDK containment or add product surface
// nobody asked for.
//
// THE PRODUCER IS THIS FILE AND IT STANDS IN FOR THE TURN ENGINE EXACTLY AS FAR AS
// THE PORT'S CONTRACT GOES AND NO FURTHER. `conversations` is on
// `UNIMPORTABLE_CONTEXT_FACTORIES`, so no turn can be run in this deployable; what
// is proven here is that frames appended through the port reach a browser in
// order, resumably, and stop for reasons a client can tell apart. Nothing here
// claims a turn ran.
//
// ---------------------------------------------------------------------------
// IT FAILS WHEN DOCKER IS ABSENT RATHER THAN SKIPPING. A skipped integration suite
// and a passing one look identical in a CI summary.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  admitFrame,
  asIdentifier,
  classifyStreamEnd,
  decodeStreamCursor,
  encodeStreamCursor,
  isOk,
  isResumable,
  STREAM_SCHEMA_VERSION,
  unwrap,
  type StreamCursor,
  type StreamFrame,
  type StreamJournal,
} from "@platos/kernel";

import { loadPlatformConfiguration } from "../config/platform.js";
import { API_VERSION_PREFIX } from "../http/api-surface.js";
import { createProcessDefaults, startCoreApi, type RunningCoreApi } from "../runtime/lifecycle.js";
import { journalStreamId } from "../transports/ws/streams.controller.js";
import { constructAdapters, type AdapterConstruction } from "./adapter-bindings.js";
import { assembleContextPorts } from "./context-ports.js";

const TAXONOMY = JSON.parse(
  readFileSync(new URL("../../../../docs/error-taxonomy.json", import.meta.url), "utf8"),
) as { readonly codes: Readonly<Record<string, { readonly status: number }>> };

/** The status the COMMITTED taxonomy records — never a literal written here. */
function committedStatus(code: string): number {
  const entry = TAXONOMY.codes[code];
  if (entry === undefined) throw new Error(`${code} is not in the committed taxonomy`);
  return entry.status;
}

const AT = new Date("2026-05-01T09:00:00.000Z");
const ORGANIZATION = "dddddddd-0001-4000-8000-000000000001";
const PROJECT = "dddddddd-0002-4000-8000-000000000002";
/** The environment the operator holds. */
const ENVIRONMENT = "dddddddd-0003-4000-8000-000000000003";
/** A SECOND environment in the same project, which the operator ALSO holds. */
const OTHER_ENVIRONMENT = "dddddddd-0007-4000-8000-000000000007";
const ADMIN = "dddddddd-0004-4000-8000-000000000004";
const OUTSIDER = "dddddddd-0005-4000-8000-000000000005";
const MEMBERSHIP = "dddddddd-0006-4000-8000-000000000006";

const ADMIN_TOKEN = "win272-admin-session-token";
const OUTSIDER_TOKEN = "win272-outsider-session-token";
const EXPIRED_TOKEN = "win272-expired-session-token";
const REVOKED_TOKEN = "win272-revoked-session-token";
/**
 * How long a short-window session lives.
 *
 * MINTED INSIDE THE CASE THAT USES IT, NOT IN `beforeAll`, and the first run on
 * real hardware is why. Seeding it with the rest of the fixture made its expiry a
 * race against every case in between: the trimmed-cursor case writes 10,010 frames
 * and takes 2.4 seconds, so by the time the fence case ran the window had closed
 * 599 milliseconds earlier and the case REFUSED TO RUN rather than passing
 * vacuously. The guard was right and the fixture was wrong.
 */
const SHORT_WINDOW_MS = 3_000;

let postgres: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;
let construction: AdapterConstruction;
let running: RunningCoreApi;
let journal: StreamJournal;
let base: string;
/** Held so a case can mint a session of its own. See `SHORT_WINDOW_MS`. */
let mintSession: (token: string, expiresAt: Date) => Promise<void>;
let shortSessions = 0;

function packageRootRelative(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

function frame(seq: number, overrides: Partial<StreamFrame> = {}): StreamFrame {
  return {
    sv: STREAM_SCHEMA_VERSION,
    family: "sse.turn",
    t: "assistant.delta",
    seq,
    ts: 1_760_000_000_000 + seq,
    fields: { text: `chunk-${seq}` },
    ...overrides,
  };
}

/** One SSE event as a reader sees it: the `event:` name, the `id:` line and the body. */
interface SseEvent {
  /** SSE's own event type. Null for the default one, which is where frames ride. */
  readonly name: string | null;
  readonly id: string | null;
  readonly frame: Record<string, unknown>;
}

interface StreamRead {
  readonly status: number;
  readonly contentType: string | null;
  readonly events: readonly SseEvent[];
  readonly comments: number;
  /** True when the server closed the body rather than the reader abandoning it. */
  readonly closedByServer: boolean;
  readonly body: string;
}

/**
 * Open a stream and read it.
 *
 * A HAND-ROLLED SSE READER RATHER THAN A LIBRARY, and the reason is the point of
 * the suite: `EventSource` hides the `id:` line, swallows comments, and reconnects
 * on its own. Every one of those is a thing this suite has to observe. The parser
 * below is the SSE framing and nothing more.
 */
async function readStream(
  path: string,
  options: {
    readonly token?: string;
    readonly resumeFrom?: string;
    /** Stop reading once this many events have arrived. Models a client going away. */
    readonly stopAfter?: number;
    /** Stop reading after this long, whatever arrived. */
    readonly budgetMs?: number;
  } = {},
): Promise<StreamRead> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.resumeFrom !== undefined) headers["last-event-id"] = options.resumeFrom;
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), options.budgetMs ?? 20_000);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { headers, signal: controller.signal });
  } catch (error) {
    clearTimeout(budget);
    throw error;
  }
  const contentType = response.headers.get("content-type");
  if (response.body === null) {
    clearTimeout(budget);
    const body = await response.text();
    return { status: response.status, contentType, events: [], comments: 0, closedByServer: true, body };
  }
  const events: SseEvent[] = [];
  let comments = 0;
  let buffered = "";
  let body = "";
  let closedByServer = true;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      body += text;
      buffered += text;
      let boundary = buffered.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (block.startsWith(":")) {
          comments += 1;
        } else {
          const lines = block.split("\n");
          const name = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? null;
          const id = lines.find((line) => line.startsWith("id: "))?.slice("id: ".length) ?? null;
          const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);
          if (data !== undefined) {
            events.push({ name, id, frame: JSON.parse(data) as Record<string, unknown> });
          }
        }
        boundary = buffered.indexOf("\n\n");
      }
      // COUNTS FRAMES AND NOT EVENTS. The leading `stream_meta` rides on SSE's own
      // `event:` channel and is not a member of the sequence, so a reader that
      // counted it would stop one frame early on every case in this file.
      const frames = events.filter((event) => event.name === null).length;
      if (options.stopAfter !== undefined && frames >= options.stopAfter) {
        closedByServer = false;
        // THE CLIENT GOING AWAY MID-STREAM, for real: the socket is cancelled with
        // the server still holding an open response.
        await reader.cancel();
        controller.abort();
        break;
      }
    }
  } catch {
    // An abort mid-read is a disconnect, which is one of the cases.
    closedByServer = false;
  } finally {
    clearTimeout(budget);
  }
  const status = response.status;
  if (status !== 200) {
    return { status, contentType, events: [], comments, closedByServer, body };
  }
  return { status, contentType, events, comments, closedByServer, body };
}

/** A refusal read as JSON. The lane answers these BEFORE the first stream byte. */
async function refusal(
  path: string,
  options: { readonly token?: string; readonly resumeFrom?: string } = {},
): Promise<{ readonly status: number; readonly code: string }> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.resumeFrom !== undefined) headers["last-event-id"] = options.resumeFrom;
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  let code = `(no error: ${text.slice(0, 160)})`;
  try {
    const body = JSON.parse(text) as { readonly error?: { readonly code?: string } };
    if (typeof body.error?.code === "string") code = body.error.code;
  } catch {
    /* left as the raw prefix, which is what a non-JSON answer should report */
  }
  return { status: response.status, code };
}

/** The frames only — the leading `stream_meta` is not one. */
function framesOf(read: StreamRead): readonly SseEvent[] {
  return framesOf(read).filter((event) => event.name === null);
}

/** The leading `stream_meta`, or null when the lane did not send one. */
function metaOf(read: StreamRead): Record<string, unknown> | null {
  return read.events.find((event) => event.name === "stream_meta")?.frame ?? null;
}

function streamPath(environmentId: string, streamId: string): string {
  return `${API_VERSION_PREFIX}/environments/${environmentId}/streams/${streamId}`;
}

function cursor(environmentId: string, streamId: string, seq: number): StreamCursor {
  return unwrap(encodeStreamCursor(journalStreamId(environmentId, streamId), seq));
}

/** Append frames as the turn engine would. The producer half is the PORT. */
async function produce(
  environmentId: string,
  streamId: string,
  frames: readonly StreamFrame[],
): Promise<void> {
  const outcome = await journal.append(journalStreamId(environmentId, streamId), frames);
  if (outcome.kind !== "appended") throw new Error(`append refused: ${JSON.stringify(outcome)}`);
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  redis = await new RedisContainer("redis:7-alpine").start();
  const databaseUrl = postgres.getConnectionUri();

  const databasePackage = packageRootRelative("../../internal-packages/tenancy-database");
  execFileSync(
    packageRootRelative("../../node_modules/.bin/prisma"),
    ["migrate", "deploy", "--schema", resolve(databasePackage, "prisma/schema.prisma")],
    { cwd: databasePackage, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );

  const platform = loadPlatformConfiguration({
    PLATOS_ENVIRONMENT: "test",
    PLATOS_CORE_API_PORT: "0",
    PLATOS_STORE_POSTGRES_URL: databaseUrl,
    PLATOS_STORE_REDIS_URL: redis.getConnectionUrl(),
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_SECURITY_ENCRYPTION_KEY: "d".repeat(64),
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "4",
  });
  if (!platform.ok) throw new Error(`platform configuration refused: ${JSON.stringify(platform.diagnostics)}`);
  const defaults = createProcessDefaults(platform.value.core);
  construction = constructAdapters({
    stores: platform.value.stores,
    security: platform.value.security,
    providers: platform.value.providers,
    channels: platform.value.channels,
    clock: defaults.clock,
    correlation: null,
  });
  if (construction.faults.length > 0) throw new Error(construction.faults.join("; "));
  const assembly = assembleContextPorts(construction.adapters, defaults);

  const store = construction.adapters["postgres-tenancy"];
  if (store === undefined) throw new Error("postgres-tenancy must be constructed");
  const hasher = construction.adapters["node-crypto-digest"];
  if (hasher === undefined) throw new Error("node-crypto-digest must be constructed");
  const streams = construction.adapters["redis-streams"];
  if (streams === undefined) throw new Error("redis-streams must be constructed");
  journal = streams.journal;

  await store.unitOfWork.run(async (transaction) => {
    await store.saveOrganization(
      { id: asIdentifier(ORGANIZATION), slug: asIdentifier("win272"), name: "WIN-272", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    await store.saveProject(
      { id: asIdentifier(PROJECT), organizationId: asIdentifier(ORGANIZATION), slug: asIdentifier("m46-project"), name: "M4.6 project", archivedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
    for (const [id, slug, name] of [
      [ENVIRONMENT, "prod", "Production"],
      [OTHER_ENVIRONMENT, "staging", "Staging"],
    ] as const) {
      await store.saveEnvironment(
        { id: asIdentifier(id), projectId: asIdentifier(PROJECT), slug: asIdentifier(slug), name, archivedAt: null, accessKeyRevocationVersion: 0, memoryFeedbackBackfillCursor: null, memoryFeedbackBackfillCompletedAt: null, createdAt: AT, updatedAt: AT } as never,
        transaction,
      );
    }
  });
  await store.users.upsertByEmail(asIdentifier("m46-admin@example.test"), asIdentifier(ADMIN));
  await store.users.upsertByEmail(asIdentifier("m46-outsider@example.test"), asIdentifier(OUTSIDER));
  await store.unitOfWork.run(async (transaction) => {
    await store.saveOrganizationMembership(
      { id: asIdentifier(MEMBERSHIP), organizationId: asIdentifier(ORGANIZATION), userId: asIdentifier(ADMIN), role: "OWNER", deactivatedAt: null, createdAt: AT, updatedAt: AT } as never,
      transaction,
    );
  });

  const session = (id: string, token: string, extra: Record<string, unknown>): never =>
    ({
      sessionId: asIdentifier(id),
      tokenHash: hasher.hash(token),
      tier: "OPERATOR",
      userId: asIdentifier(ADMIN),
      impersonatedUserId: null,
      parentSessionId: null,
      mfaVerifiedAt: null,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      revokedAt: null,
      lastSeenAt: null,
      createdAt: AT,
      ...extra,
    }) as never;

  await store.operatorSessions.save(session("dddddddd-1001-4000-8000-000000000001", ADMIN_TOKEN, {}));
  await store.operatorSessions.save(
    session("dddddddd-1002-4000-8000-000000000002", OUTSIDER_TOKEN, { userId: asIdentifier(OUTSIDER) }),
  );
  await store.operatorSessions.save(
    session("dddddddd-1003-4000-8000-000000000003", EXPIRED_TOKEN, { expiresAt: new Date("2026-05-02T00:00:00.000Z") }),
  );
  await store.operatorSessions.save(
    session("dddddddd-1004-4000-8000-000000000004", REVOKED_TOKEN, { revokedAt: AT }),
  );
  // THE SHORT-WINDOW SESSION IS NOT SEEDED HERE. See `SHORT_WINDOW_MS`: its expiry
  // has to be measured from the instant its own case starts, or every case that
  // runs in between is a race against it. What is seeded is the ABILITY to mint
  // one, so the case that needs it can.
  mintSession = async (token: string, expiresAt: Date): Promise<void> => {
    shortSessions += 1;
    await store.operatorSessions.save(
      session(`dddddddd-2${String(shortSessions).padStart(3, "0")}-4000-8000-000000000005`, token, {
        expiresAt,
      }),
    );
  };

  running = await startCoreApi({
    configuration: platform.value.core,
    adapters: construction.adapters,
    ports: assembly.ports,
    unwired: construction.unwired,
    clock: defaults.clock,
    ids: defaults.ids,
    logger: defaults.logger,
  });
  base = `http://${running.host}:${String(running.port)}`;
}, 300_000);

afterAll(async () => {
  await running?.stop("test");
  await construction?.release();
  await redis?.stop();
  await postgres?.stop();
});

describe("the lane is not vacuous", () => {
  it("has a COMPOSED journal, a composed identity surface, and a mounted route", async () => {
    // Every case below would be meaningless against an absent journal: the route
    // would answer 503 and the refusal cases would still look like refusals.
    expect(running.app.streamJournal).not.toBeNull();
    expect(running.app.eventBus).not.toBeNull();
    expect(running.app.contexts.identityAccess).toBeDefined();
    expect(running.app.contexts.tenancy).toBeDefined();
    // AND THE ROUTE IS MOUNTED RATHER THAN SWALLOWED by the terminal 404. An
    // unmounted stream route would answer `TRANSPORT_ROUTE_NOT_FOUND`, which is a
    // different code from every refusal this lane owns.
    const answer = await refusal(streamPath(ENVIRONMENT, "no-such-stream"), { token: ADMIN_TOKEN });
    expect(answer.code).not.toBe("TRANSPORT_ROUTE_NOT_FOUND");
  });
});

describe("the refusals BEFORE the first byte are the security boundary", () => {
  it("refuses an unauthenticated read with the context's own code, not a stream one", async () => {
    // THE UNAUTHENTICATED LANE'S REFUSAL, against a real process. It is
    // `identity-access`'s code and not a stream code: a lane that minted its own
    // would give an operator two different answers for one condition.
    const answer = await refusal(streamPath(ENVIRONMENT, "any"));
    expect(answer.code).toBe("UNAUTHENTICATED");
    expect(answer.status).toBe(committedStatus("UNAUTHENTICATED"));
  });

  it("tells an expired session from a revoked one", async () => {
    const expired = await refusal(streamPath(ENVIRONMENT, "any"), { token: EXPIRED_TOKEN });
    const revoked = await refusal(streamPath(ENVIRONMENT, "any"), { token: REVOKED_TOKEN });
    expect(expired.code).toBe("SESSION_EXPIRED");
    expect(revoked.code).toBe("SESSION_REVOKED");
    expect(expired.status).toBe(committedStatus("SESSION_EXPIRED"));
    expect(revoked.status).toBe(committedStatus("SESSION_REVOKED"));
  });

  it("refuses an operator with no membership at the AUTHORIZATION rather than with an empty stream", async () => {
    await produce(ENVIRONMENT, "outsider-probe", [frame(1)]);
    const answer = await refusal(streamPath(ENVIRONMENT, "outsider-probe"), { token: OUTSIDER_TOKEN });
    expect(answer.code).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(answer.status).toBe(committedStatus("TENANCY_ENVIRONMENT_FORBIDDEN"));
  });

  it("answers 404 for a stream nobody wrote", async () => {
    const answer = await refusal(streamPath(ENVIRONMENT, "never-written"), { token: ADMIN_TOKEN });
    expect(answer.code).toBe("STREAM_NOT_FOUND");
    expect(answer.status).toBe(committedStatus("STREAM_NOT_FOUND"));
  });

  it("REFUSES A FORGED SCOPE: the key is the authorization's, never the path's", async () => {
    // THE CASE THAT SEPARATES A TENANCY TEST FROM A TWO-TENANT TEST. The operator
    // holds BOTH environments, so authorization passes either way; what must not
    // happen is that naming one environment reaches a stream created under the
    // other. If the key were built from the path segment this would still pass; it
    // is built from `authorization.scope`, so the two keys differ and the frames
    // are unreachable.
    await produce(OTHER_ENVIRONMENT, "cross-tenant", [frame(1, { fields: { text: "secret" } })]);
    const forged = await refusal(streamPath(ENVIRONMENT, "cross-tenant"), { token: ADMIN_TOKEN });
    expect(forged.code).toBe("STREAM_NOT_FOUND");
    // AND IT IS REACHABLE UNDER ITS OWN ENVIRONMENT, so the 404 above is the KEY
    // and not a stream that failed to be written.
    const own = await readStream(streamPath(OTHER_ENVIRONMENT, "cross-tenant"), {
      token: ADMIN_TOKEN,
      budgetMs: 8_000,
      stopAfter: 1,
    });
    expect(framesOf(own).map((event) => event.frame["text"])).toEqual(["secret"]);
  });

  it("refuses a resume position it cannot read, and one that belongs to another stream", async () => {
    await produce(ENVIRONMENT, "cursor-checks", [frame(1)]);
    const unreadable = await refusal(streamPath(ENVIRONMENT, "cursor-checks"), {
      token: ADMIN_TOKEN,
      resumeFrom: "not-a-cursor",
    });
    expect(unreadable.code).toBe("STREAM_CURSOR_UNREADABLE");
    expect(unreadable.status).toBe(committedStatus("STREAM_CURSOR_UNREADABLE"));
    // A WELL-FORMED CURSOR FOR A DIFFERENT STREAM IS THE SAME REFUSAL, and it must
    // NOT be a 404: the stream asked for exists, and answering "not found" would
    // send an operator looking for a missing stream when the client sent the wrong
    // position.
    const foreign = await refusal(streamPath(ENVIRONMENT, "cursor-checks"), {
      token: ADMIN_TOKEN,
      resumeFrom: cursor(ENVIRONMENT, "some-other-stream", 1),
    });
    expect(foreign.code).toBe("STREAM_CURSOR_UNREADABLE");
  });
});

describe("frames reach a browser in order", () => {
  it("serves the event-stream media type and one event per frame", async () => {
    await produce(ENVIRONMENT, "ordered", [frame(1), frame(2), frame(3)]);
    const read = await readStream(streamPath(ENVIRONMENT, "ordered"), {
      token: ADMIN_TOKEN,
      stopAfter: 3,
      budgetMs: 10_000,
    });
    expect(read.status).toBe(200);
    expect(read.contentType).toBe("text/event-stream; charset=utf-8");
    expect(framesOf(read).map((event) => event.frame["seq"])).toEqual([1, 2, 3]);
    expect(framesOf(read).map((event) => event.frame["text"])).toEqual(["chunk-1", "chunk-2", "chunk-3"]);
    // EVERY FRAME CARRIES `sv`, which is the whole of M0.4 §1.2 on the wire.
    for (const event of framesOf(read)) expect(event.frame["sv"]).toBe(STREAM_SCHEMA_VERSION);
  });

  it("sends the LEADING `stream_meta` FIRST, on SSE's own event channel", async () => {
    // M0.4 §2's SSE row asks for it. Over a real socket the assertion that matters
    // is the ORDER: a client that received frames before it was told the `sv` and
    // the position it is resuming from would have to infer both.
    await produce(ENVIRONMENT, "meta-first", [frame(1), frame(2)]);
    const read = await readStream(streamPath(ENVIRONMENT, "meta-first"), {
      token: ADMIN_TOKEN,
      resumeFrom: cursor(ENVIRONMENT, "meta-first", 1),
      stopAfter: 1,
      budgetMs: 10_000,
    });
    expect(read.events[0]?.name).toBe("stream_meta");
    expect(read.events[0]?.frame).toEqual({
      sv: STREAM_SCHEMA_VERSION,
      replayFrom: cursor(ENVIRONMENT, "meta-first", 1),
    });
    // AND IT IS NOT A MEMBER OF THE SEQUENCE: it carries no `id:`, so a reconnect
    // still resumes from the last real frame, and it has no `seq` for a client's
    // `admitFrame` to trip over.
    expect(read.events[0]?.id).toBeNull();
    expect(read.events[0]?.frame["seq"]).toBeUndefined();
    expect(framesOf(read).map((event) => event.frame["seq"])).toEqual([2]);
    expect(metaOf(read)).not.toBeNull();
  });

  it("says `replayFrom: null` when the reader asked for the whole stream", async () => {
    await produce(ENVIRONMENT, "meta-null", [frame(1)]);
    const read = await readStream(streamPath(ENVIRONMENT, "meta-null"), {
      token: ADMIN_TOKEN,
      stopAfter: 1,
      budgetMs: 10_000,
    });
    expect(metaOf(read)).toEqual({ sv: STREAM_SCHEMA_VERSION, replayFrom: null });
  });

  it("writes an `id:` that DECODES to this stream and this position", async () => {
    await produce(ENVIRONMENT, "ids", [frame(1), frame(2)]);
    const read = await readStream(streamPath(ENVIRONMENT, "ids"), {
      token: ADMIN_TOKEN,
      stopAfter: 2,
      budgetMs: 10_000,
    });
    const positions = framesOf(read).map((event) => {
      const decoded = decodeStreamCursor(event.id ?? "");
      return isOk(decoded) ? decoded.value : null;
    });
    expect(positions).toEqual([
      { streamId: journalStreamId(ENVIRONMENT, "ids"), seq: 1 },
      { streamId: journalStreamId(ENVIRONMENT, "ids"), seq: 2 },
    ]);
  });

  it("delivers frames written WHILE the reader is attached, not only history", async () => {
    await produce(ENVIRONMENT, "live", [frame(1)]);
    const reading = readStream(streamPath(ENVIRONMENT, "live"), {
      token: ADMIN_TOKEN,
      stopAfter: 3,
      budgetMs: 15_000,
    });
    await new Promise((settle) => setTimeout(settle, 300));
    await produce(ENVIRONMENT, "live", [frame(2), frame(3)]);
    const read = await reading;
    expect(framesOf(read).map((event) => event.frame["seq"])).toEqual([1, 2, 3]);
  });

  it("ends on the producer's own terminal frame and writes NO SECOND ONE", async () => {
    // "No duplicate or trailing invalid frames", which is the acceptance's own
    // wording and the exact defect in the live lane: `streaming.service.ts` writes
    // an `error` frame AND a `done` frame on its failure path.
    await produce(ENVIRONMENT, "sealed", [frame(1), frame(2, { t: "turn.done", fields: {} })]);
    const sealOutcome = await journal.seal(journalStreamId(ENVIRONMENT, "sealed"), "turn.done", Date.now());
    expect(sealOutcome.kind).toBe("sealed");
    const read = await readStream(streamPath(ENVIRONMENT, "sealed"), { token: ADMIN_TOKEN, budgetMs: 15_000 });
    // The SERVER closed the body — the reader did not stop early.
    expect(read.closedByServer).toBe(true);
    expect(framesOf(read).map((event) => event.frame["t"])).toEqual(["assistant.delta", "turn.done"]);
    const terminal = framesOf(read).filter((event) =>
      ["turn.done", "stream.error", "stream.offline"].includes(String(event.frame["t"])),
    );
    expect(terminal.length).toBe(1);
    // AND THE CLIENT'S OWN CLASSIFICATION SAYS `completed`, so it does not reconnect.
    const last = framesOf(read)[framesOf(read).length - 1];
    const end = classifyStreamEnd(
      { sv: 1, family: "sse.turn", t: String(last?.frame["t"]), seq: 2, ts: 0, fields: {} },
      null,
    );
    expect(end).toEqual({ kind: "completed" });
    expect(isResumable(end)).toBe(false);
  });
});

describe("resume across a reconnect conserves every frame", () => {
  it("delivers a 60-frame run exactly once across a mid-run disconnect", async () => {
    // THE ACCEPTANCE'S CENTRAL CLAIM, end to end: "clients resume without missing
    // or double-applying state". The reader's applied set is computed with the
    // kernel's own `admitFrame`, so a duplicate or a gap is not merely visible —
    // it is the client's own verdict on what arrived.
    const total = 60;
    await produce(
      ENVIRONMENT,
      "conserved",
      Array.from({ length: total }, (_, index) => frame(index + 1)),
    );

    const applied: number[] = [];
    let lastApplied = 0;
    let gaps = 0;
    let duplicates = 0;
    let position: string | undefined;
    for (let attach = 0; attach < 8 && applied.length < total; attach += 1) {
      const read = await readStream(streamPath(ENVIRONMENT, "conserved"), {
        token: ADMIN_TOKEN,
        ...(position === undefined ? {} : { resumeFrom: position }),
        // A SHORT LEASE PER ATTACHMENT, so the run really is split across sockets.
        stopAfter: 11,
        budgetMs: 15_000,
      });
      if (framesOf(read).length === 0) break;
      for (const event of framesOf(read)) {
        const seq = Number(event.frame["seq"]);
        const admission = admitFrame(lastApplied, {
          sv: 1,
          family: "sse.turn",
          t: String(event.frame["t"]),
          seq,
          ts: 0,
          fields: {},
        });
        if (admission.kind === "apply") {
          applied.push(seq);
          lastApplied = seq;
          position = event.id ?? position;
        } else if (admission.kind === "gap") {
          gaps += 1;
        } else {
          duplicates += 1;
        }
      }
    }
    expect(gaps).toBe(0);
    expect(duplicates).toBe(0);
    expect(applied).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(new Set(applied).size).toBe(total);
  }, 120_000);

  it("resumes STRICTLY after the presented position, so nothing arrives twice", async () => {
    await produce(ENVIRONMENT, "strict", [frame(1), frame(2), frame(3), frame(4)]);
    const resumed = await readStream(streamPath(ENVIRONMENT, "strict"), {
      token: ADMIN_TOKEN,
      resumeFrom: cursor(ENVIRONMENT, "strict", 2),
      stopAfter: 2,
      budgetMs: 10_000,
    });
    expect(framesOf(resumed).map((event) => event.frame["seq"])).toEqual([3, 4]);
  });

  it("REFUSES a resume position whose frames have been trimmed away", async () => {
    // The conservation refusal, on the wire. A page from the oldest retained frame
    // would look continuous to this client and be silently missing the middle.
    const tight = "trimmed";
    await produce(ENVIRONMENT, tight, [frame(1), frame(2), frame(3)]);
    // The journal's default retention is 10,000 frames, so reaching the bound
    // honestly means writing past it: 10,010 frames leaves 1..10 unreachable.
    const bulk = Array.from({ length: 10_010 }, (_, index) => frame(index + 4));
    for (let start = 0; start < bulk.length; start += 1_000) {
      await produce(ENVIRONMENT, tight, bulk.slice(start, start + 1_000));
    }
    const answer = await refusal(streamPath(ENVIRONMENT, tight), {
      token: ADMIN_TOKEN,
      resumeFrom: cursor(ENVIRONMENT, tight, 2),
    });
    expect(answer.code).toBe("STREAM_CURSOR_EXPIRED");
    expect(answer.status).toBe(committedStatus("STREAM_CURSOR_EXPIRED"));
    // AND A POSITION INSIDE THE RETAINED WINDOW STILL WORKS, so the refusal above
    // is retention and not a broken cursor.
    const inside = await readStream(streamPath(ENVIRONMENT, tight), {
      token: ADMIN_TOKEN,
      resumeFrom: cursor(ENVIRONMENT, tight, 10_012),
      stopAfter: 1,
      budgetMs: 15_000,
    });
    expect(framesOf(inside).map((event) => event.frame["seq"])).toEqual([10_013]);
  }, 180_000);
});

describe("a client that goes away mid-stream", () => {
  it("leaves the stream UNSEALED and resumable, and the process serving", async () => {
    await produce(ENVIRONMENT, "abandoned", [frame(1), frame(2), frame(3), frame(4)]);
    const abandoned = await readStream(streamPath(ENVIRONMENT, "abandoned"), {
      token: ADMIN_TOKEN,
      stopAfter: 2,
      budgetMs: 10_000,
    });
    expect(abandoned.closedByServer).toBe(false);
    expect(framesOf(abandoned).length).toBeGreaterThanOrEqual(2);

    // THE STREAM IS NOT SEALED. A lane that ended the stream because a READER left
    // would have converted one browser closing a tab into every other reader
    // believing the turn finished.
    const state = await journal.read(journalStreamId(ENVIRONMENT, "abandoned"), null, {
      limit: 1,
      blockMs: 0,
    });
    expect(state.kind).toBe("page");
    expect(state.kind === "page" && state.seal).toBeNull();

    // AND A SECOND READER PICKS UP WHERE THE FIRST STOPPED, on a new socket.
    const resumed = await readStream(streamPath(ENVIRONMENT, "abandoned"), {
      token: ADMIN_TOKEN,
      resumeFrom: framesOf(abandoned)[1]?.id ?? cursor(ENVIRONMENT, "abandoned", 2),
      stopAfter: 2,
      budgetMs: 10_000,
    });
    expect(framesOf(resumed).map((event) => event.frame["seq"])).toEqual([3, 4]);

    // AND THE PROCESS IS STILL SERVING. A pump that leaked on disconnect would
    // hold a reader forever and the next request would eventually stall.
    const alive = await fetch(`${base}/livez`);
    expect(alive.status).toBe(200);
  }, 60_000);
});

describe("the credential expiry fence", () => {
  it("CLOSES A STREAM WHOSE CREDENTIAL EXPIRES WHILE IT IS OPEN, with its own code", async () => {
    // THE DEFECT THIS LANE WAS BUILT AGAINST, proven with a REAL session whose
    // window closes while the socket is open. `agentChatStream` in `apps/agent`
    // authenticates once and then streams unbounded; this one does not.
    await produce(ENVIRONMENT, "fenced", [frame(1)]);
    // MINTED NOW, so the window is measured from this instant and no earlier case
    // can spend it.
    const token = "win272-short-window-session-token";
    const shortWindowEndsAt = Date.now() + SHORT_WINDOW_MS;
    await mintSession(token, new Date(shortWindowEndsAt));
    const remaining = shortWindowEndsAt - Date.now();
    expect(remaining, "the short session's window closed before this case ran").toBeGreaterThan(200);

    const started = Date.now();
    const read = await readStream(streamPath(ENVIRONMENT, "fenced"), {
      token,
      // No `stopAfter`: the SERVER must be the party that ends this.
      budgetMs: 30_000,
    });
    const elapsed = Date.now() - started;

    expect(read.status).toBe(200);
    expect(read.closedByServer).toBe(true);
    // IT CLOSED AT THE WINDOW AND NOT BEFORE IT.
    expect(Date.now()).toBeGreaterThanOrEqual(shortWindowEndsAt);
    // AND NOT LONG AFTER IT EITHER: the fence is the credential's expiry, not a
    // timeout that happens to fire. One heartbeat interval of slack.
    expect(elapsed).toBeLessThan(remaining + 20_000);

    const last = framesOf(read)[framesOf(read).length - 1];
    expect(last?.frame["t"]).toBe("stream.error");
    expect(last?.frame["code"]).toBe("STREAM_CREDENTIAL_EXPIRED");
    // THE TERMINAL FRAME CARRIES NO `id:`, so the client's `Last-Event-ID` still
    // names the last frame the JOURNAL holds.
    expect(last?.id).toBeNull();
    // AND ITS SEQUENCE IS ABOVE THE LAST CONTENT FRAME'S, so a correct client
    // APPLIES it rather than dropping it as a duplicate.
    const content = framesOf(read).filter((event) => event.frame["t"] === "assistant.delta");
    expect(Number(last?.frame["seq"])).toBe(Number(content[content.length - 1]?.frame["seq"]) + 1);
    // THE CLIENT'S OWN CLASSIFICATION IS `failed`, WHICH IS NOT RESUMABLE, so it
    // gets a new credential rather than reconnecting with the old one.
    const end = classifyStreamEnd(
      { sv: 1, family: "sse.turn", t: "stream.error", seq: 2, ts: 0, fields: { code: String(last?.frame["code"]) } },
      null,
    );
    expect(end).toEqual({ kind: "failed", code: "STREAM_CREDENTIAL_EXPIRED" });
    expect(isResumable(end)).toBe(false);

    // AND THE STREAM ITSELF IS UNTOUCHED: a fence that sealed the stream would let
    // one reader's expired token end a turn for everybody.
    const state = await journal.read(journalStreamId(ENVIRONMENT, "fenced"), null, { limit: 1, blockMs: 0 });
    expect(state.kind === "page" && state.seal).toBeNull();

    // AND THE SAME CREDENTIAL, NOW SPENT, IS REFUSED BEFORE THE FIRST BYTE — a
    // JSON envelope and not a frame, because no 200 has gone out yet. That is the
    // whole reason admission happens before `openEventStream`, and asserting it
    // HERE rather than in a case of its own is what keeps the two halves bound to
    // ONE credential: a separate case would have needed its own session and would
    // then be proving something about a different token.
    const spent = await refusal(streamPath(ENVIRONMENT, "fenced"), { token });
    expect(spent.code).toBe("SESSION_EXPIRED");
    expect(spent.status).toBe(committedStatus("SESSION_EXPIRED"));
  }, 120_000);
});

describe("two readers on one stream", () => {
  it("gives both the identical ordering, over two sockets", async () => {
    await produce(
      ENVIRONMENT,
      "two-readers",
      Array.from({ length: 25 }, (_, index) => frame(index + 1)),
    );
    const [first, second] = await Promise.all([
      readStream(streamPath(ENVIRONMENT, "two-readers"), { token: ADMIN_TOKEN, stopAfter: 25, budgetMs: 15_000 }),
      readStream(streamPath(ENVIRONMENT, "two-readers"), { token: ADMIN_TOKEN, stopAfter: 25, budgetMs: 15_000 }),
    ]);
    const expected = Array.from({ length: 25 }, (_, index) => index + 1);
    expect(framesOf(first).map((event) => event.frame["seq"])).toEqual(expected);
    expect(framesOf(second).map((event) => event.frame["seq"])).toEqual(expected);
  }, 60_000);
});
