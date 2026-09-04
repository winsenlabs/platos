// Liveness: the smallest live call that proves a credential is accepted.
//
// THE FOUR OUTCOMES ARE NOT A SEVERITY SCALE. `domain/health.ts` is explicit
// about it, and the distinction this file has to get right is the expensive one:
//
//   auth_refused    the provider judged the credential and said no. This, and
//                   only this, condemns a key. The operator rotates it.
//   request_failed  the call did not complete. It says NOTHING about the key.
//
// Collapsing the two sends an operator to rotate a perfectly good key because a
// provider had an outage, which is why the classification is a named predicate
// handed in rather than an inline status comparison.
//
// A REFUSAL IS `ok` WITH A FAILURE TOKEN, NOT `err`. The port says so: a
// provider that answered and refused IS the outcome, and the health report
// renders it. `err` is reserved for a call that could not be attributed to the
// provider at all — which, at this layer, means the route could not be built.
//
// THE CALL IS THE CHEAPEST ONE THAT STILL EXERCISES INFERENCE. One token, one
// short prompt, against the catalogue's own probe model. It goes through the
// same client construction a real turn does, so a route that probes healthy is a
// route that can actually serve.

import {
  ok,
  type ProbeModelRequest,
  type ProbeOutcome,
  type Result,
} from "@platos/context-providers/application/ports/index.js";
import { generateText, type LanguageModel } from "ai";

import { SINGLE_RETRY_LAYER } from "./call.js";

/** The prompt. Short on purpose: a probe that costs real tokens is a tax. */
export const PROBE_PROMPT = "ping";

/** The output budget. One token is enough to prove the credential was taken. */
export const PROBE_MAX_OUTPUT_TOKENS = 1;

export async function probeModel(
  request: ProbeModelRequest,
  model: LanguageModel,
  isAuthRefusal: (thrown: unknown) => boolean,
): Promise<Result<ProbeOutcome>> {
  const named = request.plan.reference.modelName;
  const deadline = new AbortController();
  // The port says the adapter MUST abandon the call at the budget. A timeout
  // that only bounds the connect leg is not a budget for the whole call, which
  // is what a health check needs: a provider that accepts a connection and never
  // answers is exactly the outage this is looking for.
  const timer = setTimeout(() => deadline.abort(), request.timeoutMs);
  try {
    await generateText({
      model,
      prompt: PROBE_PROMPT,
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      abortSignal: deadline.signal,
      // The transport already carries this installation's retry policy. Letting
      // the framework retry as well would make a health check take three times
      // as long as its own budget says it may, on the one call whose whole point
      // is to answer inside that budget.
      ...SINGLE_RETRY_LAYER,
    });
    return ok({ failure: null, model: named });
  } catch (thrown) {
    return ok({ failure: isAuthRefusal(thrown) ? "auth_refused" : "request_failed", model: named });
  } finally {
    clearTimeout(timer);
  }
}
