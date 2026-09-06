import { describe, expect, it } from "vitest";

import * as errors from "./errors.js";
import { MEMORY_ERROR_CODES } from "./errors.js";

/** Every factory in the catalogue, with arguments that exercise its details. */
const FACTORIES: readonly (readonly [string, () => { code: string }])[] = [
  ["MEMORY_NOT_FOUND", () => errors.memoryNotFound("mem-1")],
  ["MEMORY_END_USER_CONTEXT_REQUIRED", () => errors.endUserContextRequired()],
  ["MEMORY_SCOPE_MISMATCH", () => errors.scopeMismatch("a", "b")],
  ["MEMORY_AGENT_SCOPE_DENIED", () => errors.agentScopeDenied("why", "agent-1")],
  ["MEMORY_AGENT_AMBIGUOUS", () => errors.agentAmbiguous(3)],
  ["MEMORY_INVALID_KIND", () => errors.invalidKind("opinion", ["fact"])],
  ["MEMORY_INVALID_CONTENT", () => errors.invalidContent("empty")],
  ["MEMORY_INVALID_METADATA", () => errors.invalidMetadata("bad")],
  ["MEMORY_INVALID_VISIBILITY", () => errors.invalidVisibility(["hidden"])],
  ["MEMORY_INVALID_SOURCE", () => errors.invalidSource(["manual"])],
  ["MEMORY_UNTRUSTED_SOURCE", () => errors.untrustedSource("extracted")],
  ["MEMORY_INVALID_CONFIDENCE", () => errors.invalidConfidence(7)],
  ["MEMORY_PROVENANCE_INCOMPLETE", () => errors.provenanceIncomplete("no thread")],
  ["MEMORY_BULK_LIMIT_EXCEEDED", () => errors.bulkLimitExceeded(101, 100)],
  ["MEMORY_ENTITY_NOT_FOUND", () => errors.entityNotFound("ent-1")],
  ["MEMORY_ENTITY_KEY_INVALID", () => errors.entityKeyInvalid("???")],
  ["MEMORY_ENTITY_OWNERSHIP_CONFLICT", () => errors.entityOwnershipConflict("acme")],
  ["MEMORY_RELATIONSHIP_ENDPOINTS_SPLIT", () => errors.relationshipEndpointsSplit("a", "b")],
  ["MEMORY_RELATIONSHIP_INVALID", () => errors.relationshipInvalid("no type")],
  ["MEMORY_QUERY_INVALID", () => errors.queryInvalid("bad", "query")],
  ["MEMORY_EMBEDDING_UNAVAILABLE", () => errors.embeddingUnavailable("down")],
  ["MEMORY_EXTRACTION_JUDGE_UNAVAILABLE", () => errors.extractionJudgeUnavailable("no key")],
  ["MEMORY_EXTRACTION_ENVELOPE_INVALID", () => errors.extractionEnvelopeInvalid("prose")],
  ["MEMORY_CACHE_UNAVAILABLE", () => errors.cacheUnavailable("down")],
  // WIN-260 (M2.5). The two refusals the `Cache` port asks an implementation to
  // make and that nothing enforced while the port had no implementation: a write
  // whose TTL is not a positive whole number of seconds, and a namespace sweep
  // whose prefix is blank.
  ["MEMORY_CACHE_TTL_INVALID", () => errors.cacheTtlInvalid(0)],
  ["MEMORY_CACHE_NAMESPACE_INVALID", () => errors.cacheNamespaceInvalid()],
  ["MEMORY_REPOSITORY_UNAVAILABLE", () => errors.repositoryUnavailable("down")],
];

describe("the catalogue", () => {
  it("declares every code exactly once", () => {
    expect(new Set(MEMORY_ERROR_CODES).size).toBe(MEMORY_ERROR_CODES.length);
  });

  it("has a factory for every declared code, and no factory outside the list", () => {
    expect(FACTORIES.map(([code]) => code).sort()).toEqual([...MEMORY_ERROR_CODES].sort());
    for (const [code, build] of FACTORIES) expect(build().code).toBe(code);
  });

  it("spells every code SCREAMING_SNAKE under this context's prefix", () => {
    for (const code of MEMORY_ERROR_CODES) {
      expect(code).toMatch(/^MEMORY(?:_[A-Z0-9]+)+$/u);
    }
  });
});

describe("the four codes that already reached operators keep their spelling", () => {
  it("preserves the source's own bolted-on codes verbatim", () => {
    for (const code of [
      "MEMORY_END_USER_CONTEXT_REQUIRED",
      "MEMORY_UNTRUSTED_SOURCE",
      "MEMORY_INVALID_VISIBILITY",
      "MEMORY_INVALID_SOURCE",
    ]) {
      expect(MEMORY_ERROR_CODES).toContain(code);
    }
  });
});

describe("categories carry the decision a transport has to make", () => {
  it("an unreadable subject is `not_found`, which does not confirm existence", () => {
    expect(errors.endUserContextRequired().category).toBe("not_found");
    expect(errors.memoryNotFound("mem-1").category).toBe("not_found");
  });

  it("a scope refusal is `forbidden` — the grant is real, for elsewhere", () => {
    expect(errors.scopeMismatch("a", "b").category).toBe("forbidden");
    expect(errors.agentScopeDenied("why").category).toBe("forbidden");
  });

  it("claiming a provenance is `forbidden`, not `invalid_input`", () => {
    // The payload is well-formed; what is missing is the privilege.
    expect(errors.untrustedSource("extracted").category).toBe("forbidden");
  });

  it("an ownership clash is a `conflict`", () => {
    expect(errors.entityOwnershipConflict("acme").category).toBe("conflict");
  });

  it("infrastructure failures are `unavailable` and carry a retry hint", () => {
    for (const build of [
      () => errors.repositoryUnavailable("down"),
      () => errors.cacheUnavailable("down"),
      () => errors.embeddingUnavailable("down"),
      () => errors.extractionJudgeUnavailable("down"),
    ]) {
      const error = build();
      expect(error.category).toBe("unavailable");
      expect(error.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("a caller mistake is `invalid_input` and carries no retry hint", () => {
    const error = errors.invalidConfidence(7);
    expect(error.category).toBe("invalid_input");
    expect(error.retryAfterSeconds).toBeNull();
  });
});

describe("details and field violations", () => {
  it("an ambiguous write reports how many agents it had to choose between", () => {
    expect(errors.agentAmbiguous(3).details["candidateCount"]).toBe(3);
  });

  it("a bulk refusal reports both the request and the cap", () => {
    const error = errors.bulkLimitExceeded(101, 100);
    expect(error.details["requested"]).toBe(101);
    expect(error.details["maximum"]).toBe(100);
  });

  it("a query refusal names the field a caller must fix", () => {
    expect(errors.queryInvalid("bad", "minScore").fields[0]?.field).toBe("minScore");
  });

  it("every error is frozen, so a transport cannot rewrite one in flight", () => {
    for (const [, build] of FACTORIES) expect(Object.isFrozen(build())).toBe(true);
  });
});
