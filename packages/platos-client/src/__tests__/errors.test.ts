/**
 * Unit tests for the error hierarchy + `errorFromResponse` factory.
 *
 * No network calls — we build minimal `Response` doubles to exercise
 * the status-to-class mapping and the retry-after parsing path.
 */

import { describe, expect, it } from "vitest";
import {
  PlatosAuthError,
  PlatosError,
  PlatosNetworkError,
  PlatosNotFoundError,
  PlatosRateLimitError,
  PlatosServerError,
  PlatosValidationError,
  errorFromResponse,
  isRetryableError,
} from "../errors.js";

function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const resHeaders = new Headers(headers);
  return new Response(bodyStr, { status, headers: resHeaders });
}

describe("error hierarchy", () => {
  it("PlatosAuthError covers 401 + 403", async () => {
    const e401 = await errorFromResponse(mockResponse(401, { message: "expired" }));
    const e403 = await errorFromResponse(mockResponse(403, { message: "forbidden" }));
    expect(e401).toBeInstanceOf(PlatosAuthError);
    expect(e403).toBeInstanceOf(PlatosAuthError);
    expect(e401).toBeInstanceOf(PlatosError);
    expect(e401.status).toBe(401);
  });

  it("PlatosNotFoundError for 404", async () => {
    const err = await errorFromResponse(mockResponse(404, { message: "missing" }));
    expect(err).toBeInstanceOf(PlatosNotFoundError);
    expect(err.status).toBe(404);
  });

  it("PlatosValidationError extracts validationErrors array", async () => {
    const err = await errorFromResponse(
      mockResponse(422, { message: "bad", validationErrors: ["name required", "email invalid"] }),
    );
    expect(err).toBeInstanceOf(PlatosValidationError);
    if (err instanceof PlatosValidationError) {
      expect(err.validationErrors).toEqual(["name required", "email invalid"]);
    }
  });

  it("PlatosRateLimitError parses Retry-After header", async () => {
    const err = await errorFromResponse(
      mockResponse(429, { message: "slow down" }, { "retry-after": "2" }),
    );
    expect(err).toBeInstanceOf(PlatosRateLimitError);
    if (err instanceof PlatosRateLimitError) {
      expect(err.retryAfterMs).toBe(2000);
    }
  });

  it("PlatosServerError for 5xx", async () => {
    const err = await errorFromResponse(mockResponse(503, "maintenance"));
    expect(err).toBeInstanceOf(PlatosServerError);
  });

  it("falls back to PlatosError for unknown status codes", async () => {
    const err = await errorFromResponse(mockResponse(418, { message: "teapot" }));
    expect(err).toBeInstanceOf(PlatosError);
    expect(err).not.toBeInstanceOf(PlatosServerError);
  });
});

describe("isRetryableError", () => {
  it("retries network / server / rate-limit", () => {
    expect(isRetryableError(new PlatosNetworkError(new Error("x")))).toBe(true);
    expect(isRetryableError(new PlatosServerError(500, "x"))).toBe(true);
    expect(isRetryableError(new PlatosRateLimitError("x", 1000))).toBe(true);
  });
  it("does NOT retry 4xx auth / validation / not-found", () => {
    expect(isRetryableError(new PlatosAuthError(401, "x"))).toBe(false);
    expect(isRetryableError(new PlatosValidationError(422, "x", []))).toBe(false);
    expect(isRetryableError(new PlatosNotFoundError("x"))).toBe(false);
  });
});
