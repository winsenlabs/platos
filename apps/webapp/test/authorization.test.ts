import { describe, expect, it } from "vitest";
import { checkAuthorization, type AuthorizationEntity } from "../app/services/authorization.server";

const DOCS_URL = "https://github.com/platos-dev/platos#frontend-authentication";

describe("checkAuthorization", () => {
  it("allows private credentials", () => {
    const result = checkAuthorization({ type: "PRIVATE" }, "read", {
      prompts: "prompt_1234",
    });

    expect(result).toEqual({ authorized: true });
  });

  it("denies deprecated public credentials", () => {
    const result = checkAuthorization({ type: "PUBLIC" }, "read", {
      prompts: "prompt_1234",
    });

    expect(result).toEqual({
      authorized: false,
      reason: "PUBLIC type is deprecated and has no access",
    });
  });

  it("allows a public access token with a prompt-specific scope", () => {
    const entity: AuthorizationEntity = {
      type: "PUBLIC_JWT",
      scopes: ["read:prompts:prompt_1234"],
    };

    expect(checkAuthorization(entity, "read", { prompts: "prompt_1234" })).toEqual({
      authorized: true,
    });
  });

  it("allows a public access token with a general prompt scope", () => {
    const entity: AuthorizationEntity = {
      type: "PUBLIC_JWT",
      scopes: ["read:prompts"],
    };

    expect(
      checkAuthorization(entity, "read", {
        prompts: ["prompt_1234", "prompt_5678"],
      })
    ).toEqual({ authorized: true });
  });

  it("denies a public access token for a prompt outside its scope", () => {
    const entity: AuthorizationEntity = {
      type: "PUBLIC_JWT",
      scopes: ["read:prompts:prompt_1234"],
    };

    expect(checkAuthorization(entity, "read", { prompts: "prompt_5678" })).toEqual({
      authorized: false,
      reason:
        `Public Access Token is missing required permissions. Token has the following permissions: ` +
        `'read:prompts:prompt_1234'. See ${DOCS_URL} for more information.`,
    });
  });

  it("denies a public access token without scopes", () => {
    expect(
      checkAuthorization({ type: "PUBLIC_JWT" }, "read", {
        prompts: "prompt_1234",
      })
    ).toEqual({
      authorized: false,
      reason: `Public Access Token has no permissions. See ${DOCS_URL} for more information.`,
    });
  });

  it("denies an empty resource object", () => {
    expect(
      checkAuthorization({ type: "PUBLIC_JWT", scopes: ["read:prompts"] }, "read", {})
    ).toEqual({ authorized: false, reason: "Resource object is empty" });
  });

  it("does not authorize removed hosted resource families", () => {
    const entity: AuthorizationEntity = {
      type: "PUBLIC_JWT",
      scopes: ["read:runs"],
    };

    expect(
      checkAuthorization(entity, "read", {
        // @ts-expect-error Runs are no longer a supported webapp authorization resource.
        runs: "run_1234",
      })
    ).toEqual({
      authorized: false,
      reason:
        `Public Access Token is missing required permissions. Token has the following permissions: ` +
        `'read:runs'. See ${DOCS_URL} for more information.`,
    });
  });

  it("allows a matching explicit super scope", () => {
    const entity: AuthorizationEntity = {
      type: "PUBLIC_JWT",
      scopes: ["read:all"],
    };

    expect(
      checkAuthorization(entity, "read", { prompts: "prompt_1234" }, ["read:all", "admin"])
    ).toEqual({ authorized: true });
  });

  it("falls back to a prompt scope when no explicit super scope matches", () => {
    const entity: AuthorizationEntity = {
      type: "PUBLIC_JWT",
      scopes: ["read:prompts"],
    };

    expect(
      checkAuthorization(entity, "read", { prompts: "prompt_1234" }, ["read:all", "admin"])
    ).toEqual({ authorized: true });
  });
});
