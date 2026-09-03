import { describe, expect, it } from "vitest";

import * as errors from "./errors.js";
import { PROVIDERS_ERROR_CODES } from "./errors.js";

const SAMPLES = [
  errors.unknownProvider("nope"),
  errors.providerKeyNotFound("key-1"),
  errors.providerKeyAlreadyExists("openai", "production"),
  errors.providerKeyPinnedByAgents("key-1", 3),
  errors.providerKeyMetadataInvalid("label is required"),
  errors.credentialUnavailable("OPENAI_API_KEY", "openai"),
  errors.scopeMismatch("org/a", "org/b"),
  errors.configurationUnavailable("no default key"),
  errors.providerCredentialUnavailable("decryption failed"),
  errors.providerRequestFailed("upstream refused"),
  errors.modelStringInvalid("empty", ""),
  errors.modelKeyInvalid("empty"),
  errors.modelRateInvalid("negative"),
  errors.rateCardInvalid("readAt must be a valid instant"),
  errors.modelPricingUnavailable("openai:gpt-4o", "output"),
  errors.priceRevisionConflict("openai/gpt-4o", "2026-01-01T00:00:00.000Z"),
  errors.tokenUsageInvalid("negative"),
  errors.repositoryUnavailable("connection refused"),
];

describe("the catalogue", () => {
  it("mints every declared code and nothing else", () => {
    expect([...SAMPLES.map((error) => error.code)].sort()).toEqual([...PROVIDERS_ERROR_CODES].sort());
  });

  it("declares each code exactly once", () => {
    expect(new Set(PROVIDERS_ERROR_CODES).size).toBe(PROVIDERS_ERROR_CODES.length);
  });

  it("gives every code the SCREAMING_SNAKE form M0.4 §2 fixes, under one prefix", () => {
    for (const code of PROVIDERS_ERROR_CODES) {
      expect(code).toMatch(/^PROVIDERS(_[A-Z0-9]+)+$/u);
    }
  });
});

describe("the runtime surface says nothing a client could use against it", () => {
  const runtime = [
    errors.configurationUnavailable("no default ProviderKey for openai in env-1", {
      provider: "openai",
      environmentId: "env-1",
    }),
    errors.providerCredentialUnavailable("envelope failed to decrypt", { providerKeyId: "key-1" }),
  ];

  it("returns one fixed sentence per code regardless of the reason", () => {
    expect(runtime[0]?.message).toBe("Provider configuration is unavailable for this environment.");
    expect(runtime[1]?.message).toBe("Provider credential is unavailable for this environment.");
  });

  it("keeps the diagnosis in details, which never reaches a client", () => {
    for (const error of runtime) {
      expect(error.message).not.toContain("env-1");
      expect(error.message).not.toContain("key-1");
      expect(typeof error.details.reason).toBe("string");
    }
  });
});

describe("categories carry the meaning a transport maps from", () => {
  it("separates a missing thing from a forbidden one from a clash", () => {
    expect(errors.providerKeyNotFound("k").category).toBe("not_found");
    expect(errors.scopeMismatch("a", "b").category).toBe("forbidden");
    expect(errors.providerKeyAlreadyExists("openai", "l").category).toBe("conflict");
    expect(errors.providerKeyPinnedByAgents("k", 1).category).toBe("conflict");
    expect(errors.providerKeyMetadataInvalid("bad").category).toBe("invalid_input");
    expect(errors.providerRequestFailed("down").category).toBe("unavailable");
  });

  it("separates the control surface's credential miss from the runtime's", () => {
    expect(errors.credentialUnavailable("N", "openai").category).toBe("not_found");
    expect(errors.providerCredentialUnavailable("boom").category).toBe("precondition_failed");
    expect(errors.credentialUnavailable("N", "openai").code).not.toBe(
      errors.providerCredentialUnavailable("boom").code,
    );
  });

  it("carries the pinned-agent count the control surface renders", () => {
    expect(errors.providerKeyPinnedByAgents("k", 3).details.pinnedAgents).toBe(3);
  });

  it("gives every retryable failure a retry hint", () => {
    expect(errors.providerRequestFailed("down").retryAfterSeconds).toBe(5);
    expect(errors.repositoryUnavailable("down").retryAfterSeconds).toBe(5);
  });
});
