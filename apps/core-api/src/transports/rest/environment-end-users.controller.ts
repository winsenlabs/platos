// GET /api/v1/environments/:environmentId/end-users — THE ROUTE THAT MUST NOT
// TURN A REFUSAL INTO AN EMPTY PAGE.
//
// Two contracts meet here and neither may be skipped. `tenancy` decides whether
// this operator may address this environment at all — the four-gate RBAC
// decision, re-derived from the leaf id so a caller cannot name a scope they were
// not granted — and `identity-access` owns the rows, because it is sole writer of
// `EndUser` and, until it published `listEndUsers`, "the only listing in the
// product reached past every contract into the database".
//
// THE FAILURE THIS ROUTE IS BUILT AGAINST is the one that looks like success. If
// the authorization refusal were swallowed and the handler answered
// `200 {"data": []}`, an operator would be shown an environment that appears
// EMPTY rather than one they may not see — and nothing on the wire, in a log, or
// in a screenshot would distinguish the two. So `authorizeEnvironment` RAISES,
// and `TENANCY_ENVIRONMENT_FORBIDDEN` reaches the caller at 403 carrying
// `details.gate`, which names which of the four gates closed.
// `identity-rest.integration.test.ts` proves it against a real database with a
// real operator who holds no membership: the assertion is on the STATUS and the
// CODE, and it would fail against an empty 200.
//
// THE SCOPE IS THE AUTHORIZATION'S, NOT THE PATH'S. `listEndUsers` takes a
// `TenantScope` and the value passed is `authorization.scope` — the environment
// scope tenancy re-derived while deciding — never a scope assembled here from the
// URL. `EnvironmentOperatorAuthorization` is branded and frozen precisely so a
// caller cannot construct one, and using the id from the path would throw that
// away one line after earning it.
//
// PAGINATION IS THE CONTRACT'S, TRANSLATED. `EndUserPageView` is limit/offset with
// a `total` and a `hasMore`; M0.4 §2's envelope is opaque cursors. The cursor is
// therefore an encoded offset, and `nextCursor` is minted FROM the contract's own
// `hasMore` rather than by comparing numbers here — so the envelope's derived
// `hasMore` and the contract's cannot disagree.

import { Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";
import type { EndUserPageView, EndUserView } from "@platos/context-identity-access";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import {
  collectionEnvelope,
  decodeCursor,
  encodeCursor,
  type CollectionEnvelope,
} from "./envelope.js";
import { raise } from "./fault.js";
import {
  authenticateOperator,
  authorizeEnvironment,
  requireIdentityAccess,
  type InboundOperatorRequest,
} from "./operator.js";
import { parsePageQuery, type QueryInput } from "./page.js";
import { instant, nullableInstant } from "./resources.js";
import { requestInvalid } from "./transport-errors.js";

export interface EndUserIdentityResource {
  readonly issuer: string;
  readonly channel: string;
  readonly subject: string;
  readonly verifiedAt: string | null;
  readonly disabledAt: string | null;
}

export interface EndUserResource {
  readonly endUserId: string;
  readonly displayName: string | null;
  readonly disabledAt: string | null;
  readonly createdAt: string;
  readonly identities: readonly EndUserIdentityResource[];
}

/** What this route reads out of the query string, after the chassis has read the page. */
export interface EndUserQuery {
  readonly offset: number;
  readonly limit: number;
  /** Echoed to the contract UNTOUCHED. An unknown value is its refusal to make. */
  readonly status: string | null;
  readonly search: string | null;
}

/** A single-valued, optional string parameter. A repeated one is refused. */
function optional(
  query: QueryInput,
  name: string,
  violations: FieldViolation[],
): string | null {
  const value = query[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    violations.push({
      field: `query.${name}`,
      code: "repeated",
      message: "Send this parameter once; it was sent more than once.",
    });
    return null;
  }
  return value;
}

/**
 * The offset inside an opaque cursor.
 *
 * A cursor that decodes to JSON but not to THIS shape is refused rather than
 * treated as offset zero. `envelope.ts` promises only that a cursor round-trips
 * through base64url and `JSON.parse`; anything past that is this route's own
 * business, and silently starting from the beginning is how a client paging a
 * directory quietly re-reads page one forever.
 */
export function offsetInCursor(cursor: string | null, violations: FieldViolation[]): number {
  if (cursor === null) return 0;
  const decoded = decodeCursor(cursor);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded) ||
    typeof (decoded as { readonly offset?: unknown }).offset !== "number"
  ) {
    violations.push({
      field: "query.cursor",
      code: "malformed",
      message: "cursor is opaque: send back a nextCursor this service issued.",
    });
    return 0;
  }
  const offset = (decoded as { readonly offset: number }).offset;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    violations.push({
      field: "query.cursor",
      code: "malformed",
      message: "cursor is opaque: send back a nextCursor this service issued.",
    });
    return 0;
  }
  return offset;
}

