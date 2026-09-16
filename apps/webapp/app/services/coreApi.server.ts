// THE DASHBOARD'S SERVER-SIDE CLIENT FOR THE V1 CORE API (WIN-257 T8, D11).
//
// Until this file existed the webapp reached its own data through Prisma:
// `app/services/database.server.ts` held a `PrismaClient` built from
// `DATABASE_URL`, fifteen delegate calls lived in ten route modules, and
// `PlatosAuthService` ran the whole operator-session and membership story inside
// the process that renders HTML. D11 (2026-09-15): "the cutover CODE lands on the
// branch: core-api routes, Caddy per-route upstreams, and webapp per-route
// dispatch. Taking it to production is the founder's merge and deploy."
//
// ---------------------------------------------------------------------------
// PER-ROUTE DISPATCH, AND WHY IT IS A TABLE RATHER THAN A BASE URL
//
// The tempting shape is `coreFetch(path)` with the caller spelling the path. The
// cutover is per-route by decision, not by accident — routes move one at a time,
// and while it is in progress the same process talks to two upstreams that mean
// different things (`PLATOS_AGENT_API_URL` is the legacy agent at `agent:3100`,
// `PLATOS_CORE_API_URL` is the V1 composition root). A free-form path parameter
// makes "which of the two serves this?" a question you answer by reading every
// call site, and makes "what has moved so far?" unanswerable.
//
// So `CORE_OPERATIONS` below is the answer to both, in one place: every V1
// operation the dashboard dispatches, its method, its path template and — for
// the two that mint a one-time secret — its idempotency class. A caller names an
// OPERATION; it cannot name a path. `platosAgent.server.ts`'s
// `assertAgentPath`/`assertMcpManagementPath` make the same argument for the
// legacy upstream from the other direction, by refusing anything off an
// allow-list; a table refuses it earlier, because there is nothing to write.
//
// ---------------------------------------------------------------------------
// THE CREDENTIAL IS THE OPERATOR'S OWN COOKIE, AND IT IS THE ONLY ONE
//
// Every route in the table authenticates the operator behind the request and
// authorizes the scope from that operator: `apps/core-api/src/transports/rest/
// operator.ts` reads the session cookie by the name the identity-access contract
// publishes and accepts it in either dialect — including Remix's
// `base64(JSON.stringify(token))`, which is what every session this webapp ever
// minted looks like (D19, and `transports/rest/session-cookie-value.ts` for the
// measurement). So the dashboard forwards the inbound `Cookie` header and adds
// no credential of its own.
//
// THAT IS A DELIBERATE ABSENCE. `PLATOS_INTERNAL_AUTH_TOKEN` is the shared secret
// the webapp presents to the AGENT, where it buys a blanket "operator" grant over
// the direct-header channel. Presenting anything like it to core-api would create
// a second way in that is weaker than the first and that no V1 route's
// authorization rule has ever been written against. The BFF's authority here is
// exactly the authority of the human holding the browser.
//
// ---------------------------------------------------------------------------
// WHAT THIS CLIENT DOES NOT DO
//
//   IT DOES NOT SET COOKIES.  `magic.tsx` and `logout.tsx` read core-api's
//     `Set-Cookie` for its VALUE and re-serialize it through the webapp's own
//     `createCookie`, because core-api decides `Secure` and the `__Host-` prefix
//     from ITS OWN connection (`isSecureTransport` reads `req.secure` and trusts
//     no header), and its own connection is the plain-HTTP hop from this process
//     — not the browser's TLS. Relaying the header verbatim would downgrade a
//     production session cookie to a non-`__Host-`, non-`Secure` one. See
//     `auth.server.ts`.
//   IT DOES NOT RETRY.  A loader that silently retried a `PUT` would turn one
//     operator action into two writes.
//   IT DOES NOT CACHE.  Every call is scoped to one operator and one request.

import { randomUUID } from "node:crypto";

import { env } from "~/env.server";

import { CoreApiError, CoreApiUnavailableError } from "./coreApiError";

// ---------------------------------------------------------------------------
// The version prefix, restated once
// ---------------------------------------------------------------------------

