// Screen a destination before it is allowed to persist.
//
// Shared by registration and update, which is the point: the legacy service
// duplicates the same six lines in `registerRule` and `updateRule`, and a
// duplicated security check is one edit away from being a security check in only
// one place.
//
// THREE OUTCOMES, KEPT DISTINCT:
//
//   not a network destination -> admitted without asking. An email address and a
//     PagerDuty key are never fetched by this system, so screening them would be
//     a category error. The legacy branch is `type === "slack" || "webhook"`;
//     here it is `isNetworkDestination`.
//   screened and refused      -> EVENTING_RULE_DESTINATION_REJECTED (`forbidden`).
//   screen could not decide   -> EVENTING_SCREEN_UNAVAILABLE (`unavailable`).
//
// The last two must not be merged. Failing OPEN when the resolver is down would
// let an operator persist a rule pointing at link-local space simply by
// retrying during an outage, which is the whole vulnerability the screen exists
// to close. So an undecidable screen REFUSES the write.

import { err, ok, type Result } from "@platos/kernel";

import {
  isNetworkDestination,
  ruleDestinationRejected,
  screenUnavailable,
  type Destination,
} from "../domain/index.js";
import type { DestinationScreen } from "./ports/index.js";

export async function screenDestination(
  screen: DestinationScreen,
  destination: Destination,
): Promise<Result<Destination>> {
  if (!isNetworkDestination(destination)) return ok(destination);
  const screened = await screen.screen(destination.url);
  if (!screened.ok) return err(screenUnavailable(screened.error.message));
  if (!screened.value.admitted) {
    return err(ruleDestinationRejected(screened.value.reason ?? "destination is not publicly reachable"));
  }
  return ok(destination);
}
