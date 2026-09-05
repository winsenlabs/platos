// `InvitationTokenIssuer` — the one port of the five that is provable without a
// database, so it is proved without one.
//
// The three claims that matter are the three a wrong implementation would still
// pass a use-case suite with: the digest is the SHAPE the migrations' CHECK
// demands, `digest` is the same function `mint` used, and the raw token is not
// recoverable from the row. The fourth case is the prefix, and it is here rather
// than left implicit because the constant is restated in this package: it
// imports identity-access's PUBLISHED constant and requires the two to be equal,
// which is what stops a restated value from drifting into a second answer.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { TOKEN_PREFIXES } from "@platos/context-identity-access";

import { INVITATION_TOKEN_PREFIX, createInvitationTokenIssuer } from "./invitation-token.js";

const DIGEST = /^[0-9a-f]{64}$/u;

describe("the invitation token issuer", () => {
  test("mints a digest of the shape OrganizationInvitation_tokenHash_check demands", () => {
    const issuer = createInvitationTokenIssuer();
    for (let attempt = 0; attempt < 64; attempt += 1) {
      // SIXTY-FOUR MINTS, not one. The output is random, and a hex rendering is
      // exactly the encoding whose length is constant — but `base64url` of the
      // same bytes is not, and a single sample would pass under either. This is
      // the case that goes red if somebody changes the encoding.
      expect(String(issuer.mint().digest)).toMatch(DIGEST);
    }
  });

  test("digest is the same function mint used, and is stable", () => {
    const issuer = createInvitationTokenIssuer();
    const minted = issuer.mint();
    expect(issuer.digest(minted.token)).toBe(minted.digest);
    expect(issuer.digest(minted.token)).toBe(issuer.digest(minted.token));
  });

  test("the digest is sha256 of the token, so acceptance can look the row up", () => {
    const issuer = createInvitationTokenIssuer();
    const minted = issuer.mint();
    // Computed independently rather than through the port, so this case would
    // survive the port being rewritten and would fail if the digest became a
    // salted or keyed hash — which would make every already-issued invitation
    // unacceptable after a restart.
    expect(String(minted.digest)).toBe(
      createHash("sha256").update(minted.token, "utf8").digest("hex"),
    );
  });

  test("the raw token is not the digest and does not appear in it", () => {
    const issuer = createInvitationTokenIssuer();
    const minted = issuer.mint();
    expect(String(minted.digest)).not.toBe(minted.token);
    expect(String(minted.digest)).not.toContain(minted.token.slice(INVITATION_TOKEN_PREFIX.length));
  });

  test("two mints differ, in both the token and the digest", () => {
    const issuer = createInvitationTokenIssuer();
    const tokens = new Set<string>();
    const digests = new Set<string>();
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const minted = issuer.mint();
      tokens.add(minted.token);
      digests.add(String(minted.digest));
    }
    expect(tokens.size).toBe(256);
    expect(digests.size).toBe(256);
  });

  test("the prefix is identity-access's published one", () => {
    // The restated constant, checked against the published one. `classifyToken`
    // routes on this prefix, so two answers here would mean an invitation token
    // that no longer classifies as an invitation.
    expect(INVITATION_TOKEN_PREFIX).toBe(TOKEN_PREFIXES.invitation);
    expect(createInvitationTokenIssuer().mint().token.startsWith(INVITATION_TOKEN_PREFIX)).toBe(
      true,
    );
  });

  test("each issuer is independent, so two processes do not repeat each other", () => {
    // The in-memory double counts, so its first mint is `plt_inv_1` in every
    // process that starts one. This port must not: an invitation token that is
    // predictable from a restart is an invitation anybody can accept.
    const one = createInvitationTokenIssuer().mint();
    const other = createInvitationTokenIssuer().mint();
    expect(one.token).not.toBe(other.token);
  });
});