// RESTATED, NOT IMPORTED, AND JOINED BY A TEST. `apps/core-api/src/http/
// api-surface.ts` is the authority on this prefix; it is a different deployable
// and the webapp may not take a dependency on it. Spelling `"/api/v1"` inline
// would put the major version in a string literal in a route module, which is
// the exact shape ADR M0.4 §2's prefix rule refuses in a routing decorator and
// the exact shape that goes stale invisibly at v2.
//
// So the prefix is COMPOSED from named parts here, once, and
// `test/coreApiClient.test.ts` reads core-api's `api-surface.ts` off disk and
// asserts the two agree — the same technique `session-cookie-value.ts` uses to
// restate Remix's cookie encoding and then execute the real library against it.
const CORE_GLOBAL_PREFIX = "api";
const CORE_VERSION_SEGMENT_PREFIX = "v";
const CORE_API_MAJOR = "1";

/** `/api/v1`, composed. Exported so the join test can read it. */
export const CORE_VERSION_PREFIX = `/${CORE_GLOBAL_PREFIX}/${CORE_VERSION_SEGMENT_PREFIX}${CORE_API_MAJOR}`;

/**
 * The MCP root, which is VERSION-NEUTRAL and not an oversight.
 *
 * `apps/core-api/src/transports/mcp/mcp-surface.ts` mounts every MCP controller
 * with `VERSION_NEUTRAL` and states why: the protocol prefix is a third axis the
 * API version must not appear on. The legacy agent serves the same paths at the
 * same root, which is what makes a per-route cutover of these two mints possible
 * at all.
 */
export const CORE_MCP_ROOT = "/mcp";

// ---------------------------------------------------------------------------
// The operation table
// ---------------------------------------------------------------------------

export type CoreMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * `required` mirrors `apps/core-api/src/http/idempotency-policy.ts`, which
 * refuses these two operations outright without an `Idempotency-Key`: they mint
 * a bearer secret "returned once and never readable again", so a replay that
 * re-executed would leave a second live credential nobody has.
 */
export type CoreIdempotency = "required" | "default";

export interface CoreOperation {
  readonly method: CoreMethod;
  readonly path: (parameters: Readonly<Record<string, string>>) => string;
  readonly idempotency: CoreIdempotency;
}

function segment(parameters: Readonly<Record<string, string>>, name: string): string {
  const value = parameters[name];
  if (value === undefined || value === "") {
    throw new Error(`core-api operation needs a ${name}`);
  }
  return encodeURIComponent(value);
}

function operation(
  method: CoreMethod,
  path: CoreOperation["path"],
  idempotency: CoreIdempotency = "default",
): CoreOperation {
  return Object.freeze({ method, path, idempotency });
}

/**
 * EVERY V1 OPERATION THE DASHBOARD DISPATCHES. Nothing else is reachable.
 *
 * The names are `resource.action`, so the table reads as an inventory of what has
 * moved. Each one replaces a named thing the Remix tree used to do in-process;
 * the comment on each says which, because "what did this route do before?" is the
 * question a reader of the cutover asks first.
 */
