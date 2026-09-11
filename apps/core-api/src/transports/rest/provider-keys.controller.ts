// THE THIRD OF THE EIGHT ONE-TIME-SECRET MINTS TO GAIN A HANDLER, AND THE FIRST
// THAT IS NOT AN MCP TOKEN.
//
// POST /api/v1/agent/providers/keys/:id/rotate-secret
//
// `http/idempotency-policy.ts` classes eight operations `required` — no
// `Idempotency-Key`, no execution, `400 IDEMPOTENCY_KEY_REQUIRED`. Two of the
// eight were served before this file: `POST /mcp/platform/tokens` and
// `POST /mcp/entity/:entityId/tokens`. This is the third, and it is reachable
// now for one measured reason: `providers.rotateProviderKeySecret` was already
// published on `ProvidersContract`, and the context it lives on was not
// composed. `app.module.ts` composes `providers` over `tenancy` and `secrets`,
// so the method a V1 route is allowed to reach finally has an object behind it.
//
// The gate has been running at the edge of this process since M4.1 and this
// route did not exist, which is the same state the two MCP mints were in: a
// caller that OBEYED the contract and sent a key was reserved, admitted, and
// handed `TRANSPORT_ROUTE_NOT_FOUND` by the terminal controller — and the
// reservation it then held recorded that 404 and replayed it for every retry of
// the same key for twenty-four hours. The gate was not wrong; it was covering an
// operation nobody served.
//
// -----------------------------------------------------------------------------
// THIS MINT RETURNS NO SECRET, AND THE POLICY TABLE'S REASON FOR IT IS WRONG
//
// `OPERATION_POLICIES` records this row as "wire-secret — rotates a provider key
// and returns the new value once". The first half is right and the second is
// not, measured against both surfaces:
//
//   the ORACLE (`apps/agent/src/providers/providers.controller.ts`,
//   `rotateKeySecret`) takes `{ plaintext }` INBOUND and answers `{ key }`.
//
//   the CONTRACT method returns `ProviderKeyView`, whose ten fields are
//   `providerKeyId`, `environmentId`, `provider`, `label`, `credentialName`,
//   `isDefault`, `createdBy`, `lastUsedAt`, `createdAt` and `updatedAt`. Not one
//   of them can carry material.
//
// This is BYOK, exactly like `POST /api/v1/agent/providers/keys`, which the same
// table classes `exempt` on the recorded ground that "the secret travels inbound
// and is never returned". So the row's CLASS is kept and its REASON is corrected
// in place rather than carried: `required` is the stricter answer and the one
// that is already enforced, and reclassifying a bound operation is a contract
// decision this tranche has no mandate to take. What the key protects here is
// not a secret the caller could lose — it is the DOUBLE ROTATION: a retried
// request that ran twice would write the caller's new material, then write it
// again over a credential whose probe cache had already been evicted, and every
// other provider key pointing at that one credential would move twice.
//
// -----------------------------------------------------------------------------
// WHAT THIS ROUTE REFUSES, AND WHY EACH REFUSAL HAS ITS OWN CODE
//
//   UNAUTHENTICATED / SESSION_EXPIRED /
//   SESSION_REVOKED / MFA_REQUIRED         no live operator            (401)
//   TRANSPORT_CONTEXT_UNAVAILABLE          `providers` not composed    (503)
//   TENANCY_ENVIRONMENT_FORBIDDEN          the four-gate decision, asked at
//                                          `secret:mutate`             (403)
//   TRANSPORT_REQUEST_INVALID              a malformed body, with `fields[]`
//   PROVIDERS_KEY_METADATA_INVALID         material the DOMAIN refuses (400)
//   PROVIDERS_KEY_NOT_FOUND                no such key in that scope   (404)
//   PROVIDERS_CREDENTIAL_UNAVAILABLE       the credential moved under the key
//   PROVIDERS_PROBE_CACHE_NOT_EVICTED      the rotation landed and the cached
//                                          verdict did not
//
// Six distinct codes for six distinct facts, which is `error-taxonomy.mjs`'s
// whole point: two guards returning the same code cannot be told apart. The
// three `PROVIDERS_*` refusals are the CONTEXT's, passed through `raise` unedited
// for the reason `operator.ts` gives at length — a client told "400" learns
// nothing, and a client told `PROVIDERS_PROBE_CACHE_NOT_EVICTED` knows the write
// happened and the cache did not move.
//
// -----------------------------------------------------------------------------
// `secret:mutate` AND NOT `metadata`
//
// `EnvironmentAccess` has two levels and this route asks for the stronger one,
// which is the one authorization decision it makes. It is also NOT a free choice:
// `rotateProviderKeySecret` itself calls `requireAccess(verified, "secret:mutate")`,
// so a transport that asked for `metadata` would earn a grant the use case then
// refuses.
//
// THAT IS MEASURED RATHER THAN ASSERTED, and the answer is worth writing down
// because it is not the one a reader would guess. Weakening this one argument to
// `"metadata"` turns SEVEN cases in
// `composition/provider-key-rotation.integration.test.ts` red, and every
// authorized request answers `PROVIDERS_SCOPE_MISMATCH` at 403 — not
// `TENANCY_ENVIRONMENT_FORBIDDEN`, because tenancy said YES to the weaker
// question, and the refusal then comes from `providers`' own derivation of a
// secrets grant out of a tenancy grant. So the cost of asking too weakly is a
// refusal that blames the SCOPE, which sends an operator to look at their
// environment ids rather than at this line. Asking at the level the domain
// demands is what makes the refusal happen at the gate that knows why.
//
// -----------------------------------------------------------------------------
// AN IMPERSONATED SESSION MAY DO THIS, AND THE TWO MCP MINTS MAY NOT
//
// `token-mint.ts` refuses a mint under impersonation because `McpToken` has ONE
// actor column, the store reads it back as the credential's PRINCIPAL, and the
// credential outlives the impersonation session — so the row would have to claim
// either the admin or the borrowed account and both answers are wrong.
//
// NONE OF THAT APPLIES HERE, and the precedent is already in the tree: the same
// file's `revoke` is allowed under impersonation because "a revocation creates
// nothing that outlives anything". A rotation creates nothing either. It replaces
// material behind a credential that already exists and writes `credentialId` and
// `credentialName` back onto a key whose `createdBy` it does not touch, so there
// is no actor column for this operation to have to decide. The authorization is
// the EFFECTIVE user's, which is whose memberships tenancy evaluated, and that is
// the same rule every other route on this chassis follows.
//
// WHAT IS NOT RECORDED, AND IT IS A GAP THIS ROUTE INHERITS RATHER THAN MAKES.
// `rotate-provider-key.ts` records that the extraction source writes a
// `CredentialAudit` row for a rotation and that `secrets` — the sole writer of
// that table under ADR M0.3 §1 row 3 — publishes no audit-append operation, so
// `providers` cannot write one. The consequence for THIS route is that the human
// behind a rotation is not written anywhere by the V1 path. It is named here
// because a reader deciding whether to allow impersonation needs to know that the
// audit line they are assuming exists does not.

