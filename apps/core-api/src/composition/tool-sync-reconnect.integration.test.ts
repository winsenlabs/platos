// RECONNECT WITHOUT RECONFIGURATION, AGAINST A DATABASE THE V1 CODE DID NOT
// CREATE.
//
// WIN-269 (M4.3). The census rows are "existing entities reconnect without
// reconfiguration" and "the same tools and health state appear". Every row this
// suite reads was written by the release that provisioned the legacy database,
// through that release's own rebuilt client, before any migration in this
// repository ran — see `tool-sync-legacy.ts` for how, and why it arrives through
// a process rather than an import.
//
// -----------------------------------------------------------------------------
// WHAT "WITHOUT RECONFIGURATION" IS MADE TO MEAN HERE
//
// The entity sends the declaration IT ALREADY SENDS, under the ids IT ALREADY
// HAS, into the environment IT IS ALREADY WIRED INTO. `ROLLOUT_TOOL_DECLARATION`
// is published by the fixture for exactly that reason: a suite that composed its
// own declaration would be registering something else and calling the result a
// reconnect. Nothing in the request is chosen by this file except the operator
// session, which is the CALLER rather than the configuration.
//
// Then three things are read back and none of them is a count:
//
//   THE EXPOSED SET IS IDENTICAL. `listTools` and `pageTools` before and after,
//   compared whole — tool ids included. Comparing lengths would pass against the
//   defect this is aimed at, which mints a SECOND `Tool` row and repoints the
//   exposure at it; the set would still have one member and every id in it would
//   have changed.
//
//   THE `ToolHealth` ROW KEEPS ITS IDENTITY. Its primary key, read from a `psql`
//   PROCESS. `ToolHealth` is keyed `(environmentId, toolId, entityExternalId)`,
//   so a tool that came back under a new id would leave the old row stranded and
//   a new one would appear beside it with zeroed counters — which is precisely
//   "the health state does not appear".
//
//   THE ENTITY IS `connected` AND ITS `lastConnectedAt` MOVED. The legacy row
//   carries `connected` and a NULL `lastConnectedAt`, so the status alone cannot
//   tell a write from a no-op; the timestamp is what says the write happened.
//
// -----------------------------------------------------------------------------
// THE CONTROL: A SYNC THAT WOULD REQUIRE RECONFIGURATION, AND IT FAILS
//
// `requires reconfiguration` is not a mood. It is what happens when the entity
// cannot present what it already has and an operator must intervene, and this
// file drives both shapes of that:
//
//   THE ENTITY'S OWN NAME CHANGES. `externalEntityId` is what `ToolHealth` rows
//   are filed under and what `registerTools` checks against the tenancy record.
//   A reconnect under a new name is refused with `TOOLS_ENTITY_NOT_IN_SCOPE`
//   rather than silently registering a second entity's tools under this one's.
//
//   THE SCHEMA HASH IS NOT THE CONTENT DIGEST. The legacy `Tool` row is content
//   addressed, and the re-derivation below joins the column the LEGACY client
//   wrote to the digest the `tools` context computes from the published
//   declaration. If those two ever stop agreeing, a reconnect mints a new tool —
//   and the identity cases above go red, which is what makes them a measurement
//   rather than a restatement.

import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asIdentifier, type EntityId } from "@platos/kernel";
import type { EnvironmentOperatorAuthorization, UserId } from "@platos/context-tenancy";
import type { ExternalEntityId, ToolsContract, ToolView } from "@platos/context-tools";

import { API_VERSION_PREFIX } from "../http/api-surface.js";
import {
  OPERATOR,
  OUTSIDER,
  post,
  startLegacyInstallation,
  type LegacyInstallation,
} from "./tool-sync-legacy.js";

/**
 * THE DECLARATION AND THE PIN, READ OFF THE FIXTURE PACKAGE AS DATA.
 *
 * `@platos/tenancy-database` may not be IMPORTED from this deployable — see
 * `tool-sync-legacy.ts` — so the three published constants are read out of its
 * built module as TEXT and parsed. That is the same discipline
 * `rest-chassis.test.ts` uses for `docs/error-taxonomy.json`: a file this
 * dimension does not control, read rather than restated.
 */
