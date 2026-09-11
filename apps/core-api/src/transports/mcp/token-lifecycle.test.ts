// THE FOUR MCP TOKEN LIFECYCLE ROUTES, IN THE PARTS THAT NEED NO SERVER.
//
// WIN-268 (M4.2). The contract behind these routes is proved against a real
// PostgreSQL in
// `packages/adapters/postgres-tenancy/src/identity-bearer-lifecycle.integration.test.ts`;
// that they are MOUNTED, reachable in registration order and refused by their own
// pipes before any handler runs is proved against a real process in
// `../rest/route-manifest.test.ts`. What is left is the half an integration suite
// would be silently wrong about:
//
//   * WHICH ACCESS LEVEL each route asks tenancy for. Ask for too much and a
//     viewer-shaped role can read nothing; too little and a viewer can end a
//     credential. An integration suite run as an owner passes either way.
//   * WHICH SCOPE reaches the contract — the AUTHORIZATION's, re-derived by
//     tenancy from the environment's own ancestry, never the id from the request.
//     A suite whose request and whose authorization name the same environment
//     cannot tell the two apart.
//   * WHERE a `fields[]` path POINTS. The mint reads `environmentId` from a body
//     and the listing and the revocation read it from a query, so one hard-coded
//     `body.environmentId` would send a client reading a 400 from the listing to a
//     request part that route does not have.
//   * THAT THE LIST DTO NAMES NO CREDENTIAL MATERIAL, checked against the census's
//     own key list rather than against a list retyped here.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The secret-response census's OWN key list, READ AS TEXT rather than imported.
 *
 * `scripts/arch/secret-response-census.mjs` is the gate that counts a response
 * property whose NAME says the value is material, and it covers every file under
 * `apps/core-api/src/transports/**`. Asserting against a copy of its list here
 * would be an assertion between two things this tree controls, so the list has to
 * come from that file.
 *
 * A `readFileSync` AND NOT AN `await import`, which is what this was first written
 * as. `scripts/arch/composition-root.mjs` refuses a run-time import specifier
 * anywhere but `apps/mcp-stdio/src/runtime.ts` — "resolves an import specifier at
 * run time, which no boundary rule can see" — and it is right to: a dynamic import
 * is an edge no static boundary scan can follow, and a test is not an exemption.
 * Reading the source is the same join without the edge, and it is how
 * `route-manifest.test.ts` reads the generated operation manifest and
 * `rest-chassis.test.ts` reads `docs/error-taxonomy.json`.
 *
 * THE PARSE FAILS LOUDLY. A regex that matched nothing would yield an empty list
 * and make every assertion below vacuous, so the extraction throws and the case
 * additionally pins what the list must contain.
 */
