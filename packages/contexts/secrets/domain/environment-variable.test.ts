import { asIdentifier } from "@platos/kernel";
import type { EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_VARIABLE_METADATA_FIELDS,
  ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH,
  environmentVariableKey,
  environmentVariableValue,
  toEnvironmentVariableMetadata,
} from "./environment-variable.js";
import type { EnvironmentVariable } from "./environment-variable.js";
import { asSecretsIdentifier } from "./ids.js";
import type { CredentialId, EnvironmentVariableId } from "./ids.js";

const at = new Date("2026-01-01T00:00:00.000Z");

function variable(overrides: Partial<EnvironmentVariable> = {}): EnvironmentVariable {
  return {
    id: asSecretsIdentifier<EnvironmentVariableId>("var-1"),
    environmentId: asIdentifier<EnvironmentId>("env-1"),
    key: "OPENAI_API_KEY",
    kind: "PLAIN",
    value: "plain-value",
    credentialId: null,
    version: 1,
    lastUpdatedBy: "user-1",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe("keys and values are validated before anything is stored", () => {
  it("accepts shouting snake case and trims surrounding space", () => {
    const accepted = environmentVariableKey("  OPENAI_API_KEY  ");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value).toBe("OPENAI_API_KEY");
  });

  it.each(["lowercase", "1LEADING_DIGIT", "HAS-HYPHEN", "", "A".repeat(65)])(
    "refuses %s",
    (candidate) => {
      const refused = environmentVariableKey(candidate);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("ENVIRONMENT_VARIABLE_KEY_INVALID");
    },
  );

  it("refuses an empty value and one past the maximum", () => {
    expect(environmentVariableValue("").ok).toBe(false);
    expect(environmentVariableValue("x".repeat(ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH)).ok).toBe(true);
    const tooLong = environmentVariableValue("x".repeat(ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH + 1));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error.code).toBe("ENVIRONMENT_VARIABLE_VALUE_TOO_LONG");
  });
});

describe("a SECRET variable reads back no value at all", () => {
  it("passes a PLAIN value through", () => {
    const projected = toEnvironmentVariableMetadata(variable());
    expect(projected.value).toBe("plain-value");
    expect(projected.hasSecret).toBe(false);
  });

  it("withholds the value of a SECRET variable even if a row somehow carries one", () => {
    const projected = toEnvironmentVariableMetadata(
      variable({
        kind: "SECRET",
        value: "leaked-into-the-row",
        credentialId: asSecretsIdentifier<CredentialId>("cred-1"),
      }),
    );
    expect(projected.value).toBeNull();
    expect(projected.hasSecret).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("leaked-into-the-row");
  });

  it("reports no secret when a SECRET row has lost its credential", () => {
    expect(toEnvironmentVariableMetadata(variable({ kind: "SECRET" })).hasSecret).toBe(false);
  });

  it("exposes exactly the enumerated fields", () => {
    expect(Object.keys(toEnvironmentVariableMetadata(variable()))).toEqual([
      ...ENVIRONMENT_VARIABLE_METADATA_FIELDS,
    ]);
  });
});