const FIXTURE = (() => {
  const source = execFileSync(
    process.execPath,
    [
      "-e",
      'const m = require("../../internal-packages/tenancy-database/dist/upgrade-fixture.js");' +
        "process.stdout.write(JSON.stringify({" +
        "declaration: m.ROLLOUT_TOOL_DECLARATION," +
        "schemaHash: m.ROLLOUT_TOOL_SCHEMA_HASH," +
        "health: m.ROLLOUT_TOOL_HEALTH }));",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return JSON.parse(source) as {
    readonly declaration: {
      readonly name: string;
      readonly description: string;
      readonly paramSchema: Record<string, unknown>;
      readonly category: string;
    };
    readonly schemaHash: string;
    readonly health: { readonly lastStatus: string; readonly avgLatencyMs: number };
  };
})();

const SYNC_PATH = `${API_VERSION_PREFIX}/tools/sync`;

let installation: LegacyInstallation;
let tools: ToolsContract;
let grant: EnvironmentOperatorAuthorization;
let entityId: string;
let environmentId: string;
let externalEntityId: string;
/** The exposed set and the health row, as the LEGACY installation left them. */
let before: readonly ToolView[];
let beforePage: { readonly items: readonly ToolView[]; readonly total: number };
let beforeHealthRow: string;

/** The request an entity that has changed nothing sends. */
function reconnectBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environmentId,
    entityId,
    externalEntityId,
    connectionStatus: "connected",
    tools: [
      {
        name: FIXTURE.declaration.name,
        description: FIXTURE.declaration.description,
        // `input_schema`, the platools spelling. The oracle normalises
        // `input_schema ?? paramSchema` and so does this transport.
        input_schema: FIXTURE.declaration.paramSchema,
        annotations: { category: FIXTURE.declaration.category },
      },
    ],
    tools_health: {
      [FIXTURE.declaration.name]: { status: "degraded", avg_latency_ms: 91, error_count_1h: 2 },
    },
    ...overrides,
  };
}

beforeAll(async () => {
  installation = await startLegacyInstallation();
  const composed = installation.running.app.contexts.tools;
  if (composed === undefined) throw new Error("tools must be composed for this suite to mean anything");
  tools = composed;
  const tenancy = installation.running.app.contexts.tenancy;
  if (tenancy === undefined) throw new Error("tenancy must be composed");

  entityId = installation.legacy.ids["entity"] as string;
  environmentId = installation.legacy.ids["environment"] as string;

  // THE EXTERNAL ID IS READ OFF THE ROW, NEVER WRITTEN DOWN HERE. It is the
  // entity's EXISTING configuration, and a literal would be this file choosing
  // the value it then claims was preserved.
  const [entityRow] = await installation.observe(
    `SELECT "externalId" FROM "Entity" WHERE id = '${entityId}'`,
  );
  externalEntityId = entityRow ?? "";

  const authorized = await tenancy.authorizeEnvironmentOperator({
    environmentId: asIdentifier(environmentId),
    operator: {
      actorUserId: asIdentifier<UserId>(OPERATOR.userId),
      effectiveUserId: asIdentifier<UserId>(OPERATOR.userId),
    },
    access: "secret:mutate",
  });
  if (!authorized.ok) throw new Error(`the operator could not be authorized: ${authorized.error.code}`);
  grant = authorized.value;

  const listed = await tools.listTools({ authorization: grant, callableOnly: false });
  if (!listed.ok) throw new Error(`listTools refused the legacy rows: ${listed.error.code}`);
  before = listed.value;
  const paged = await tools.pageTools({ authorization: grant, callableOnly: false, limit: 50, offset: 0 });
  if (!paged.ok) throw new Error(`pageTools refused the legacy rows: ${paged.error.code}`);
  beforePage = paged.value;
  [beforeHealthRow] = await installation.observe(
    `SELECT id || '|' || "toolId" || '|' || coalesce("entityExternalId",'') FROM "ToolHealth"`,
  ) as [string];
}, 600_000);

afterAll(async () => {
  await installation?.stop();
});

