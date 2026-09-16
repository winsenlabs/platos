// THE `/tools/sync` TRANSPORT, SO AN EXISTING ENTITY RECONNECTS WITHOUT BEING
// RECONFIGURED.
//
// POST /api/v1/tools/sync
//
// WIN-269 (M4.3). The clause is "existing entities reconnect without
// reconfiguration" and "the same tools and health state appear". The oracle
// serves that on a WebSocket at `/tools/sync`
// (`apps/agent/src/tool-gateway/tool-sync-ws.service.ts`), and that socket does
// THREE things per session that outlive the socket: it replaces the entity's
// tool declaration, it stamps `Entity.connectionStatus`, and it folds the
// heartbeat's `tools_health` into `ToolHealth`. This route is those three
// facts, on the REST chassis, reaching published contract methods only.
//
// -----------------------------------------------------------------------------
// IT IS ONE ROUTE AND NOT THREE, WHICH IS THE ONE DESIGN DECISION HERE
//
// A session on the oracle is not three independent writes: a `tool_register`
// frame arrives on a connection that has ALREADY been marked connected, and a
// `heartbeat` names tools that registration just committed. Splitting them
// across three routes would hand a reconnecting client three round trips it
// could interleave wrongly — heartbeat before register means every name is
// unknown, register before connect means a live entity is `disconnected` while
// its tools are being served. One request carries the session's whole opening
// state, in the oracle's own order, and the order is stated below rather than
// implied by the order of three client calls.
//
// -----------------------------------------------------------------------------
// WHY IT IS REST AND NOT A SOCKET IN THIS PROCESS
//
// The ADR M0.3 §6 shape for this deployable is the REST chassis and the ONE
// authentication seam in `transports/rest/operator.ts`. A WebSocket upgrade
// handler would be a second authentication path — the oracle's own socket
// authenticates a `Bearer <serviceSecret>` against `Credential.kind =
// ENTITY_SECRET` by hash, which is a credential family that seam cannot express
// — and `error-taxonomy.mjs` states the cost: two guards returning the same
// answer cannot be told apart. So this transport takes the operator grant the
// rest of the surface takes, and the LIVE socket is left serving the entity
// credential. Both write the same rows through the same contract methods; that
// is what `tool-sync-characterization.integration.test.ts` joins.
//
// NOTHING HERE DELETES THE LIVE ROUTE. WIN-269's register keeps
// `tool-sync-ws.service.ts` where it is. This route makes its three sites
// MOVABLE by publishing what they needed; retiring them is the strangler's
// second half and belongs to whoever repoints the SDK.
//
// -----------------------------------------------------------------------------
// THE ORDER, AND WHY EACH STEP IS WHERE IT IS
//
//   1. AUTHENTICATE, then AUTHORIZE the environment at `secret:mutate`. Both of
//      the contract methods this route calls demand that level themselves
//      (`registerTools` and `recordToolHealth` each call
//      `requireAccess(grant, "secret:mutate")`), so asking for `metadata` would
//      earn a grant the use cases then refuse — and the refusal would blame the
//      SCOPE, sending an operator to look at their environment ids.
//
//   2. CONNECTION STATUS FIRST, when the caller sent one. The oracle marks the
//      entity connected BEFORE it processes the buffered `tool_register` frame
//      (the race-fix block in the socket replays the early buffer only after the
//      `entity.update`), and the order matters to a reader: an entity whose tools
//      appeared while it was still `disconnected` looks like a stale declaration.
//
//   3. REGISTER. The declarative replace. This is the step that can shrink the
//      matrix, so it is the one whose failure must abort the request rather than
//      leave health folded onto exposures that no longer exist.
//
//   4. HEALTH LAST, because `recordToolHealth` resolves each reported name
//      against the exposures registration just committed. Run first, every name
//      in a first-ever declaration would be unknown.
//
// -----------------------------------------------------------------------------
// IDEMPOTENCY: `accepted`, WHICH IS A CLASSIFICATION AND NOT AN OVERSIGHT
//
// `http/idempotency-policy.ts` names the one-time-secret mints `required` and
// the operations the rule cannot bind `exempt`; everything else takes the
// unlisted default `accepted` — a key is honoured when one is sent and nothing
// is refused when one is not. This route takes that default, and the reason is
// the one the tier-2 MCP policy `PUT` beside it records: a replayed sync
// CONVERGES. `registerTools` is a declarative replace of one (environment,
// entity) pair, `recordEntityConnection` writes a fixed value, and
// `recordToolHealth` upserts on `(environmentId, toolId, entityExternalId)`.
// Running it twice leaves exactly the rows running it once leaves. A `required`
// row would refuse every platools client that reconnects without inventing a
// key, for a property the operation already has by construction; an `exempt` row
// would claim the rule CANNOT bind it, and it can — a caller that sends a key
// gets the replay. `idempotency-policy.test.ts` pins the classification.
//
// AND IT RETURNS NO SECRET. The response carries counts, the entity's connection
// status, and the health rows — `scripts/arch/secret-response-census.mjs` walks
// this literal and finds no `MATERIAL_RESPONSE_KEYS` property, because there is
// none to find. The callback URL a caller SENDS is deliberately not echoed:
// `packages/contexts/tools/contracts/index.ts` withholds it from every view on
// the ground that it "is the address of a customer's backend and often carries a
// path segment that is effectively a shared secret".

