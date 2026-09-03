import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type ProviderKeyId, type RouteLabel } from "./identifiers.js";
import { DEFAULT_AGENTS_POLICY, COLUMN_CONTEXT_LIMIT } from "./policy.js";
import { buildSnapshot, canonicalJson, snapshotsDiffer } from "./snapshot.js";

const DEFAULTS = DEFAULT_AGENTS_POLICY.defaults;

describe("defaults", () => {
  it("fills every field from the policy when the source carries nothing", () => {
    const snapshot = buildSnapshot({}, DEFAULTS);
    expect(snapshot.model).toBe(DEFAULTS.model);
    expect(snapshot.maxSteps).toBe(DEFAULTS.maxSteps);
    expect(snapshot.contextLimit).toBe(DEFAULTS.contextLimit);
    expect(snapshot.historyMode).toBe(DEFAULTS.historyMode);
    expect(snapshot.compactThreshold).toBe(DEFAULTS.compactThreshold);
    expect(snapshot.toolMode).toBe(DEFAULTS.toolMode);
    expect(snapshot.executionMode).toBe(DEFAULTS.executionMode);
  });

  it("takes the SERVICE context limit, which disagrees with the column's own default", () => {
    // Both numbers are named so the disagreement is provable rather than folklore.
    expect(DEFAULTS.contextLimit).toBe(20);
    expect(COLUMN_CONTEXT_LIMIT).toBe(128_000);
    expect(buildSnapshot({}, DEFAULTS).contextLimit).not.toBe(COLUMN_CONTEXT_LIMIT);
  });

  it("treats an empty model string as absent", () => {
    expect(buildSnapshot({ model: "" }, DEFAULTS).model).toBe(DEFAULTS.model);
  });

  it("keeps a supplied model", () => {
    expect(buildSnapshot({ model: "openai:gpt-5" }, DEFAULTS).model).toBe("openai:gpt-5");
  });

  it("rejects a non-finite number for a numeric field rather than storing it", () => {
    expect(buildSnapshot({ maxSteps: Number.NaN }, DEFAULTS).maxSteps).toBe(DEFAULTS.maxSteps);
  });

  it("carries executionMode, the field whose absence silently dropped durable mode", () => {
    expect(buildSnapshot({ executionMode: "durable" }, DEFAULTS).executionMode).toBe("durable");
  });
});

describe("the two-step toolMode fallback", () => {
  it("prefers the explicit field", () => {
    const snapshot = buildSnapshot(
      { toolMode: "sub-agent", toolsBlockConfig: { mode: "execute-tool" } },
      DEFAULTS,
    );
    expect(snapshot.toolMode).toBe("sub-agent");
  });

  it("falls back to the tools config's own mode when the field is absent", () => {
    expect(buildSnapshot({ toolsBlockConfig: { mode: "sub-agent" } }, DEFAULTS).toolMode).toBe("sub-agent");
  });

  it("falls back to the policy default when neither is present", () => {
    expect(buildSnapshot({}, DEFAULTS).toolMode).toBe(DEFAULTS.toolMode);
  });
});

describe("shape coercion", () => {
  it("reads a non-object JSON field as null rather than storing a scalar", () => {
    const snapshot = buildSnapshot({ memoryConfig: "oops", outputSchema: [1] }, DEFAULTS);
    expect(snapshot.memoryConfig).toBeNull();
    expect(snapshot.outputSchema).toBeNull();
  });

  it("keeps only boolean entries in a boolean map", () => {
    expect(buildSnapshot({ metaTools: { a: true, b: "yes" } }, DEFAULTS).metaTools).toEqual({ a: true });
  });

  it("reads a non-true boolean flag as false", () => {
    expect(buildSnapshot({ enableThreading: "yes" }, DEFAULTS).enableThreading).toBe(false);
  });

  it("reads an empty provider-key pin as no pin", () => {
    expect(buildSnapshot({ providerKeyId: "" }, DEFAULTS).providerKeyId).toBeNull();
  });

  it("keeps a supplied provider-key pin", () => {
    expect(buildSnapshot({ providerKeyId: "key-1" }, DEFAULTS).providerKeyId).toBe("key-1");
  });

  it("parses a double-encoded prompt-block column", () => {
    const snapshot = buildSnapshot(
      { promptBlocks: JSON.stringify([{ id: "b", content: "c" }]) },
      DEFAULTS,
    );
    expect(snapshot.promptBlocks).toHaveLength(1);
  });

  it("reads dynamic blocks with their own shape, not the prompt-block shape", () => {
    const snapshot = buildSnapshot(
      { dynamicBlocks: [{ key: "city", name: "City", defaultContent: "London", order: 2 }] },
      DEFAULTS,
    );
    expect(snapshot.dynamicBlocks?.[0]).toEqual({
      key: "city",
      name: "City",
      defaultContent: "London",
      order: 2,
    });
  });

  it("leaves an absent optional dynamic-block field absent rather than explicitly undefined", () => {
    const snapshot = buildSnapshot({ dynamicBlocks: [{ key: "city" }] }, DEFAULTS);
    expect(snapshot.dynamicBlocks?.[0]).not.toHaveProperty("description");
    expect(snapshot.dynamicBlocks?.[0]).not.toHaveProperty("order");
  });
});

