import { describe, expect, it } from "vitest";

import * as errors from "./errors.js";
import { AGENTS_ERROR_CODES } from "./errors.js";

const SAMPLES = [
  errors.agentNotFound("agent-1"),
  errors.agentNotBound("agent-1", "env-1"),
  errors.agentAlreadyExists("proj-1", "support"),
  errors.agentMetadataInvalid("name is required"),
  errors.versionNotFound("agent-1", "version-9"),
  errors.versionInvalid("the active version could not be loaded"),
  errors.canaryAbsent("agent-1"),
  errors.clusterNotFound("cluster-1"),
  errors.clusterAlreadyExists("env-1", "frontline"),
  errors.routeInvalid("label is required"),
  errors.routeNotFound("fast"),
  errors.providerKeyUnavailable("key-1", "openai", "provider-mismatch"),
  errors.skillNotLoaded("version-1", "env-skill-1"),
  errors.macroNotFound("macro-1"),
  errors.macroNotEditable("macro-1"),
  errors.macroInvalid("name is required"),
  errors.macroRecordingUnknown("rec-1"),
  errors.templateNotFound("template-1"),
  errors.templateInvalid("name is required"),
  errors.scopeMismatch("org/a", "org/b"),
  errors.repositoryUnavailable("connection refused"),
];

describe("the catalogue", () => {
  it("mints every declared code and nothing else", () => {
    expect([...SAMPLES.map((error) => error.code)].sort()).toEqual([...AGENTS_ERROR_CODES].sort());
  });

  it("declares each code exactly once", () => {
    expect(new Set(AGENTS_ERROR_CODES).size).toBe(AGENTS_ERROR_CODES.length);
  });

  it("gives every code the SCREAMING_SNAKE form M0.4 §2 fixes, under one prefix", () => {
    for (const code of AGENTS_ERROR_CODES) {
      expect(code).toMatch(/^AGENTS(_[A-Z0-9]+)+$/u);
    }
  });

  it("puts every diagnosis in log-only details, never in the message", () => {
    for (const error of SAMPLES) {
      expect(error.message).not.toMatch(/agent-1|env-1|macro-1|template-1|version-9|key-1/u);
    }
  });
});

describe("the two not-found answers stay two answers", () => {
  it("separates an invisible agent from one that is merely unbound here", () => {
    expect(errors.agentNotFound("agent-1").code).not.toBe(errors.agentNotBound("agent-1", "env-1").code);
  });

  it("gives both the same category, so neither confirms existence to a caller", () => {
    expect(errors.agentNotFound("agent-1").category).toBe("not_found");
    expect(errors.agentNotBound("agent-1", "env-1").category).toBe("not_found");
  });

  it("separates an invisible macro from a visible one this caller cannot change", () => {
    expect(errors.macroNotFound("macro-1").category).toBe("not_found");
    expect(errors.macroNotEditable("macro-1").category).toBe("forbidden");
  });
});

describe("the provider-key refusal", () => {
  it("carries the same message and code for both reasons, and separates them in details", () => {
    const unresolved = errors.providerKeyUnavailable("key-1", "openai", "unresolved");
    const mismatched = errors.providerKeyUnavailable("key-1", "openai", "provider-mismatch");
    expect(unresolved.code).toBe(mismatched.code);
    expect(unresolved.message).toBe(mismatched.message);
    expect(unresolved.details["reason"]).toBe("unresolved");
    expect(mismatched.details["reason"]).toBe("provider-mismatch");
  });

  it("fails a turn closed rather than inviting a fallback, so it is not retryable", () => {
    const error = errors.providerKeyUnavailable("key-1", "openai", "unresolved");
    expect(error.category).toBe("precondition_failed");
    expect(error.retryAfterSeconds).toBeNull();
  });
});

describe("field violations travel with the errors that carry them", () => {
  it("attaches the named field to a metadata refusal", () => {
    const error = errors.agentMetadataInvalid("name is required", [
      { field: "name", code: "required", message: "name is required" },
    ]);
    expect(error.fields).toEqual([{ field: "name", code: "required", message: "name is required" }]);
  });

  it("leaves fields empty when a refusal names no field", () => {
    expect(errors.canaryAbsent("agent-1").fields).toEqual([]);
  });

  it("marks only the unavailable repository as retryable", () => {
    expect(errors.repositoryUnavailable("down").retryAfterSeconds).toBe(5);
    for (const error of SAMPLES.filter((held) => held.code !== "AGENTS_REPOSITORY_UNAVAILABLE")) {
      expect(error.retryAfterSeconds).toBeNull();
    }
  });
});
