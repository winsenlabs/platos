import { describe, expect, it } from "vitest";
import { ProviderRuntimeError, asSafeProviderRuntimeError } from "./provider-runtime.error";

describe("ProviderRuntimeError", () => {
  it("serializes to a stable safe shape without upstream detail", () => {
    const detail = "sentinel-secret Prisma AES-GCM upstream response";
    const error = asSafeProviderRuntimeError(new Error(detail));

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "ProviderRuntimeError",
      code: "provider_request_failed",
      message: "Provider request failed.",
    });
    expect(JSON.stringify(error)).not.toContain(detail);
  });

  it("preserves an existing stable provider code", () => {
    const error = new ProviderRuntimeError("provider_credential_unavailable");

    expect(asSafeProviderRuntimeError(error)).toBe(error);
  });
});