describe("the legacy installation, before anything reconnects", () => {
  it("holds a ToolHealth row the V1 stores can read, written by a HEARTBEAT", async () => {
    // THE ROW THAT COULD NOT BE READ. `lastStatus` here is `healthy`, the
    // platools `ToolHealthEntry` vocabulary, written verbatim by the oracle's
    // heartbeat handler. The V1 row narrowing admitted only the CALL vocabulary
    // (`success|failed|timeout`), so `findHealth` over this row threw
    // `UnreadableToolsRowError` — before any refusal about configuration, and for
    // every entity that has ever heartbeated.
    const [status] = await installation.observe(`SELECT "lastStatus" FROM "ToolHealth"`);
    expect(status).toBe(FIXTURE.health.lastStatus);
    expect(["success", "failed", "timeout"]).not.toContain(status);

    const health = await tools.listTools({ authorization: grant, callableOnly: false });
    expect(health.ok).toBe(true);
  });

  it("carries a content-addressed Tool row, written by the legacy client", async () => {
    // THE COLUMN, READ BACK FROM THE DATABASE. The pin is `ROLLOUT_TOOL_SCHEMA_HASH`
    // and the legacy client wrote it, so this pair on its own is circular and is
    // NOT the join — it is here so a reader can see the value the join is about.
    //
    // THE JOIN IS `newTools: 0` IN THE RECONNECT CASE BELOW, and it is not
    // circular at all: `registerTools` derives the digest ITSELF, from the
    // declaration the request carries, through `canonicalToolDocument` and
    // `toSchemaHash` — code this file cannot reach and does not call. If the pin
    // and that derivation ever disagree, the lookup misses, a SECOND `Tool` row is
    // minted, `newTools` is 1 and every identity case in this file goes red.
    const [row] = await installation.observe(
      `SELECT name || '|' || "schemaHash" || '|' || coalesce(category,'null') FROM "Tool"`,
    );
    expect(row).toBe(
      `${FIXTURE.declaration.name}|${FIXTURE.schemaHash}|${FIXTURE.declaration.category}`,
    );
    expect(before.map((tool) => tool.toolName)).toEqual([FIXTURE.declaration.name]);
  });

  it("has an entity whose connection was never timestamped", async () => {
    // `connected` WITH A NULL `lastConnectedAt` is the legacy row's shape, and it
    // is why the reconnect case below reads the timestamp rather than the status:
    // the status is already the value a successful sync writes.
    const [row] = await installation.observe(
      `SELECT "connectionStatus" || '|' || coalesce("lastConnectedAt"::text,'null') FROM "Entity" WHERE id = '${entityId}'`,
    );
    expect(row).toBe("connected|null");
  });
});