export const endUserQueryValidator = (input: unknown): Result<EndUserQuery> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      requestInvalid([
        { field: "query", code: "malformed", message: "The query string could not be read." },
      ]),
    );
  }
  const query = input as QueryInput;
  // THE CHASSIS OWNS `limit` AND `cursor`. Re-implementing the integer grammar
  // here would be a second rule about the same field, and the two would drift.
  const page = parsePageQuery(query);
  const violations: FieldViolation[] = page.ok ? [] : [...page.error.fields];
  const status = optional(query, "status", violations);
  const search = optional(query, "search", violations);
  const offset = page.ok ? offsetInCursor(page.value.cursor, violations) : 0;
  if (violations.length > 0) return err(requestInvalid(violations));
  if (!page.ok) return err(page.error);
  return ok({ offset, limit: page.value.limit, status, search });
};

const END_USER_QUERY_PIPE = new DomainValidationPipe(endUserQueryValidator);

export function endUserResource(user: EndUserView): EndUserResource {
  return {
    endUserId: user.endUserId,
    displayName: user.displayName,
    disabledAt: nullableInstant(user.disabledAt),
    createdAt: instant(user.createdAt),
    identities: user.identities.map((identity) => ({
      issuer: identity.issuer,
      channel: identity.channel,
      subject: identity.subject,
      verifiedAt: nullableInstant(identity.verifiedAt),
      disabledAt: nullableInstant(identity.disabledAt),
    })),
  };
}

/**
 * The next page's cursor, or null.
 *
 * DERIVED FROM THE CONTRACT'S `hasMore`, never from arithmetic here. The view
 * already answers "is there another page" from the store's own total; recomputing
 * `offset + limit < total` would be a second answer to one question, and the
 * envelope would then report whichever of the two this file happened to trust.
 */
export function nextCursorFor(page: EndUserPageView): string | null {
  return page.hasMore ? encodeCursor({ offset: page.offset + page.limit }) : null;
}

@Controller({ path: "environments", version: API_VERSION })
export class EnvironmentEndUsersController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Get(":environmentId/end-users")
  async list(
    @Req() request: InboundOperatorRequest,
    @Param("environmentId") environmentId: string,
    @Query(END_USER_QUERY_PIPE) query: EndUserQuery,
  ): Promise<CollectionEnvelope<EndUserResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(app, operator, environmentId);
    const identityAccess = requireIdentityAccess(app);
    const page = await identityAccess.listEndUsers({
      scope: authorization.scope,
      status: query.status,
      search: query.search,
      limit: query.limit,
      offset: query.offset,
    });
    if (!page.ok) raise(page.error);
    return collectionEnvelope({
      rows: page.value.users.map(endUserResource),
      cursor: query.offset === 0 ? null : encodeCursor({ offset: query.offset }),
      limit: page.value.limit,
      nextCursor: nextCursorFor(page.value),
      total: page.value.total,
    });
  }
}