describe("canonical encoding", () => {
  it("orders keys, so two encodings of the same object are one string", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("orders keys at every depth", () => {
    expect(canonicalJson({ x: { b: 1, a: 2 } })).toBe(canonicalJson({ x: { a: 2, b: 1 } }));
  });

  it("keeps ARRAY order, which is meaningful", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("encodes null and the primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(3)).toBe("3");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(true)).toBe("true");
  });

  it("drops an explicitly undefined key rather than encoding it", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe("change detection", () => {
  const base = buildSnapshot({ model: "openai:gpt-5" }, DEFAULTS);

  it("reports no change for two snapshots built from the same source", () => {
    expect(snapshotsDiffer(base, buildSnapshot({ model: "openai:gpt-5" }, DEFAULTS))).toBe(false);
  });

  it("reports no change when a request omits a field the stored row defaults", () => {
    expect(
      snapshotsDiffer(base, buildSnapshot({ model: "openai:gpt-5", maxSteps: DEFAULTS.maxSteps }, DEFAULTS)),
    ).toBe(false);
  });

  it("reports a change on any edited field", () => {
    expect(snapshotsDiffer(base, buildSnapshot({ model: "openai:gpt-4" }, DEFAULTS))).toBe(true);
    expect(
      snapshotsDiffer(base, buildSnapshot({ model: "openai:gpt-5", maxSteps: 21 }, DEFAULTS)),
    ).toBe(true);
  });

  it("IGNORES key order inside a free-JSON field", () => {
    // The deliberate divergence from the source's `JSON.stringify` comparison.
    // Without it, two clients serializing the same object differently mint a
    // version on every save, forever, and version history stops meaning anything.
    const left = buildSnapshot({ memoryConfig: { a: 1, b: 2 } }, DEFAULTS);
    const right = buildSnapshot({ memoryConfig: { b: 2, a: 1 } }, DEFAULTS);
    expect(snapshotsDiffer(left, right)).toBe(false);
  });

  it("still reports a change when a free-JSON field's VALUE moves", () => {
    const left = buildSnapshot({ memoryConfig: { a: 1 } }, DEFAULTS);
    const right = buildSnapshot({ memoryConfig: { a: 2 } }, DEFAULTS);
    expect(snapshotsDiffer(left, right)).toBe(true);
  });

  it("reports a change when a routing table's ORDER moves", () => {
    const routes = [
      { label: asAgentsIdentifier<RouteLabel>("a"), model: "m", providerKeyId: null, isDefault: false },
      { label: asAgentsIdentifier<RouteLabel>("b"), model: "m", providerKeyId: null, isDefault: false },
    ];
    const left = buildSnapshot({ modelRoutes: routes }, DEFAULTS);
    const right = buildSnapshot({ modelRoutes: [routes[1]!, routes[0]!] }, DEFAULTS);
    expect(snapshotsDiffer(left, right)).toBe(true);
  });

  it("reports a change when only a pinned provider key moves", () => {
    const left = buildSnapshot({ providerKeyId: "key-1" }, DEFAULTS);
    const right = buildSnapshot({ providerKeyId: asAgentsIdentifier<ProviderKeyId>("key-2") }, DEFAULTS);
    expect(snapshotsDiffer(left, right)).toBe(true);
  });
});