describe("POST /api/v1/tools/sync, from an entity that changed nothing", () => {
  it("succeeds, and leaves listTools and pageTools byte-identical", async () => {
    const answer = await post(installation.base, SYNC_PATH, {
      token: OPERATOR.token,
      body: reconnectBody(),
    });
    expect(answer.status).toBe(200);
    const data = answer.body["data"] as Record<string, unknown>;
    expect(data["registered"]).toBe(1);
    // NOTHING WAS NEW AND NOTHING WAS PRUNED. A reconnect that minted a tool
    // would report `newTools: 1` here, and a reconnect that lost one would report
    // `pruned: 1`. Both are the shapes this clause forbids.
    expect(data["newTools"]).toBe(0);
    expect(data["pruned"]).toBe(0);
    expect(data["unknownToolNames"]).toEqual([]);

    const listed = await tools.listTools({ authorization: grant, callableOnly: false });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // THE WHOLE VIEW, NOT A COUNT AND NOT A NAME. `toolId`, `exposureId`,
    // `callbackUrl`, `enabled`, `dispatchable` and the agent allow-list all ride
    // in here, and the defect this is aimed at changes the first two while leaving
    // every count alone.
    expect(listed.value).toEqual(before);

    const paged = await tools.pageTools({
      authorization: grant,
      callableOnly: false,
      limit: 50,
      offset: 0,
    });
    expect(paged.ok).toBe(true);
    if (!paged.ok) return;
    expect(paged.value).toEqual(beforePage);
  });

  it("preserves the ToolHealth row's identity and folds the heartbeat into it", async () => {
    // ONE ROW, STILL. A second row would mean the tool came back under a new id:
    // the key is `(environmentId, toolId, entityExternalId)`, so a repointed
    // exposure leaves the old row stranded and mints a fresh one with zeroed
    // counters beside it.
    const rows = await installation.observe(
      `SELECT id || '|' || "toolId" || '|' || coalesce("entityExternalId",'') FROM "ToolHealth"`,
    );
    expect(rows).toEqual([beforeHealthRow]);

    const [folded] = await installation.observe(
      `SELECT "lastStatus" || '|' || "avgLatencyMs"::text || '|' || "failCount"::text ` +
        `|| '|' || "totalCalls"::text || '|' || coalesce("lastCalledAt"::text,'null') FROM "ToolHealth"`,
    );
    // THE HEARTBEAT MOVED `lastStatus` AND `avgLatencyMs` AND NOTHING ELSE, which
    // is the oracle's own update set. `lastCalledAt` STAYS NULL and the counters
    // stay at zero because no call happened — a fold that advanced `totalCalls`
    // would make `isFailing` true for a tool nothing has ever dispatched to.
    expect(folded).toBe("degraded|91|0|0|null");
  });

  it("stamps the entity connected and dates the connection", async () => {
    const [row] = await installation.observe(
      `SELECT "connectionStatus" || '|' || (case when "lastConnectedAt" is null then 'null' else 'dated' end) ` +
        `FROM "Entity" WHERE id = '${entityId}'`,
    );
    expect(row).toBe("connected|dated");
  });

  it("is idempotent: a second identical sync converges on the same rows", async () => {
    // THE CLASSIFICATION, MEASURED. `http/idempotency-policy.ts` leaves this route
    // on the unlisted default `accepted` on the ground that a replayed sync
    // CONVERGES, and a platools client reconnecting in a loop is the ordinary
    // case rather than the exceptional one. This is that ground, executed.
    const again = await post(installation.base, SYNC_PATH, {
      token: OPERATOR.token,
      body: reconnectBody(),
    });
    expect(again.status).toBe(200);
    const listed = await tools.listTools({ authorization: grant, callableOnly: false });
    expect(listed.ok && listed.value).toEqual(before);
    const rows = await installation.observe(
      `SELECT id || '|' || "toolId" || '|' || coalesce("entityExternalId",'') FROM "ToolHealth"`,
    );
    expect(rows).toEqual([beforeHealthRow]);
  });

  it("is served with NO key while the idempotency store is down, which is why it is `accepted`", async () => {
    // THIS CASE WAS WRITTEN TO ASSERT A REPLAY AND MEASURED SOMETHING BETTER.
    //
    // This harness gives core-api a Redis it cannot reach, because nothing under
    // test needs one — and the M0.4 §2 gate FAILS CLOSED: a request that CARRIES
    // an `Idempotency-Key` with no store to reserve it in is refused
    // `IDEMPOTENCY_STORE_UNAVAILABLE` at 503, before any handler runs. That is
    // right, and it is the sharpest argument this suite can make for the
    // classification in `http/idempotency-policy.ts`.
    //
    //   A route classed `required` is UNSERVABLE while the store is down, for
    //   every caller, because the key it demands cannot be reserved.
    //
    //   A route classed `accepted` serves the caller who sends none. A platools
    //   client reconnecting after a network partition sends none — the SDK has no
    //   key to invent — so `accepted` is what keeps an entity's tools reachable
    //   during exactly the outage that disconnected it.
    //
    // Both halves are measured here rather than argued.
    const withKey = await post(installation.base, SYNC_PATH, {
      token: OPERATOR.token,
      key: `win269-${Date.now().toString(16)}`,
      body: reconnectBody(),
    });
    expect(withKey.status).toBe(503);
    expect((withKey.body["error"] as Record<string, unknown>)["code"]).toBe(
      "IDEMPOTENCY_STORE_UNAVAILABLE",
    );

    const withoutKey = await post(installation.base, SYNC_PATH, {
      token: OPERATOR.token,
      body: reconnectBody(),
    });
    expect(withoutKey.status).toBe(200);
    // AND THE ROWS ARE STILL THE LEGACY ONES. A 503 that had half-executed would
    // show up here, because the key was refused before the handler ran.
    const listed = await tools.listTools({ authorization: grant, callableOnly: false });
    expect(listed.ok && listed.value).toEqual(before);
  });
});

