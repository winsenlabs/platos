// The disposition rule, joined to the ERROR CATALOGUE rather than to itself.
//
// A suite that listed the four codes and asserted the four dispositions would be
// comparing two lists this tranche wrote — the failure lesson 1 names. So the
// left side of every case below comes from `CHANNELS_ERROR_CODES` and from the
// MINT FUNCTIONS in `errors.ts`, which are what an adapter actually calls. Add a
// fifth `CHANNELS_ADAPTER_*` code without teaching the table about it and the
// exhaustiveness case fails; change a mint's code string and the mapping cases
// fail with it.

import { describe, expect, it } from "vitest";

import {
  DELIVERY_DISPOSITIONS,
  DELIVERY_OUTCOME_CODES,
  deliveryDisposition,
  mayRetryDelivery,
} from "./delivery.js";
import {
  CHANNELS_ERROR_CODES,
  adapterRejected,
  adapterUnauthorized,
  adapterUnavailable,
  deliveryIndeterminate,
  repositoryUnavailable,
} from "./errors.js";

describe("every outcome an adapter can report has a disposition", () => {
  it("covers exactly the delivery-outcome codes the catalogue declares", () => {
    // The catalogue's own naming, not a list retyped here: an outcome code is
    // one an adapter mints for a send. `CHANNELS_ADAPTER_*` plus the
    // indeterminate one; the repository and signature codes are not outcomes of
    // a delivery and must NOT be in the table.
    const declared = CHANNELS_ERROR_CODES.filter(
      (code) => code.startsWith("CHANNELS_ADAPTER_") || code === "CHANNELS_DELIVERY_INDETERMINATE",
    );
    expect([...DELIVERY_OUTCOME_CODES].sort()).toEqual([...declared].sort());
  });

  it("maps each mint to the action it permits", () => {
    // The keys come from the MINTS, so a renamed code moves both sides together
    // and a code whose meaning changed without its name does not hide here.
    expect(deliveryDisposition(adapterUnavailable("slack", "down"))).toBe("retry");
    expect(deliveryDisposition(deliveryIndeterminate("slack", "deadline"))).toBe("reconcile");
    expect(deliveryDisposition(adapterUnauthorized("slack", "token_revoked"))).toBe("refuse");
    expect(deliveryDisposition(adapterRejected("slack", "channel_not_found"))).toBe("refuse");
  });

  it("gives exactly one of the three declared dispositions", () => {
    for (const error of [
      adapterUnavailable("slack", "down"),
      deliveryIndeterminate("slack", "deadline"),
      adapterUnauthorized("slack", "dead"),
      adapterRejected("slack", "bad"),
    ]) {
      expect(DELIVERY_DISPOSITIONS).toContain(deliveryDisposition(error));
    }
  });
});

describe("the default is CLOSED, and that direction is the whole point", () => {
  it("sends an unrecognised code to reconcile rather than to retry", () => {
    // A repository failure surfacing through a delivery path is not a code this
    // table was taught. Defaulting it to `retry` would make every future code
    // silently repeatable, and repeating is the only mistake here that
    // duplicates a customer-visible message.
    expect(deliveryDisposition(repositoryUnavailable("pool exhausted"))).toBe("reconcile");
    expect(mayRetryDelivery(repositoryUnavailable("pool exhausted"))).toBe(false);
  });

  it("permits a retry for exactly one code and no other", () => {
    const retryable = CHANNELS_ERROR_CODES.filter((code) =>
      mayRetryDelivery({
        code,
        category: "unavailable",
        message: "",
        fields: [],
        retryAfterSeconds: null,
        details: {},
      }),
    );
    // ONE. If a second code ever becomes retryable it has to be a deliberate
    // edit here, with somebody having thought about whether repeating it can
    // post a message twice.
    expect(retryable).toEqual(["CHANNELS_ADAPTER_UNAVAILABLE"]);
  });
});