import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from "@nestjs/common";

import { asIdentifier, type DomainError } from "@platos/kernel";
import type {
  ExternalEntityId,
  ToolHealthRecordingView,
  ToolHealthView,
  ToolsContract,
} from "@platos/context-tools";
import type { EntityRecord } from "@platos/context-tenancy";
import type { EntityId } from "@platos/kernel";

import type { AppModule } from "../../app.module.js";
import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { REST_APPLICATION, type RestApplication } from "../rest/dependencies.js";
import { itemEnvelope, type ItemEnvelope } from "../rest/envelope.js";
import { raise } from "../rest/fault.js";
import {
  authenticateOperator,
  authorizeEnvironment,
  requireTenancy,
  type InboundOperatorRequest,
} from "../rest/operator.js";
import { nullableInstant } from "../rest/resources.js";
import { contextUnavailable } from "../rest/transport-errors.js";
import { toolSyncValidator, type ToolSyncBody } from "./tool-sync-body.js";

const TOOL_SYNC_BODY_PIPE = new DomainValidationPipe(toolSyncValidator);

/**
 * The composed `tools`, or a 503 that says which context is missing.
 *
 * It is here rather than in `rest/operator.ts` for one measured reason: that
 * file is the AUTHENTICATION seam, and its three `require*` helpers are the
 * contexts authentication itself needs — `identity-access` to authenticate,
 * `tenancy` to authorize, `providers` because the rotation route was written
 * before this rule was visible. `tools` is needed by this route and by no
 * authentication step, so putting it there would widen a security seam with a
 * lookup that has nothing to do with security. The 503 is the same
 * `TRANSPORT_CONTEXT_UNAVAILABLE` and carries the context's own name, which is
 * the property that mattered.
 */
export function requireTools(app: AppModule): ToolsContract {
  const tools = app.contexts.tools;
  if (tools === undefined) raise(contextUnavailable("tools"));
  return tools;
}

/** One tool's health, as V1 publishes it. */
export interface ToolHealthResource {
  readonly toolId: string;
  readonly externalEntityId: string | null;
  readonly lastCalledAt: string | null;
  readonly lastStatus: string | null;
  readonly failCount: number;
  readonly totalCalls: number;
  readonly totalFailures: number;
  readonly avgLatencyMs: number | null;
}

/**
 * The answer to one sync.
 *
 * DECLARED RATHER THAN RETURNED STRAIGHT FROM THE CONTEXTS, which is ADR M0.4
 * D7. `RegisteredToolsView` carries the whole `ToolView` list including
 * `callbackUrl`-adjacent routing detail, and `EntityRecord` carries
 * `mcpUrls` and `allowedOrigins`; a handler that returned either would publish
 * every field a later contract change added, without anybody deciding to.
 *
 * `unknownToolNames` IS THE FIELD WORTH HAVING. The oracle silently drops a
 * heartbeat entry for a name the scope does not expose; a client that could not
 * see the drop would keep reporting health for a tool nobody records.
 */
export interface ToolSyncResource {
  readonly entityId: string;
  readonly externalEntityId: string;
  readonly environmentId: string;
  readonly connectionStatus: string;
  readonly lastConnectedAt: string | null;
  readonly registered: number;
  readonly newTools: number;
  readonly updated: number;
  readonly pruned: number;
  readonly health: readonly ToolHealthResource[];
  readonly unknownToolNames: readonly string[];
}