export const CORE_OPERATIONS = Object.freeze({
  /** `operatorAuth.authorizeOperatorSession` — who is this browser? */
  "identity.session": operation("GET", () => `${CORE_VERSION_PREFIX}/identity/session`),

  /** `operatorAuth.issueMagicLink` + the webapp's own Resend call (D20). */
  "magicLink.start": operation("POST", () => `${CORE_VERSION_PREFIX}/bff/magic-link`),

  /** `operatorAuth.consumeMagicLink` + `commitOperatorSession`. */
  "magicLink.complete": operation("POST", () => `${CORE_VERSION_PREFIX}/bff/magic-link/complete`),

  /** `operatorAuth.revokeOperatorSession` — ends the ROW, not only the cookie. */
  "session.signOut": operation("DELETE", () => `${CORE_VERSION_PREFIX}/bff/session`),

  /** `database.organizationMembership.findFirst` / `organization.findFirst`. */
  "organizations.list": operation("GET", () => `${CORE_VERSION_PREFIX}/organizations`),

  /** `database.organization.create` with its nested founder membership. */
  "organizations.create": operation("POST", () => `${CORE_VERSION_PREFIX}/organizations`),

  /** The `memberships` selection of `settings.team`'s `organization.findFirst`. */
  "organizations.members.list": operation(
    "GET",
    (p) => `${CORE_VERSION_PREFIX}/organizations/${segment(p, "organizationId")}/members`,
  ),

  /** `operatorAuth.changeMembershipRole`. */
  "organizations.members.changeRole": operation(
    "PATCH",
    (p) =>
      `${CORE_VERSION_PREFIX}/organizations/${segment(p, "organizationId")}/members/${segment(p, "membershipId")}`,
  ),

  /** `operatorAuth.issueInvitation`, now gated by D1 inside the tenancy context. */
  "organizations.invitations.issue": operation(
    "POST",
    (p) => `${CORE_VERSION_PREFIX}/organizations/${segment(p, "organizationId")}/invitations`,
  ),

  /** `operatorVisibleProjectWhere` — the rule that lived only as a Prisma filter. */
  "projects.list": operation("GET", () => `${CORE_VERSION_PREFIX}/projects`),

  /** The three-row `database.$transaction` in `projects.new`. */
  "projects.create": operation("POST", () => `${CORE_VERSION_PREFIX}/projects`),

  /** `auth.server.requireEnvironmentScope`'s slug resolution and grant. */
  "environments.bySlugs": operation("GET", () => `${CORE_VERSION_PREFIX}/environments/by-slugs`),

  /** `database.endUser.findMany` + `.count` on the agent-accounts page. */
  "environments.endUsers.list": operation(
    "GET",
    (p) => `${CORE_VERSION_PREFIX}/environments/${segment(p, "environmentId")}/end-users`,
  ),

  /** `database.environmentVariable.findMany`. */
  "environments.variables.list": operation(
    "GET",
    (p) => `${CORE_VERSION_PREFIX}/environments/${segment(p, "environmentId")}/variables`,
  ),

  /** `database.environmentVariable.upsert`. */
  "environments.variables.set": operation(
    "PUT",
    (p) =>
      `${CORE_VERSION_PREFIX}/environments/${segment(p, "environmentId")}/variables/${segment(p, "key")}`,
  ),

  /** The platform MCP-token mint the dashboard re-serves (WIN-259). */
  "mcp.platformTokens.mint": operation(
    "POST",
    () => `${CORE_MCP_ROOT}/platform/tokens`,
    "required",
  ),

  /** The entity MCP-token mint the dashboard re-serves (WIN-259). */
  "mcp.entityTokens.mint": operation(
    "POST",
    (p) => `${CORE_MCP_ROOT}/entity/${segment(p, "entityId")}/tokens`,
    "required",
  ),
} satisfies Readonly<Record<string, CoreOperation>>);

export type CoreOperationName = keyof typeof CORE_OPERATIONS;

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------
//
// DECLARED IN `coreApiError.ts`, WHICH READS NO ENVIRONMENT, and re-exported here
// so every call site keeps one import. That file says why the split exists.

export {
  CoreApiError,
  CoreApiUnavailableError,
  isForbidden,
  isUnauthenticated,
} from "./coreApiError";

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface CoreCall {
  /** The inbound Remix request. Its `Cookie` header is the operator's credential. */
  readonly request?: Request;
  /** A `Cookie` header value, when the caller has one and no `Request`. */
  readonly cookie?: string | null;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | undefined | null>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /**
   * An explicit key for a `required` operation. Omitted, one is minted per call.
   *
   * A minted key still buys something real: core-api's middleware reserves it
   * before the handler runs, so a duplicate submission that races itself is
   * refused as in-progress rather than minting two credentials. What it cannot do
   * is deduplicate a RETRY the operator made by hand, which is why the parameter
   * exists for callers that can carry a key across attempts.
   */
  readonly idempotencyKey?: string;
}

/** What a call returns: the parsed envelope, plus the raw response for headers. */
export interface CoreAnswer<Payload> {
  readonly status: number;
  readonly data: Payload;
  readonly page: { readonly total?: number; readonly hasMore?: boolean; readonly nextCursor?: string | null } | null;
  readonly headers: Headers;
}

function cookieHeader(call: CoreCall): string | null {
  if (call.cookie !== undefined && call.cookie !== null && call.cookie !== "") return call.cookie;
  const header = call.request?.headers.get("Cookie");
  return header === null || header === undefined || header === "" ? null : header;
}

function queryString(query: CoreCall["query"]): string {
  if (query === undefined) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered === "" ? "" : `?${rendered}`;
}

function faultFrom(status: number, payload: unknown): CoreApiError {
  const error =
    payload !== null && typeof payload === "object" && "error" in (payload as Record<string, unknown>)
      ? ((payload as Record<string, unknown>)["error"] as Record<string, unknown>)
      : {};
  return new CoreApiError(
    status,
    typeof error["code"] === "string" ? error["code"] : "CORE_API_ERROR",
    typeof error["body"] === "string" ? error["body"] : `core-api refused with ${String(status)}`,
    Array.isArray(error["fields"])
      ? (error["fields"] as readonly { field: string; code: string; message: string }[])
      : [],
  );
}

/**
 * Dispatch ONE named V1 operation.
 *
 * The 10-second budget is the one `platosAgent.server.ts` already uses for the
 * legacy upstream. A loader that hung on an unreachable core would hold a Remix
 * worker until the browser gave up, and the operator would see a spinner rather
 * than the 503 every one of these routes is written to answer.
 */
