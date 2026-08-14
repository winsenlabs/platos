import { describe, expect, test } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateTotp,
  hashSecret,
  operatorSessionCookie,
} from "./auth";

describe("Platos auth primitives", () => {
  test("hashes secrets deterministically without retaining plaintext", () => {
    expect(hashSecret("raw-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSecret("raw-token")).toBe(hashSecret("raw-token"));
    expect(hashSecret("raw-token")).not.toContain("raw-token");
  });

  test("encrypts recoverable TOTP secrets with authenticated encryption", () => {
    const key = "0123456789abcdef0123456789abcdef";
    const encrypted = encryptSecret("JBSWY3DPEHPK3PXP", key);

    expect(encrypted).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(encrypted, key)).toBe("JBSWY3DPEHPK3PXP");
    const replacement = encrypted.endsWith("A") ? "B" : "A";
    expect(() => decryptSecret(`${encrypted.slice(0, -1)}${replacement}`, key)).toThrow();
  });

  test("implements the RFC 6238 SHA-1 six-digit TOTP semantics", () => {
    // RFC 6238 secret "12345678901234567890" in base32. The RFC's eight-digit
    // result at 59 seconds is 94287082, whose six-digit truncation is 287082.
    expect(generateTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", new Date(59_000))).toBe("287082");
  });

  test("stores only the raw opaque token in the operator cookie", () => {
    const cookie = operatorSessionCookie("plt_os_raw-token");
    expect(cookie).toContain("__Host-platos_operator_session=plt_os_raw-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toMatch(/user(Id)?=/i);
    expect(cookie).not.toMatch(/organization(Id)?=/i);
  });
});