export function toolHealthResource(health: ToolHealthView): ToolHealthResource {
  return {
    toolId: health.toolId,
    externalEntityId: health.externalEntityId,
    lastCalledAt: nullableInstant(health.lastCalledAt),
    lastStatus: health.lastStatus,
    failCount: health.failCount,
    totalCalls: health.totalCalls,
    totalFailures: health.totalFailures,
    avgLatencyMs: health.avgLatencyMs,
  };
}

@Controller({ path: "tools", version: API_VERSION })
export class ToolSyncController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  /**
   * `200` AND NOT `201`. A sync CREATES nothing a caller can address: the entity
   * already exists, and the exposures are a replacement of a set rather than a
   * new resource with a location. The oracle answers its `tools_registered`
   * frame the same way — with counts, not with an identity.
   */
  @Post("sync")
  @HttpCode(HttpStatus.OK)
  async sync(
    @Req() request: InboundOperatorRequest,
    @Body(TOOL_SYNC_BODY_PIPE) body: ToolSyncBody,
  ): Promise<ItemEnvelope<ToolSyncResource>> {
    const app = this.application.app;
    const tools = requireTools(app);
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(
      app,
      operator,
      body.environmentId,
      "secret:mutate",
    );
    const entityId = asIdentifier<EntityId>(body.entityId);
    const externalEntityId = asIdentifier<ExternalEntityId>(body.externalEntityId);

    const entity = await this.announce(app, authorization, entityId, body.connectionStatus);

    const registered = await tools.registerTools({
      authorization,
      entityId,
      externalEntityId,
      // `category ?? undefined` AND NOT `category: null`. `ToolDeclarationIntake`
      // spells "no category" as ABSENT, and the wire spells it as absent too;
      // the null in between is this transport's own normalisation of two SDK
      // spellings and does not belong on either side of it.
      tools: body.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        paramSchema: tool.paramSchema,
        ...(tool.category === null ? {} : { category: tool.category }),
      })),
      callbackUrl: body.callbackUrl,
    });
    if (!registered.ok) raise(registered.error);

    const recorded = await this.fold(tools, authorization, entityId, externalEntityId, body);

    return itemEnvelope({
      entityId: entity.id,
      externalEntityId: entity.externalId,
      environmentId: body.environmentId,
      connectionStatus: entity.connectionStatus,
      lastConnectedAt: nullableInstant(entity.lastConnectedAt),
      registered: registered.value.registered,
      newTools: registered.value.newTools,
      updated: registered.value.updated,
      pruned: registered.value.removed,
      health: recorded.recorded.map(toolHealthResource),
      unknownToolNames: [...recorded.unknownToolNames],
    });
  }

  /**
   * Step 2 — the connection stamp, and the read that stands in for it when the
   * caller sent no status.
   *
   * A SYNC WITHOUT A `connectionStatus` STILL ANSWERS WITH ONE, read off the
   * record rather than assumed. The alternative — omitting the field from the
   * response when the request omitted it — would make the response shape depend
   * on the request, which M0.4 §2's item envelope does not permit and which a
   * generated client cannot type.
   */
  private async announce(
    app: AppModule,
    authorization: unknown,
    entityId: EntityId,
    status: string | null,
  ): Promise<EntityRecord> {
    const tenancy = requireTenancy(app);
    if (status === null) {
      const found = await tenancy.findEntity(entityId);
      if (!found.ok) raise(found.error as DomainError);
      return found.value;
    }
    const recorded = await tenancy.recordEntityConnection({ authorization, entityId, status });
    if (!recorded.ok) raise(recorded.error as DomainError);
    return recorded.value;
  }

  /** Step 4 — the heartbeat fold, skipped entirely when the frame carried none. */
  private async fold(
    tools: ToolsContract,
    authorization: unknown,
    entityId: EntityId,
    externalEntityId: ExternalEntityId,
    body: ToolSyncBody,
  ): Promise<ToolHealthRecordingView> {
    if (body.health.length === 0) return { recorded: [], unknownToolNames: [] };
    const recorded = await tools.recordToolHealth({
      authorization,
      entityId,
      externalEntityId,
      reports: body.health.map((report) => ({
        toolName: report.toolName,
        status: report.status,
        avgLatencyMs: report.avgLatencyMs,
      })),
    });
    if (!recorded.ok) raise(recorded.error);
    return recorded.value;
  }
}
