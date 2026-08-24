import { describe, expect, it } from "vitest";

import { decodeSessionToken, mintSessionToken } from "./index.js";

const claims = {
  organizationId: "org_1",
  projectId: "project_1",
  environmentId: "environment_1",
  userId: "user_1",
  entityId: "entity_1",
};

describe("entity session tokens", () => {
  it("mints an entity-scoped token signed by its serviceSecret", () => {
    const secret = "entity-service-secret-at-least-16";
    const token = mintSessionToken({
      serviceSecret: secret,
      claims,
      iatSeconds: 100,
      ttlSeconds: 60,
    });
    const decoded = decodeSessionToken(token, secret);
    expect(decoded.signatureValid).toBe(true);
    expect(decoded.payload).toMatchObject({ ...claims, iat: 100, exp: 160 });
  });

  it("rejects missing entity scope", () => {
    expect(() => mintSessionToken({
      serviceSecret: "entity-service-secret-at-least-16",
      claims: { ...claims, entityId: "" },
    })).toThrow(/entityId/);

    expect(() => mintSessionToken({
      serviceSecret: "entity-service-secret-at-least-16",
      claims: { ...claims, entityId: "   " },
    })).toThrow(/entityId/);
  });

  it("does not validate against a different Entity secret", () => {
    const token = mintSessionToken({
      serviceSecret: "entity-service-secret-at-least-16",
      claims,
    });
    expect(decodeSessionToken(token, "different-entity-secret-12345").signatureValid).toBe(false);
  });
});
