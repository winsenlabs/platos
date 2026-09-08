// WIN-267 T4 — THE FIRST BUSINESS ROUTE `apps/core-api` SERVES.
//
// One operation: `POST /api/v1/agent/channels/:id/rotate-secret`, which
// `http/idempotency-policy.ts` classes `required` and describes as
// "wire-secret — rotates a channel's webhook secret and returns the new value
// once". Until now the gate in front of it reserved an idempotency key, admitted
// the winner of the race, and handed it to `NotFoundController` — and
// `settlementFor` then RECORDED that 404, so every honest retry of that key was
// answered with it for twenty-four hours.
//
// THE FILE HOLDS NO RULE, which is ADR M0.3 §6's budget for a transport spent
// the way T2's chassis intends. `transports/rest/secret-mint.ts` is the mint;
// this reads the path parameter and the credential off the request, calls it,
// and turns the two possible answers into the two shapes the envelope has.
// Every branch of the mint is reachable in `secret-mint.test.ts` with no socket.
//
// IT IS NOT `@Controller("api/v1/agent/channels")`. `runtime/lifecycle.ts`
// installs URI versioning with the prefix `api/v`, so the path below is
// `agent/channels` plus `@Version("1")` under that prefix — the same separation
// T2 put into `apps/agent` when it deleted twenty-four `api/v1` literals. A
// literal here would be the twenty-fifth, in the process that exists to replace
// them.
//
// THE HANDLER RETURNS THE ITEM ENVELOPE AND NOT A BARE OBJECT. M0.4 §2 fixes
// `{data, meta:{contractVersion}}` for a single resource, and a mint is a single
// resource. A route that answered its own shape would be the first of three
// hundred to do so.
//
// WHY IT DOES NOT RE-CHECK THE IDEMPOTENCY KEY. The gate already refused a
// keyless request before routing — `classifyRequest` reads this exact template
// out of the policy table — so a handler that checked again would be a second
// implementation of a contract that already has one, and the two would
// eventually disagree. What the handler owes the gate is that its response is
// REPLAYABLE, which it is: the material is in the body, the body is under
// `MAX_REPLAYABLE_BODY_BYTES`, and the status is below 500 on every path that
// actually rotated.

import { Controller, Headers, Inject, Param, Post, Version } from "@nestjs/common";

import type { AppModule } from "../app.module.js";
import { API_VERSION } from "./api-surface.js";
import { itemEnvelope, type ItemEnvelope } from "../transports/rest/envelope.js";
import { raise } from "../transports/rest/fault.js";
import { requestInvalid } from "../transports/rest/transport-errors.js";
import {
  rotateChannelWebhookSecret,
  type MintedChannelSecret,
} from "../transports/rest/secret-mint.js";

/**
 * What a channel connection id may look like.
 *
 * The SAME shape the frozen surface accepts for an identifier segment, and it is
 * validated HERE rather than left to the vault because the value is
 * interpolated into a credential name. Nothing downstream parses that name — see
 * `channelWebhookCredentialName` — but a route that passed an arbitrary string
 * into a namespace would be relying on that fact staying true forever.
 */
const CHANNEL_CONNECTION_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/** The bearer credential, or null. A repeated header is not a credential. */
function bearer(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/u.exec(header.trim());
  return match?.[1] ?? null;
}

export const SECRET_MINT_DEPENDENCIES = Symbol("platos.core-api.secret-mint-dependencies");

/**
 * The application this controller reads the system through.
 *
 * A wrapper rather than the `AppModule` itself, for the reason
 * `HealthDependencies` is one: the module provides a VALUE, and a value that is
 * the application would make every future provider in this module the same
 * token.
 */
export interface SecretMintDependencies {
  readonly app: AppModule;
}

@Controller("agent/channels")
export class SecretMintController {
  // `@Inject` AND NOT A BARE TYPED PARAMETER. `SecretMintDependencies` is an
  // INTERFACE: it is erased at run time, so the metadata Nest reflects for this
  // parameter is `undefined` and the container has nothing to look up. Without
  // the token the framework throws "can't resolve dependencies of the
  // SecretMintController (?)" during `NestFactory.create` — and because
  // `lifecycle.ts` creates the app with `logger: false`, that throw reached the
  // operator as an exit code and an empty stderr. `HealthController` names its
  // token for the same reason; this one now does too, and `process.test.ts`
  // fails if it stops.
  constructor(
    @Inject(SECRET_MINT_DEPENDENCIES) private readonly dependencies: SecretMintDependencies,
  ) {}

  @Version(API_VERSION)
  @Post(":id/rotate-secret")
  async rotateWebhookSecret(
    @Param("id") id: string,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<ItemEnvelope<MintedChannelSecret>> {
    if (!CHANNEL_CONNECTION_ID.test(id)) {
      raise(
        requestInvalid([
          {
            field: "id",
            code: "malformed",
            // The SHAPE, never the value. The id came off the URL and is
            // attacker-controlled; `transports/rest/transport-errors.ts` states
            // at length why a refusal must not echo one back.
            message: "A channel connection id is 1-64 characters of [A-Za-z0-9_-].",
          },
        ]),
      );
    }
    const app = this.dependencies.app;
    const minted = await rotateChannelWebhookSecret(
      {
        identityAccess: app.contexts.identityAccess,
        tenancy: app.contexts.tenancy,
        secrets: app.contexts.secrets,
      },
      { channelConnectionId: id, presentedToken: bearer(authorization) },
    );
    if (!minted.ok) raise(minted.error);
    return itemEnvelope(minted.value);
  }
}
