// GET /api/v1/identity/session — WHO AM I.
//
// The first identity route in V1, and the one that proves the rest are possible.
// Three tranches of REST work were refused because `identity-access` could not be
// composed, so a route could only ever answer 503; this route is the shortest
// path from an HTTP request to a composed contract's answer, and
// `identity-rest.integration.test.ts` drives it end to end against a real
// PostgreSQL with a real session row.
//
// IT IS A READ AND IT MUTATES ONE THING, WHICH IS THE CONTRACT'S DOING AND NOT
// THIS ROUTE'S. `authenticateOperator` stamps `lastSeenAt` on a session that
// authenticates, deliberately AFTER the decision so a failed authentication cannot be
// used to confirm a token exists by watching a timestamp move. That is why the
// verb is GET and there is no `Idempotency-Key` question to answer: the write is
// the context's liveness stamp, it is idempotent within a clock tick, and the
// route commands nothing.
//
// WHAT IS NOT ON THE WIRE. `OperatorAuthorizationView` is already the contract's
// flattened projection rather than a session record, and this file narrows it once
// more into a DECLARED DTO. ADR M0.4 D7 asks new V1 contexts to be "born with
// schemas so the breaking-change guard actually guards fields"; a handler that
// returned the view object directly would publish every field a future contract
// change added, silently, and `additive-only` would stop being a decision anybody
// made.

import { Controller, Get, Inject, Req } from "@nestjs/common";

import { API_VERSION } from "../../http/api-surface.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import { itemEnvelope, type ItemEnvelope } from "./envelope.js";
import { operatorSessionResource, type OperatorSessionResource } from "./resources.js";
import { authenticateOperator, type InboundOperatorRequest } from "./operator.js";

@Controller({ path: "identity", version: API_VERSION })
export class IdentitySessionController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Get("session")
  async session(
    @Req() request: InboundOperatorRequest,
  ): Promise<ItemEnvelope<OperatorSessionResource>> {
    const operator = await authenticateOperator(this.application.app, request);
    return itemEnvelope(operatorSessionResource(operator));
  }
}
