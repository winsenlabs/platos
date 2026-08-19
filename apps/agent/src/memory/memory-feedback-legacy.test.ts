import { describe, expect, it } from "vitest";
import { legacyFeedbackMetadataState } from "./memory-feedback-legacy";

describe("legacy memory feedback metadata filtering", () => {
  it("blocks plaintext and successfully decrypted negative markers", () => {
    const flagged = { flaggedByRating: { comment: "must not leak" } };
    expect(legacyFeedbackMetadataState(flagged, flagged)).toEqual({
      blocksRecall: true,
      decryptUnavailable: false,
      flagged: true,
    });
    expect(
      legacyFeedbackMetadataState({ __platos_enc: 1, v: 1, ct: "ciphertext" }, flagged).blocksRecall
    ).toBe(true);
  });

  it("fails closed for an envelope that cannot be decrypted", () => {
    const envelope = { __platos_enc: 1, v: 4, error: "decryption_key_missing" };
    expect(legacyFeedbackMetadataState(envelope, envelope)).toEqual({
      blocksRecall: true,
      decryptUnavailable: true,
      flagged: false,
    });
  });

  it("allows plaintext and decrypted metadata without the legacy marker", () => {
    expect(legacyFeedbackMetadataState({ source: "plain" }, { source: "plain" }).blocksRecall).toBe(
      false
    );
    expect(
      legacyFeedbackMetadataState(
        { __platos_enc: 1, v: 1, ct: "ciphertext" },
        { source: "decrypted" }
      ).blocksRecall
    ).toBe(false);
  });
});
