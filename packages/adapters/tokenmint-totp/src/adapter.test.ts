// The object the composition root wires, as opposed to the two it is made of.
//
// WHAT THIS SUITE IS FOR AND WHAT IT IS NOT FOR. The algorithms are proved in
// `rfc-vectors.test.ts`, `oracle-totp-differential.test.ts` and
// `oracle-mint-widths.test.ts`; repeating any of that here would be volume
// without evidence. What is only checkable at THIS level is the assembly: that
// both ports are actually present on one object, that they are the same
// implementations the two factories publish, and that the minter's secret and the
// verifier's decoder are the SAME alphabet — which is the entire argument for
// these two ports sharing a directory, and would otherwise be a claim in a
// comment.

import { describe, expect, it } from "vitest";

import { createTokenmintTotpAdapter } from "./adapter.js";

const adapter = createTokenmintTotpAdapter();

describe("one object carries both ports", () => {
  it("names itself after its directory, as every adapter in the layout does", () => {
    expect(adapter.adapterName).toBe("tokenmint-totp");
  });

  it("carries every method TokenMinter declares", () => {
    expect(typeof adapter.mint).toBe("function");
    expect(typeof adapter.mintTotpSecret).toBe("function");
    expect(typeof adapter.mintRecoveryCodes).toBe("function");
  });

  it("carries every method TotpCodeVerifier declares", () => {
    expect(typeof adapter.verify).toBe("function");
    expect(typeof adapter.generate).toBe("function");
  });

  it("builds a fresh, independent object on each call", () => {
    // No module-level singleton and no shared state: two installs in one process
    // — which is what the test suite itself is — must not be able to influence
    // each other's randomness.
    expect(createTokenmintTotpAdapter()).not.toBe(adapter);
  });
});

describe("the minted secret and the verifier read the same alphabet", () => {
  it("verifies a code generated for a secret this adapter just minted", () => {
    // THE WHOLE REASON THESE TWO PORTS SHARE A DIRECTORY, in one case. Split the
    // base32 encoder and decoder across two packages and this is the assertion
    // that stops holding — and it stops holding on a real phone at enrolment
    // time, not here.
    const secret = adapter.mintTotpSecret();
    const code = adapter.generate(secret, 4242n);
    expect(adapter.verify({ secret, code, candidateCounters: [4241n, 4242n, 4243n] })).toBe(4242n);
  });

  it("refuses that code one counter outside the window it was generated for", () => {
    // The negative control: without it, a `verify` that accepted everything
    // would satisfy the case above.
    const secret = adapter.mintTotpSecret();
    const code = adapter.generate(secret, 4242n);
    expect(adapter.verify({ secret, code, candidateCounters: [4243n, 4244n, 4245n] })).toBeNull();
  });

  it("verifies across a hundred freshly minted secrets", () => {
    // ONE CASE OVER A HUNDRED SECRETS, not a hundred cases. A base32 encoder
    // whose trailing group was wrong would round-trip MOST twenty-byte inputs and
    // fail a minority, so a single fixed secret is not enough to see it.
    for (let index = 0; index < 100; index += 1) {
      const secret = adapter.mintTotpSecret();
      const counter = BigInt(1_000_000 + index);
      const code = adapter.generate(secret, counter);
      expect(adapter.verify({ secret, code, candidateCounters: [counter] }), secret).toBe(counter);
    }
  });
});
