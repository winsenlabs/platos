// /environments/:environmentId/variables — THE ENVIRONMENT'S CONFIGURATION,
// LISTED AS METADATA AND WRITTEN AS WRITE-ONLY INPUT.
//
// WIN-259's scope clause: "remove direct webapp writes of environment variables".
// The webapp's `environment-variables` loader runs `environmentVariable.findMany`
// and `environment-variables.new`'s action runs `environmentVariable.upsert`, both
// straight past `secrets`, which is sole writer of the table and has published
// `listEnvironmentVariables` and `setEnvironmentVariable` all along. These are the
// two routes those Remix handlers cut over to in T8; this file is the core-api
// half.
//
// -----------------------------------------------------------------------------
// D9 — WHAT CROSSES THE WIRE
//
// THE LISTING IS METADATA. `EnvironmentVariableMetadata` is the vault's own
// projection and its field set is pinned by `ENVIRONMENT_VARIABLE_METADATA_FIELDS`:
// a SECRET variable's `value` is always null and `hasSecret` says whether a
// credential backs it. A PLAIN variable's value is on the wire because it is not a
// secret — that is what PLAIN means, the oracle loader returned it, and a
// dashboard that could not show `NODE_ENV` would be useless. `environmentId` is
// dropped because it cannot be anything but the path's.
//
// THE WRITE IS WRITE-ONLY. The body's `value` is put into the self-redacting
// `SecretMaterial` holder by `acceptPlaintext` FIRST, before anything else in the
// handler runs, so no object this process builds after decoding the body holds
// the plaintext as a string a logger, a retry buffer or an error report could
// serialise. The response is the same metadata projection, so setting a SECRET
// variable answers with `value: null`. `scripts/arch/secret-response-census.mjs`
// walks this file and finds no material key in a returned literal, because there
// is none.
//
// -----------------------------------------------------------------------------
// THE VAULT GRANT IS DERIVED, NOT ASSEMBLED
//
// `authorizeVault` asks tenancy the four-gate question — at `metadata` for the
// listing, `secret:mutate` for the write, which is the level the oracle's action
// demanded — and mints the vault's grant from tenancy's re-derived scope. The path
// parameter chooses which environment to ASK about and is never the scope: an
// admin of another organization who names this environment's id is refused
// `TENANCY_ENVIRONMENT_FORBIDDEN` before `secrets` is reached.
//
// REFUSALS: 401 family from the seam; `TENANCY_ENVIRONMENT_FORBIDDEN` 403;
// `TRANSPORT_REQUEST_INVALID` for a body that is not `{ value, secret? }`;
// `INVALID_SECRET_MATERIAL` for an empty value; and whatever `secrets` says about
// the key's grammar, passed through unedited.

import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Put, Query, Req } from "@nestjs/common";

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";
import { acceptPlaintext, type EnvironmentVariableMetadata } from "@platos/context-secrets";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe, UNPAGED_QUERY_PIPE } from "../../http/validation.pipe.js";
import { jsonBody } from "./body.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import {
  collectionEnvelope,
  itemEnvelope,
  wholeCollection,
  type CollectionEnvelope,
  type ItemEnvelope,
} from "./envelope.js";
import { raise } from "./fault.js";
import {
  authenticateOperator,
  authorizeVault,
  requireSecrets,
  type InboundOperatorRequest,
} from "./operator.js";
import { instant } from "./resources.js";
import { requestInvalid } from "./transport-errors.js";

export interface EnvironmentVariableResource {
  readonly id: string;
  readonly key: string;
  /** `PLAIN` or `SECRET`. */
  readonly kind: string;
  /** A PLAIN variable's value; ALWAYS null for a SECRET one. */
  readonly value: string | null;
  readonly hasSecret: boolean;
  readonly version: number;
  readonly lastUpdatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a caller sends. `value` becomes `SecretMaterial` before anything else happens. */
export interface SetEnvironmentVariableBody {
  readonly value: string;
  /** True stores the value behind a credential and never shows it again. False when absent. */
  readonly secret?: boolean;
}

/** SHAPE ONLY: `value` a string, `secret` a boolean when present. */
export const setEnvironmentVariableValidator = (input: unknown): Result<SetEnvironmentVariableBody> => {
  const body = jsonBody(input);
  if (!body.ok) return body;
  const violations: FieldViolation[] = [];
  const value = body.value["value"];
  if (typeof value !== "string") {
    violations.push({
      field: "body.value",
      code: value === undefined || value === null ? "required" : "not_a_string",
      message: "value is required and must be a string.",
    });
  }
  const secret = body.value["secret"];
  if (secret !== undefined && typeof secret !== "boolean") {
    violations.push({ field: "body.secret", code: "not_a_boolean", message: "secret must be true or false." });
  }
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({ value: value as string, ...(secret === undefined ? {} : { secret: secret as boolean }) });
};

const SET_PIPE = new DomainValidationPipe(setEnvironmentVariableValidator);

export function environmentVariableResource(row: EnvironmentVariableMetadata): EnvironmentVariableResource {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    value: row.value,
    hasSecret: row.hasSecret,
    version: row.version,
    lastUpdatedBy: row.lastUpdatedBy,
    createdAt: instant(row.createdAt),
    updatedAt: instant(row.updatedAt),
  };
}

@Controller({ path: "environments/:environmentId/variables", version: API_VERSION })
export class EnvironmentVariablesController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Get()
  async list(
    @Req() request: InboundOperatorRequest,
    @Param("environmentId") environmentId: string,
    @Query(UNPAGED_QUERY_PIPE) _page: null,
  ): Promise<CollectionEnvelope<EnvironmentVariableResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const grant = await authorizeVault(app, operator, environmentId, "metadata");
    const rows = await requireSecrets(app).listEnvironmentVariables(grant);
    if (!rows.ok) raise(rows.error);
    return collectionEnvelope(wholeCollection(rows.value.map(environmentVariableResource)));
  }

  /**
   * PUT, because the key in the path names the resource and a second identical
   * request leaves the same configuration behind — the oracle's `upsert`. The
   * `version` counter still moves on each write, which is why the idempotency
   * table leaves it `accepted`: a caller who needs one write sends a key.
   */
  @Put(":key")
  @HttpCode(HttpStatus.OK)
  async set(
    @Req() request: InboundOperatorRequest,
    @Param("environmentId") environmentId: string,
    @Param("key") key: string,
    @Body(SET_PIPE) body: SetEnvironmentVariableBody,
  ): Promise<ItemEnvelope<EnvironmentVariableResource>> {
    const material = acceptPlaintext(body.value);
    if (!material.ok) raise(material.error);
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const grant = await authorizeVault(app, operator, environmentId, "secret:mutate");
    const written = await requireSecrets(app).setEnvironmentVariable({
      authorization: grant,
      key,
      value: material.value,
      secret: body.secret ?? false,
    });
    if (!written.ok) raise(written.error);
    return itemEnvelope(environmentVariableResource(written.value));
  }
}