const MATERIAL_KEYS: readonly string[] = ((): readonly string[] => {
  const source = readFileSync(
    new URL("../../../../../scripts/arch/secret-response-census.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export const MATERIAL_RESPONSE_KEYS = [");
  if (start < 0) throw new Error("MATERIAL_RESPONSE_KEYS is not declared in the census");
  const end = source.indexOf("];", start);
  if (end < 0) throw new Error("MATERIAL_RESPONSE_KEYS has no closing bracket");
  return [...source.slice(start, end).matchAll(/"([^"]+)"/gu)].map((match) => match[1] as string);
})();

import { asIdentifier, err, ok, type DomainError, type Result } from "@platos/kernel";
import type {
  BearerCredentialPageView,
  BearerCredentialView,
  IdentityAccessContract,
  ListBearerCredentialsRequest,
  RevokeBearerCredentialCommand,
  RevokedBearerCredentialView,
} from "@platos/context-identity-access";
import { createIdentityAccessService, testPorts } from "@platos/context-identity-access/application/index.js";
import type {
  AuthorizeEnvironmentOperatorRequest,
  EntityRecord,
  TenancyContract,
} from "@platos/context-tenancy";

import type { AppModule } from "../../app.module.js";
import { domainErrorOf } from "../rest/fault.js";
import { McpEntityTokensController } from "./entity-tokens.controller.js";
import { McpPlatformTokensController, revokePlatformTokenValidator } from "./platform-tokens.controller.js";
import {
  bearerCredentialResource,
  nextTokenCursor,
  revokedTokenResource,
  tokenListQueryValidator,
  tokenScopeQueryValidator,
  type TokenListWireQuery,
  type TokenScopeWireQuery,
} from "./token-lifecycle.js";
import { encodeCursor } from "../rest/envelope.js";

const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
/** The environment the OPERATOR is authorized for. */
const AUTHORIZED_ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
/**
 * The environment the REQUEST names.
 *
 * DELIBERATELY DIFFERENT from the authorized one. Nothing in production can make
 * them differ — tenancy re-derives the scope from the id it was given — but making
 * them differ here is the only way to observe WHICH of the two the handler passes
 * on, and passing the request's would be the defect `operator.ts` calls "throwing
 * the authorization away one line after earning it".
 */
const REQUESTED_ENVIRONMENT = "44444444-4444-4444-8444-444444444444";
const OPERATOR_USER = "55555555-5555-4555-8555-555555555555";
const ENTITY = "66666666-6666-4666-8666-666666666666";
const FOREIGN_PROJECT = "77777777-7777-4777-8777-777777777777";

interface Recorded {
  readonly access: string[];
  readonly listed: ListBearerCredentialsRequest[];
  readonly revoked: RevokeBearerCredentialCommand[];
}

const CREDENTIAL: BearerCredentialView = {
  credentialId: "cred-1",
  kind: "mcp-token",
  label: "a credential",
  permissions: ["tools.*"],
  principalId: OPERATOR_USER,
  permissionTier: "admin",
  state: "active",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
};

const REVOKED: RevokedBearerCredentialView = {
  credentialId: "cred-1",
  kind: "mcp-token",
  label: "a credential",
  revokedAt: new Date("2026-06-02T00:00:00.000Z"),
  newlyRevoked: false,
  previousState: "revoked",
  revokedBy: OPERATOR_USER,
};

function page(rows: readonly BearerCredentialView[], hasMore = false): BearerCredentialPageView {
  return { credentials: rows, total: rows.length, limit: 25, offset: 0, hasMore };
}

/**
 * An `AppModule` whose two contexts record what the handler asked them for.
 *
 * `identityAccess` is a REAL service with two methods overridden, so every method
 * the handler does not stub behaves as the contract does — the same construction
 * `identity-rest.test.ts` uses for its sign-out cases.
 */
function moduleWith(entity: EntityRecord | DomainError): {
  readonly app: AppModule;
  readonly recorded: Recorded;
} {
  const recorded: Recorded = { access: [], listed: [], revoked: [] };
  const identityAccess: IdentityAccessContract = {
    ...createIdentityAccessService(testPorts()),
    authenticateOperator: () =>
      Promise.resolve(
        ok({
          sessionId: "session-1",
          actorUserId: OPERATOR_USER,
          effectiveUserId: OPERATOR_USER,
          email: "operator@example.test",
          expiresAt: new Date("2026-12-01T00:00:00.000Z"),
          mfaVerifiedAt: null,
          impersonating: null,
        }),
      ),
    listBearerCredentials: (request) => {
      recorded.listed.push(request);
      return Promise.resolve(ok(page([CREDENTIAL])));
    },
    revokeBearerCredential: (command) => {
      recorded.revoked.push(command);
      return Promise.resolve(ok(REVOKED));
    },
  };
  const tenancy = {
    name: "tenancy",
    authorizeEnvironmentOperator: (request: AuthorizeEnvironmentOperatorRequest) => {
      recorded.access.push(request.access);
      // THE SCOPE IS THE AUTHORIZED ONE AND NOT THE REQUESTED ONE. See
      // `REQUESTED_ENVIRONMENT`.
      return Promise.resolve(
        ok({
          principalType: "operator",
          tier: "OPERATOR",
          access: request.access,
          scope: {
            level: "environment",
            organizationId: asIdentifier(ORGANIZATION),
            projectId: asIdentifier(PROJECT),
            environmentId: asIdentifier(AUTHORIZED_ENVIRONMENT),
          },
          actorUserId: asIdentifier(OPERATOR_USER),
          effectiveUserId: asIdentifier(OPERATOR_USER),
          organizationRole: "OWNER",
          projectRole: null,
        }),
      );
    },
    findEntity: (): Promise<Result<EntityRecord>> =>
      Promise.resolve(
        "code" in entity ? err(entity as DomainError) : ok(entity as EntityRecord),
      ),
  } as unknown as TenancyContract;
  return {
    recorded,
    app: { contexts: { identityAccess, tenancy } } as unknown as AppModule,
  };
}

const IN_PROJECT = {
  id: asIdentifier(ENTITY),
  projectId: asIdentifier(PROJECT),
} as unknown as EntityRecord;

const IN_ANOTHER_PROJECT = {
  id: asIdentifier(ENTITY),
  projectId: asIdentifier(FOREIGN_PROJECT),
} as unknown as EntityRecord;

const REQUEST = { headers: { authorization: "Bearer plt_os_operator" } };

describe("WIN-268 — what the four routes ask tenancy for", () => {
  it("a LISTING asks for `metadata` and a REVOCATION asks for `secret:mutate`", async () => {
    const platform = moduleWith(IN_PROJECT);
    const platformController = new McpPlatformTokensController({ app: platform.app });
    await platformController.list(REQUEST as never, {
      environmentId: REQUESTED_ENVIRONMENT,
      offset: 0,
      limit: 25,
    });
    await platformController.revoke(REQUEST as never, "cred-1", {
      environmentId: REQUESTED_ENVIRONMENT,
    });

    const entity = moduleWith(IN_PROJECT);
    const entityController = new McpEntityTokensController({ app: entity.app });
    await entityController.list(REQUEST as never, ENTITY, {
      environmentId: REQUESTED_ENVIRONMENT,
      offset: 0,
      limit: 25,
    });
    await entityController.revoke(REQUEST as never, ENTITY, "cred-1", {
      environmentId: REQUESTED_ENVIRONMENT,
    });

    // THE PAIRS ARE ASSERTED TOGETHER so a change that levelled them up or down
    // uniformly fails rather than looking consistent.
    expect(platform.recorded.access).toEqual(["metadata", "secret:mutate"]);
    expect(entity.recorded.access).toEqual(["metadata", "secret:mutate"]);
  });

  it("passes the AUTHORIZATION's scope to the contract, never the id from the request", async () => {
    const platform = moduleWith(IN_PROJECT);
    const controller = new McpPlatformTokensController({ app: platform.app });
    await controller.list(REQUEST as never, {
      environmentId: REQUESTED_ENVIRONMENT,
      offset: 0,
      limit: 25,
    });
    await controller.revoke(REQUEST as never, "cred-1", { environmentId: REQUESTED_ENVIRONMENT });

    for (const scope of [
      platform.recorded.listed[0]?.scope,
      platform.recorded.revoked[0]?.scope,
    ]) {
      expect(scope?.level).toBe("environment");
      expect(scope && "environmentId" in scope ? scope.environmentId : null).toBe(
        AUTHORIZED_ENVIRONMENT,
      );
    }
  });

  it("sends the ENTITY as the subject on the entity surface and NULL on the platform one", async () => {
    const entity = moduleWith(IN_PROJECT);
    const entityController = new McpEntityTokensController({ app: entity.app });
    await entityController.list(REQUEST as never, ENTITY, {
      environmentId: REQUESTED_ENVIRONMENT,
      offset: 0,
      limit: 25,
    });
    await entityController.revoke(REQUEST as never, ENTITY, "cred-1", {
      environmentId: REQUESTED_ENVIRONMENT,
    });
    expect(entity.recorded.listed[0]?.kind).toBe("entity-bearer-token");
    expect(entity.recorded.listed[0]?.subjectId).toBe(ENTITY);
    expect(entity.recorded.revoked[0]?.subjectId).toBe(ENTITY);
    // `McpBearerToken` HAS NO `revokedBy` COLUMN, so the actor is not sent and the
    // view reports null rather than an attribution nothing stored.
    expect(entity.recorded.revoked[0]?.revokedByUserId).toBeNull();

    const platform = moduleWith(IN_PROJECT);
    const platformController = new McpPlatformTokensController({ app: platform.app });
    await platformController.list(REQUEST as never, {
      environmentId: REQUESTED_ENVIRONMENT,
      offset: 0,
      limit: 25,
    });
    await platformController.revoke(REQUEST as never, "cred-1", {
      environmentId: REQUESTED_ENVIRONMENT,
    });
    expect(platform.recorded.listed[0]?.subjectId).toBeNull();
    expect(platform.recorded.revoked[0]?.subjectId).toBeNull();
    // `McpToken.revokedBy` EXISTS, so the ACTOR is recorded — and it is the actor
    // rather than the effective user, so an impersonated revocation names the human.
    expect(platform.recorded.revoked[0]?.revokedByUserId).toBe(OPERATOR_USER);
  });

  it("REFUSES an entity from another project, and points `fields[]` at the right request part", async () => {
    const listing = moduleWith(IN_ANOTHER_PROJECT);
    const listingController = new McpEntityTokensController({ app: listing.app });
    const listFailure: unknown = await listingController
      .list(REQUEST as never, ENTITY, {
        environmentId: REQUESTED_ENVIRONMENT,
        offset: 0,
        limit: 25,
      })
      .catch((error: unknown) => error);
    const listError = domainErrorOf(listFailure);
    expect(listError?.code).toBe("MCP_ENTITY_ENVIRONMENT_MISMATCH");
    // A `GET` HAS NO BODY. Pointing at `body.environmentId` would send a client to
    // a request part this route does not have.
    expect(listError?.fields.map((field) => field.field)).toEqual(["query.environmentId"]);
    // AND THE CONTRACT WAS NEVER REACHED: the pair check runs before the listing.
    expect(listing.recorded.listed).toHaveLength(0);

    // THE MINT'S PATH STILL POINTS AT THE BODY, which is the case a single hard-coded
    // path would have kept correct while breaking the other two.
    const minting = moduleWith(IN_ANOTHER_PROJECT);
    const mintController = new McpEntityTokensController({ app: minting.app });
    const mintFailure: unknown = await mintController
      .mint(REQUEST as never, ENTITY, {
        environmentId: REQUESTED_ENVIRONMENT,
        label: "x",
        scopes: ["mcp:tools"],
        mcpUserId: null,
        ttlSeconds: null,
      })
      .catch((error: unknown) => error);
    expect(domainErrorOf(mintFailure)?.fields.map((field) => field.field)).toEqual([
      "body.environmentId",
    ]);
  });

  it("RAISES the contract's refusal rather than answering an empty page", async () => {
    // The failure that looks like success. An operator shown `200 {"data":[]}` for
    // a store that refused cannot tell it from an environment with no credentials.
    const module = moduleWith(IN_PROJECT);
    const identityAccess = (module.app.contexts as { identityAccess: IdentityAccessContract })
      .identityAccess;
    const refusing: IdentityAccessContract = {
      ...identityAccess,
      listBearerCredentials: () =>
        Promise.resolve(
          err({
            code: "IDENTITY_STORE_UNAVAILABLE",
            category: "unavailable",
            message: "no",
            fields: [],
            retryAfterSeconds: null,
            details: {},
          } as DomainError),
        ),
    };
    const controller = new McpPlatformTokensController({
      app: { contexts: { ...module.app.contexts, identityAccess: refusing } } as unknown as AppModule,
    });
    const failure: unknown = await controller
      .list(REQUEST as never, { environmentId: REQUESTED_ENVIRONMENT, offset: 0, limit: 25 })
      .catch((error: unknown) => error);
    expect(domainErrorOf(failure)?.code).toBe("IDENTITY_STORE_UNAVAILABLE");
  });
});

describe("WIN-268 — reading the query string, and reporting every mistake at once", () => {
  it("names a missing `environmentId` AND a bad `limit` in one refusal", () => {
    const outcome = tokenListQueryValidator({ limit: "5000" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.fields.map((field) => field.field).sort()).toEqual([
      "query.environmentId",
      "query.limit",
    ]);
  });

  it("refuses a REPEATED `environmentId` rather than picking one", () => {
    const outcome = tokenListQueryValidator({ environmentId: ["a", "b"] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.fields[0]?.field).toBe("query.environmentId");
      expect(outcome.error.fields[0]?.code).toBe("repeated");
    }
  });

  it("takes `limit` and `cursor` from the chassis, so this route has no second grammar", () => {
    // The default is `DEFAULT_PAGE_SIZE`, which lives in `../rest/page.ts` and is
    // not restated here; asserting the NUMBER would be a second declaration of it.
    const defaulted = tokenListQueryValidator({ environmentId: AUTHORIZED_ENVIRONMENT });
    expect(defaulted.ok && defaulted.value.offset).toBe(0);
    // A malformed cursor is refused rather than treated as offset zero, which is how
    // a client paging a directory quietly re-reads page one forever.
    const malformed = tokenListQueryValidator({
      environmentId: AUTHORIZED_ENVIRONMENT,
      cursor: "not-a-cursor",
    });
    expect(malformed.ok).toBe(false);
  });

  it("the DELETE's query carries the environment and nothing else", () => {
    expect(tokenScopeQueryValidator({}).ok).toBe(false);
    const outcome = tokenScopeQueryValidator({ environmentId: AUTHORIZED_ENVIRONMENT });
    expect(outcome.ok && outcome.value.environmentId).toBe(AUTHORIZED_ENVIRONMENT);
  });

  // M4 finish — THE PUBLISHED QUERY SCHEMA AND THE PARSER, HELD TO EACH OTHER.
  //
  // `TokenListWireQuery` and `TokenScopeWireQuery` are what the OpenAPI document
  // now publishes as these routes' `parameters`: the derivation reads them off
  // `DomainValidationPipe<Parsed, Wire>` through the type checker
  // (`scripts/openapi-schema-derivation.test.mjs` proves that half by deleting a
  // property and watching the parameter vanish). A declaration is only worth
  // publishing if the PARSER agrees with it, so this is the other half — and the
  // two literals below are TYPED BY THE DECLARATION, so adding a parameter to the
  // interface without sending it here does not compile.
  it("accepts every parameter the published wire query declares", () => {
    const everyDeclared: Required<TokenListWireQuery> = {
      environmentId: AUTHORIZED_ENVIRONMENT,
      limit: "5",
      cursor: encodeCursor({ offset: 10 }),
    };
    const outcome = tokenListQueryValidator(everyDeclared);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value).toEqual({
      environmentId: AUTHORIZED_ENVIRONMENT,
      limit: 5,
      offset: 10,
    });
  });

  it("REFUSES the absence of the one parameter the document marks required", () => {
    // `environmentId` is the only member of both wire declarations with no `?`, so
    // it is the only parameter published as `required: true`. The minimum literal
    // is typed by the declaration: making `environmentId` optional on the interface
    // would let `{}` through here and the parser would then disagree with the
    // document.
    const minimum: TokenListWireQuery = { environmentId: AUTHORIZED_ENVIRONMENT };
    expect(tokenListQueryValidator(minimum).ok).toBe(true);
    const scopeMinimum: TokenScopeWireQuery = { environmentId: AUTHORIZED_ENVIRONMENT };
    expect(tokenScopeQueryValidator(scopeMinimum).ok).toBe(true);

    for (const validator of [tokenListQueryValidator, tokenScopeQueryValidator]) {
      const outcome = validator({});
      expect(outcome.ok).toBe(false);
      // BY NAME, and the name is the published parameter's own. A 403 about an
      // environment called `undefined` is the answer a generated client could not
      // act on.
      expect(
        !outcome.ok && domainErrorOf(outcome.error)?.fields.map((field) => field.field),
      ).toContain("query.environmentId");
    }
  });

  it("the platform revocation's BODY carries the environment and nothing else", () => {
    expect(revokePlatformTokenValidator({}).ok).toBe(false);
    expect(revokePlatformTokenValidator([]).ok).toBe(false);
    const outcome = revokePlatformTokenValidator({ environmentId: AUTHORIZED_ENVIRONMENT });
    expect(outcome.ok && outcome.value.environmentId).toBe(AUTHORIZED_ENVIRONMENT);
  });

  it("mints the next cursor from the CONTRACT's `hasMore`, not from arithmetic", () => {
    expect(nextTokenCursor(page([CREDENTIAL], false))).toBeNull();
    expect(nextTokenCursor(page([CREDENTIAL], true))).not.toBeNull();
  });
});

describe("WIN-268 — the wire shape carries no credential material", () => {
  it("renders instants as strings and names no property the census counts", () => {
    const resource = bearerCredentialResource(CREDENTIAL);
    expect(resource.tokenId).toBe(CREDENTIAL.credentialId);
    expect(resource.createdAt).toBe("2026-06-01T00:00:00.000Z");
    expect(resource.expiresAt).toBe("2026-09-01T00:00:00.000Z");
    expect(resource.lastUsedAt).toBeNull();
    expect(resource.state).toBe("active");
    // NOT VACUOUS. A loop over an undefined or empty array passes, and an import
    // that resolved to nothing would make the whole assertion below a no-op — which
    // is precisely the shape of gate this programme has already found dark. `token`
    // is the key the two mints DO return and the one these DTOs must never grow, so
    // its presence in the list is what proves the list arrived.
    expect(Array.isArray(MATERIAL_KEYS)).toBe(true);
    expect(MATERIAL_KEYS.length).toBeGreaterThan(10);
    expect(MATERIAL_KEYS).toContain("token");
    expect(MATERIAL_KEYS).not.toContain("tokenId");

    // THE CENSUS'S OWN KEY LIST, imported rather than retyped, so a key added there
    // is checked here without an edit. `tokenId` is on the census's exclusion list
    // and `token` is the one this must never grow.
    for (const key of MATERIAL_KEYS) {
      expect(Object.keys(resource), key).not.toContain(key);
      expect(Object.keys(revokedTokenResource(REVOKED)), key).not.toContain(key);
    }
    expect(Object.keys(resource)).not.toContain("tokenHash");
  });

  it("reports the three revocation states verbatim from the contract", () => {
    for (const previousState of ["active", "revoked", "expired"] as const) {
      const rendered = revokedTokenResource({ ...REVOKED, previousState });
      expect(rendered.previousState).toBe(previousState);
    }
    expect(revokedTokenResource({ ...REVOKED, newlyRevoked: true }).newlyRevoked).toBe(true);
    expect(revokedTokenResource(REVOKED).revokedAt).toBe("2026-06-02T00:00:00.000Z");
  });
});
