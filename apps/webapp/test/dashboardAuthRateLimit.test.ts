import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authEmailRateLimitIdentifier,
  authSessionRateLimitIdentifier,
} from "../app/services/dashboardAuthRateLimit.server";

describe("dashboard auth rate-limit identity", () => {
  it("uses only normalized email even when the request carries an arbitrary single XFF", () => {
    const request = new Request("https://dashboard.example/login", {
      headers: { "x-forwarded-for": "arbitrary-caller-value" },
    });

    expect(request.headers.get("x-forwarded-for")).toBe("arbitrary-caller-value");
    expect(authEmailRateLimitIdentifier(" Operator@Example.com ")).toBe(
      "email:operator@example.com"
    );
    expect(authEmailRateLimitIdentifier("operator@example.com")).toBe(
      authEmailRateLimitIdentifier(" Operator@Example.com ")
    );
  });

  it("uses a domain-prefixed SHA-256 session digest without exposing the opaque token", () => {
    const token = "plt_os_non-secret-test-token";
    const digest = createHash("sha256")
      .update("platos-auth-rate-limit:operator-session\0")
      .update(token)
      .digest("hex");

    const identifier = authSessionRateLimitIdentifier(token);
    expect(identifier).toBe(`operator-session:${digest}`);
    expect(identifier).not.toContain(token);
    expect(identifier).toBe(authSessionRateLimitIdentifier(token));
    expect(identifier).not.toBe(authSessionRateLimitIdentifier(`${token}-other`));
  });
});
