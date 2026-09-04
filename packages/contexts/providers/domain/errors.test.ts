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
  errors.promptEmpty(),
  errors.promptContentEmpty("user"),
  errors.mediaTypeMissing("user", "image"),
  errors.toolCallDuplicated("call-1"),
  errors.toolResultUnmatched("call-1", "search"),
  errors.toolNameDuplicated("search"),
  errors.cacheBudgetExceeded(5, 4),
  errors.stepBudgetInvalid(0),
  errors.modelSessionExpired("session-1", "2026-01-01T00:00:00.000Z"),
  errors.structuredOutputInvalid("no parseable object", 2),
  errors.retryPolicyInvalid("retryCount must be a whole number", "retryCount", -1),
  errors.serviceAccountInvalid("credential is not JSON", "google-vertex"),
  errors.outputSchemaInvalid("unknown keyword"),
  errors.toolExecutorFailed("search", "boom"),
  errors.generationAborted("caller signalled abort"),
  errors.messageNotRepresentable("system", "image"),
  errors.passBudgetInvalid(0),
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

  it("keeps the adapter's seven apart from each other and from the codes they resemble", () => {
    // The rule this pins: two guards returning one code cannot be told apart.
    // Each pair below is a pair a reader would otherwise be tempted to merge.
    expect(errors.outputSchemaInvalid("bad").code).not.toBe(
      errors.structuredOutputInvalid("bad", 1).code,
    );
    expect(errors.serviceAccountInvalid("bad", "google-vertex").code).not.toBe(
      errors.providerCredentialUnavailable("bad").code,
    );
    expect(errors.generationAborted("stopped").code).not.toBe(
      errors.providerRequestFailed("down").code,
    );
    expect(errors.toolExecutorFailed("t", "boom").category).toBe("internal");
    expect(errors.generationAborted("stopped").category).toBe("precondition_failed");
    expect(errors.retryPolicyInvalid("bad", "retryCount", -1).category).toBe("invalid_input");
    expect(errors.messageNotRepresentable("system", "image").code).not.toBe(
      errors.mediaTypeMissing("system", "image").code,
    );
    expect(errors.passBudgetInvalid(0).code).not.toBe(errors.stepBudgetInvalid(0).code);
  });

  it("carries the pinned-agent count the control surface renders", () => {
    expect(errors.providerKeyPinnedByAgents("k", 3).details.pinnedAgents).toBe(3);
  });

  it("gives every retryable failure a retry hint", () => {
    expect(errors.providerRequestFailed("down").retryAfterSeconds).toBe(5);
    expect(errors.repositoryUnavailable("down").retryAfterSeconds).toBe(5);
  });
});