describe("the controls: a sync that WOULD require reconfiguration", () => {
  it("refuses a reconnect under a new external id, rather than filing it anyway", async () => {
    // AN ENTITY THAT HAD TO BE RENAMED IS AN ENTITY THAT WAS RECONFIGURED. The
    // refusal is the point: `ToolHealth.entityExternalId` is written from this
    // field, so admitting a mismatch would file this entity's health under
    // another name and the "same health state appears" clause would be
    // unfalsifiable.
    const answer = await post(installation.base, SYNC_PATH, {
      token: OPERATOR.token,
      body: reconnectBody({ externalEntityId: `${externalEntityId}-renamed` }),
    });
    expect(answer.status).toBe(404);
    expect((answer.body["error"] as Record<string, unknown>)["code"]).toBe("TOOLS_ENTITY_NOT_IN_SCOPE");

    const rows = await installation.observe(
      `SELECT count(*)::text FROM "ToolHealth"`,
    );
    expect(rows).toEqual(["1"]);
  });

  it("refuses an operator whose grant gate 3 closes, without emptying the listing", async () => {
    // A LISTING THAT ANSWERED 200 WITH AN EMPTY SET WOULD TELL AN OPERATOR THE
    // ENVIRONMENT IS EMPTY. The refusal is tenancy's own and carries which gate
    // closed.
    const answer = await post(installation.base, SYNC_PATH, {
      token: OUTSIDER.token,
      body: reconnectBody(),
    });
    expect(answer.status).toBe(403);
    expect((answer.body["error"] as Record<string, unknown>)["code"]).toBe(
      "TENANCY_ENVIRONMENT_FORBIDDEN",
    );
    const listed = await tools.listTools({ authorization: grant, callableOnly: false });
    expect(listed.ok && listed.value).toEqual(before);
  });

  it("refuses an unauthenticated reconnect", async () => {
    const answer = await post(installation.base, SYNC_PATH, { body: reconnectBody() });
    expect(answer.status).toBe(401);
  });

  it("drops a heartbeat entry for a tool this environment does not expose, and says so", async () => {
    // THE ORACLE'S OWN SKIP, MADE VISIBLE. `scopedTools.find` returns undefined
    // and the `if (entry)` guard falls through; a client that could not see the
    // drop would keep reporting health nobody records.
    const answer = await post(installation.base, SYNC_PATH, {
      token: OPERATOR.token,
      body: reconnectBody({
        tools_health: {
          [FIXTURE.declaration.name]: { status: "healthy", avg_latency_ms: 7 },
          not_a_tool_here: { status: "down", avg_latency_ms: 0 },
        },
      }),
    });
    expect(answer.status).toBe(200);
    const data = answer.body["data"] as Record<string, unknown>;
    expect(data["unknownToolNames"]).toEqual(["not_a_tool_here"]);
    const rows = await installation.observe(`SELECT count(*)::text FROM "ToolHealth"`);
    expect(rows).toEqual(["1"]);
  });

  it("refuses a heartbeat status no platools SDK can send, under its own code", async () => {
    const answer = await post(installation.base, SYNC_PATH, {
      token: OPERATOR.token,
      body: reconnectBody({
        tools_health: { [FIXTURE.declaration.name]: { status: "on fire", avg_latency_ms: 1 } },
      }),
    });
    expect(answer.status).toBe(400);
    expect((answer.body["error"] as Record<string, unknown>)["code"]).toBe(
      "TOOLS_HEALTH_REPORT_INVALID",
    );
  });
});

/** Named so the unused-import lint cannot hide a type this file depends on. */
export type ReconnectEntity = EntityId | ExternalEntityId;