export async function coreRequest<Payload = unknown>(
  name: CoreOperationName,
  call: CoreCall = {},
): Promise<CoreAnswer<Payload>> {
  const route = CORE_OPERATIONS[name];
  const path = route.path(call.parameters ?? {});
  const headers: Record<string, string> = { Accept: "application/json" };
  const cookie = cookieHeader(call);
  if (cookie !== null) headers["Cookie"] = cookie;
  if (call.body !== undefined) headers["Content-Type"] = "application/json";
  if (route.idempotency === "required") {
    headers["Idempotency-Key"] = call.idempotencyKey ?? randomUUID();
  }

  let response: Response;
  try {
    response = await fetch(`${env.PLATOS_CORE_API_URL}${path}${queryString(call.query)}`, {
      method: route.method,
      headers,
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      signal: call.signal ?? AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CoreApiUnavailableError();
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text !== "") {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      // A non-JSON body from a JSON API is a proxy or a crash, never a refusal
      // this client can interpret. Reporting it as `CORE_API_ERROR` with the raw
      // text would put an upstream's HTML in a dashboard message.
      throw new CoreApiUnavailableError();
    }
  }

  if (!response.ok) throw faultFrom(response.status, payload);

  const envelope = (payload ?? {}) as { data?: unknown; page?: unknown };
  return {
    status: response.status,
    data: envelope.data as Payload,
    page: (envelope.page as CoreAnswer<Payload>["page"]) ?? null,
    headers: response.headers,
  };
}

/** The `data` of one named operation, for the callers that need nothing else. */
export async function coreData<Payload = unknown>(
  name: CoreOperationName,
  call: CoreCall = {},
): Promise<Payload> {
  return (await coreRequest<Payload>(name, call)).data;
}

// ---------------------------------------------------------------------------
// The wire types the dashboard reads
// ---------------------------------------------------------------------------
//
// DECLARED HERE RATHER THAN INFERRED FROM `unknown`. These mirror the resource
// interfaces core-api publishes (`transports/rest/resources.ts` and each
// controller); restating them is what lets the routes below be type-checked
// against a contract instead of against `any`, and a field that disappears from
// V1 becomes a compile error in the screen that renders it rather than an
// `undefined` in a table cell.

export interface CoreOperatorSession {
  readonly sessionId: string;
  readonly actorUserId: string;
  readonly effectiveUserId: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly mfaVerifiedAt: string | null;
  readonly impersonating: { readonly targetUserId: string } | null;
}

export interface CoreOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly membership: { readonly id: string; readonly role: string; readonly deactivatedAt: string | null };
}

export interface CoreEnvironmentSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface CoreProject {
  readonly id: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly through: string;
  /** Unarchived, oldest first. The nested select the Prisma reads carried. */
  readonly environments: readonly CoreEnvironmentSummary[];
}

export interface CoreCreatedProject {
  readonly project: CoreProject;
  readonly environment: CoreEnvironmentSummary;
  readonly membership: { readonly id: string; readonly role: string };
}

export interface CoreTenantNode {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface CoreEnvironmentScope {
  readonly organization: CoreTenantNode;
  readonly project: CoreTenantNode;
  readonly environment: CoreTenantNode;
  readonly environments: readonly CoreTenantNode[];
  readonly access: string;
  readonly organizationRole: string;
  readonly projectRole: string | null;
}

export interface CoreOrganizationMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAt: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly accountDisabledAt: string | null;
}

export interface CoreEndUser {
  readonly endUserId: string;
  readonly displayName: string | null;
  readonly disabledAt: string | null;
  readonly createdAt: string;
  readonly identities: readonly {
    readonly issuer: string;
    readonly channel: string;
    readonly subject: string;
    readonly verifiedAt: string | null;
    readonly disabledAt: string | null;
  }[];
}

export interface CoreEnvironmentVariable {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly value: string | null;
  readonly hasSecret: boolean;
  readonly version: number;
  readonly lastUpdatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CoreMagicLinkSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

export interface CoreIssuedInvitation {
  readonly invitationId: string;
  readonly expiresAt: string;
  readonly supersededCount: number;
}

/** A mint. `token` is the one-time secret; see `secret-response-census.mjs`. */
export interface CoreMintedToken {
  readonly tokenId: string;
  readonly token: string;
  readonly label: string;
  readonly permissions: readonly string[];
  readonly tier: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}