import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";

import { asIdentifier, err, ok, type FieldViolation, type Result } from "@platos/kernel";
import type { ProviderKeyId, ProviderKeyView } from "@platos/context-providers";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import { itemEnvelope, type ItemEnvelope } from "./envelope.js";
import { raise } from "./fault.js";
import {
  authenticateOperator,
  authorizeEnvironment,
  requireProviders,
  type InboundOperatorRequest,
} from "./operator.js";
import { instant, nullableInstant } from "./resources.js";
import { requestInvalid } from "./transport-errors.js";

/**
 * The request, after the chassis has read it.
 *
 * `environmentId` IS A BODY FIELD AND NOT A HEADER, which is the same break from
 * the legacy surface `platform-tokens.controller.ts` records at length. The
 * oracle reads its scope from `X-Platos-*` request headers through `ScopeGuard`;
 * an operation whose tenancy arrives in headers cannot be described by an OpenAPI
 * request schema, cannot be validated by the chassis pipe, and cannot report a
 * missing tenant in `fields[]`. So it is a named field, refused by name when
 * absent, and re-derived by `tenancy` from the leaf before anything is written.
 *
 * `plaintext` KEEPS THE ORACLE'S NAME. It is what the legacy handler accepts and
 * what the contract command calls the same value, and a V1 route that renamed it
 * to `secret` would put a third spelling on a field that already has one on the
 * wire and one in the domain.
 */
export interface RotateProviderKeySecretBody {
  readonly environmentId: string;
  readonly plaintext: string;
}

/**
 * EVERY VIOLATION IS COLLECTED BEFORE ANY IS REPORTED, for the reason
 * `mintPlatformTokenValidator` gives: M0.4 §2's envelope carries `fields[]`
 * precisely so a caller with two mistakes does not take two round trips.
 *
 * THE LENGTH CAP IS NOT CHECKED HERE AND THAT IS DELIBERATE.
 * `MAX_PROVIDER_SECRET_LENGTH` is the DOMAIN's, and `admitProviderSecret` refuses
 * an over-long secret as `PROVIDERS_KEY_METADATA_INVALID`. A transport that
 * repeated the number would be a second declaration of a policy the domain owns,
 * and the day the cap moved one of the two would be wrong. What this refuses is
 * the SHAPE — absent, not a string, or empty — because those are the mistakes
 * whose answer has to name `body.plaintext`, and the domain's refusal names
 * `secret`, its own field, which no caller of this route sends.
 */
export const rotateProviderKeySecretValidator = (
  input: unknown,
): Result<RotateProviderKeySecretBody> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      requestInvalid([{ field: "body", code: "malformed", message: "Send a JSON object." }]),
    );
  }
  const body = input as Record<string, unknown>;
  const violations: FieldViolation[] = [];
  const environmentId = body["environmentId"];
  if (typeof environmentId !== "string" || environmentId.trim() === "") {
    violations.push({
      field: "body.environmentId",
      code: environmentId === undefined ? "missing" : "invalid",
      message: "Send a non-empty string.",
    });
  }
  const plaintext = body["plaintext"];
  if (typeof plaintext !== "string" || plaintext === "") {
    violations.push({
      field: "body.plaintext",
      code: plaintext === undefined ? "missing" : "invalid",
      message: "Send the replacement secret as a non-empty string.",
    });
  }
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({ environmentId: environmentId as string, plaintext: plaintext as string });
};

const ROTATE_BODY_PIPE = new DomainValidationPipe(rotateProviderKeySecretValidator);

/**
 * A provider key, as V1 publishes it — AND THERE IS NO FIELD HERE THAT COULD
 * CARRY MATERIAL.
 *
 * DECLARED RATHER THAN RETURNED STRAIGHT FROM THE CONTEXT, which is ADR M0.4 D7:
 * "without declared DTOs, 'additive-only field compat' is a policy nobody can
 * enforce". Handing back `ProviderKeyView` would publish every field a later
 * `providers` change added, without anybody deciding to.
 *
 * AND IT IS THE REASON `scripts/arch/secret-response-census.mjs` STAYS SILENT
 * ABOUT THIS ROUTE. That census walks the AST of every file under
 * `transports/**` and counts a `MATERIAL_RESPONSE_KEYS` property sitting in an
 * object literal a request handler returns. `plaintext` reaches this file as a
 * REQUEST field and dies in the command below; the literal this projection
 * returns names ten fields and none of them is on that list. The census is
 * satisfied because the response genuinely carries no secret — not because the
 * projection was shaped to slip past a name check.
 */
export interface ProviderKeyResource {
  readonly providerKeyId: string;
  readonly environmentId: string;
  readonly provider: string;
  readonly label: string;
  readonly credentialName: string;
  readonly isDefault: boolean;
  readonly createdBy: string;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function providerKeyResource(key: ProviderKeyView): ProviderKeyResource {
  return {
    providerKeyId: key.providerKeyId,
    environmentId: key.environmentId,
    provider: key.provider,
    label: key.label,
    credentialName: key.credentialName,
    isDefault: key.isDefault,
    createdBy: key.createdBy,
    lastUsedAt: nullableInstant(key.lastUsedAt),
    createdAt: instant(key.createdAt),
    updatedAt: instant(key.updatedAt),
  };
}

@Controller({ path: "agent/providers", version: API_VERSION })
export class ProviderKeysController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  /**
   * `200` AND NOT `201`. The rotation CREATES nothing — the key and the
   * credential both already exist and keep their identities — so HTTP's own rule
   * gives 200, and the oracle answers 200 as well. It also matters to the
   * idempotency gate: `settlementFor` records everything below 500, so the replay
   * of a successful rotation returns the same 200 and the same body with
   * `Idempotency-Replayed: true`.
   *
   * THE AUTHORIZATION IS PASSED, NEVER THE ID FROM THE BODY. Tenancy re-derived
   * the scope from the environment's own ancestry while deciding, and
   * `EnvironmentOperatorAuthorization` is branded so a caller cannot forge one;
   * `providers` then re-verifies it against tenancy's own mint register, because
   * it arrives there typed as `unknown`. Handing over `body.environmentId`
   * instead would throw that away one line after earning it — and would not even
   * be accepted, since the command's `authorization` is the value that register
   * holds.
   */
  @Post("keys/:id/rotate-secret")
  @HttpCode(HttpStatus.OK)
  async rotateSecret(
    @Req() request: InboundOperatorRequest,
    @Param("id") id: string,
    @Body(ROTATE_BODY_PIPE) body: RotateProviderKeySecretBody,
  ): Promise<ItemEnvelope<ProviderKeyResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(
      app,
      operator,
      body.environmentId,
      "secret:mutate",
    );
    const rotated = await requireProviders(app).rotateProviderKeySecret({
      authorization,
      providerKeyId: asIdentifier<ProviderKeyId>(id),
      plaintext: body.plaintext,
    });
    if (!rotated.ok) raise(rotated.error);
    return itemEnvelope(providerKeyResource(rotated.value));
  }
}
