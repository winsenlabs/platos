import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type ProviderKeyId, type RouteLabel } from "./identifiers.js";
import {
  admitRoutes,
  API_PROVIDER_KEY_FIELD,
  compactionModel,
  compactionRoute,
  COMPACTION_ROUTE_LABEL,
  DEFAULT_COMPACTION_MODEL,
  DEFAULT_PROVIDER,
  defaultRoute,
  isQualified,
  modelFromRoutes,
  pinsProviderKey,
  providerKeyPins,
  providerOf,
  readRoute,
  readRoutes,
  selectRoute,
  STORED_PROVIDER_KEY_FIELD,
  writeRoute,
  writeRoutes,
  type ModelRoute,
} from "./model-route.js";

const KEY = asAgentsIdentifier<ProviderKeyId>("key-1");

function route(overrides: Partial<ModelRoute> = {}): ModelRoute {
  return {
    label: asAgentsIdentifier<RouteLabel>("alpha"),
    model: "openai:gpt-5",
    providerKeyId: null,
    isDefault: false,
    ...overrides,
  };
}

describe("the provider segment", () => {
  it("takes the segment before the colon", () => {
    expect(providerOf("openai:gpt-5")).toBe("openai");
  });

  it("routes an UNQUALIFIED model to the default provider", () => {
    expect(providerOf("claude-sonnet-4-6")).toBe(DEFAULT_PROVIDER);
    expect(isQualified("claude-sonnet-4-6")).toBe(false);
  });

  it("treats a leading colon as no provider segment at all", () => {
    expect(providerOf(":gpt-5")).toBe(DEFAULT_PROVIDER);
    expect(isQualified(":gpt-5")).toBe(false);
  });

  it("keeps everything after the FIRST colon as the model name", () => {
    expect(providerOf("google-vertex:publishers/google/models/x")).toBe("google-vertex");
  });
});

describe("the stored/API field alias", () => {
  it("reads the API spelling", () => {
    expect(readRoute({ label: "a", model: "m", [API_PROVIDER_KEY_FIELD]: "key-1" })?.providerKeyId).toBe(
      "key-1",
    );
  });

  it("reads the STORED spelling, which is what a real column holds", () => {
    expect(readRoute({ label: "a", model: "m", [STORED_PROVIDER_KEY_FIELD]: "key-1" })?.providerKeyId).toBe(
      "key-1",
    );
  });

  it("prefers the API spelling when a row somehow carries both", () => {
    const read = readRoute({
      label: "a",
      model: "m",
      [API_PROVIDER_KEY_FIELD]: "api",
      [STORED_PROVIDER_KEY_FIELD]: "stored",
    });
    expect(read?.providerKeyId).toBe("api");
  });

  it("reads an empty string as no pin", () => {
    expect(readRoute({ label: "a", model: "m", [STORED_PROVIDER_KEY_FIELD]: "" })?.providerKeyId).toBeNull();
  });

  it("WRITES only the stored spelling", () => {
    const written = writeRoute(route({ providerKeyId: KEY }));
    expect(written[STORED_PROVIDER_KEY_FIELD]).toBe("key-1");
    expect(written).not.toHaveProperty(API_PROVIDER_KEY_FIELD);
  });

  it("omits the field entirely when nothing is pinned", () => {
    expect(writeRoute(route())).not.toHaveProperty(STORED_PROVIDER_KEY_FIELD);
  });

  it("round-trips a pinned route through write and read", () => {
    const written = writeRoutes([route({ providerKeyId: KEY })]);
    expect(readRoutes(written)).toEqual([route({ providerKeyId: KEY })]);
  });
});

describe("reading a routing column", () => {
  it("drops a row with no label or no model rather than inventing one", () => {
    expect(readRoutes([{ model: "m" }, { label: "a" }, { label: "a", model: "m" }])).toHaveLength(1);
  });

  it("reads isDefault only when it is exactly true", () => {
    expect(readRoutes([{ label: "a", model: "m", isDefault: "yes" }])?.[0]?.isDefault).toBe(false);
  });

  it("answers null for a column that holds no list, and empty for one that holds an empty list", () => {
    expect(readRoutes("not json")).toBeNull();
    expect(readRoutes([])).toEqual([]);
  });

  it("parses a double-encoded routing column, like every other block list", () => {
    expect(readRoutes(JSON.stringify([{ label: "a", model: "m" }]))).toHaveLength(1);
  });
});

describe("admission", () => {
  it("trims the label and the model", () => {
    const admitted = admitRoutes([{ label: " fast ", model: " openai:gpt-5 " }]);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value[0]).toEqual({
      label: "fast",
      model: "openai:gpt-5",
      providerKeyId: null,
      isDefault: false,
    });
  });

  it("refuses a blank label or model, naming the index", () => {
    const blankLabel = admitRoutes([{ label: " ", model: "m" }]);
    if (blankLabel.ok) throw new Error("unreachable");
    expect(blankLabel.error.fields[0]?.field).toBe("modelRoutes[0].label");
    const blankModel = admitRoutes([{ label: "a", model: "" }]);
    if (blankModel.ok) throw new Error("unreachable");
    expect(blankModel.error.fields[0]?.field).toBe("modelRoutes[0].model");
  });

  it("REFUSES two routes carrying the same label", () => {
    // Not an inherited behaviour: the source does not check, and a table with
    // two `fast` rows resolves to whichever the array held first — a turn's
    // model depending on an editor's serialization order.
    const admitted = admitRoutes([
      { label: "fast", model: "a" },
      { label: "fast", model: "b" },
    ]);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.fields[0]?.code).toBe("duplicate");
  });

  it("reads an empty pinned key as no pin", () => {
    const admitted = admitRoutes([{ label: "a", model: "m", providerKeyId: "" }]);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value[0]?.providerKeyId).toBeNull();
  });

  it("admits an empty table", () => {
    const admitted = admitRoutes([]);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toEqual([]);
  });
});

describe("selection", () => {
  const routes = [
    route({ label: asAgentsIdentifier<RouteLabel>("alpha") }),
    route({ label: asAgentsIdentifier<RouteLabel>("bravo"), isDefault: true }),
  ];

  it("takes the route marked default", () => {
    expect(defaultRoute(routes)?.label).toBe("bravo");
  });

  it("falls back to the FIRST route when none is marked", () => {
    expect(defaultRoute([routes[0]!, route({ label: asAgentsIdentifier<RouteLabel>("x") })])?.label).toBe(
      "alpha",
    );
  });

  it("answers null for an empty table", () => {
    expect(defaultRoute([])).toBeNull();
    expect(modelFromRoutes([])).toBeNull();
  });

  it("resolves a label", () => {
    const selected = selectRoute(routes, asAgentsIdentifier<RouteLabel>("alpha"));
    if (!selected.ok) throw new Error("unreachable");
    expect(selected.value.label).toBe("alpha");
  });

  it("refuses a label the table does not carry, naming it", () => {
    const selected = selectRoute(routes, asAgentsIdentifier<RouteLabel>("charlie"));
    if (selected.ok) throw new Error("unreachable");
    expect(selected.error.code).toBe("AGENTS_ROUTE_NOT_FOUND");
    expect(selected.error.details["label"]).toBe("charlie");
  });

  it("reads the model out of the default route", () => {
    expect(modelFromRoutes(routes)).toBe("openai:gpt-5");
  });
});

describe("the compaction route", () => {
  it("finds the reserved label", () => {
    const routes = [route({ label: COMPACTION_ROUTE_LABEL, model: "anthropic:haiku" })];
    expect(compactionRoute(routes)?.model).toBe("anthropic:haiku");
    expect(compactionModel(routes)).toBe("anthropic:haiku");
  });

  it("falls back to the default summarisation model when there is none", () => {
    // An absent compaction route is not an error: it means the default. Turning
    // it into one would fail a turn on an agent that never configured it.
    expect(compactionRoute([route()])).toBeNull();
    expect(compactionModel([route()])).toBe(DEFAULT_COMPACTION_MODEL);
  });
});

describe("provider-key pins", () => {
  it("reads the version-level pin against the version's own model", () => {
    const pins = providerKeyPins("openai:gpt-5", KEY, []);
    expect(pins).toEqual([{ providerKeyId: KEY, provider: "openai", label: null }]);
  });

  it("reads a route pin against THAT route's model, not the version's", () => {
    const pins = providerKeyPins("openai:gpt-5", null, [
      route({ label: asAgentsIdentifier<RouteLabel>("fast"), model: "anthropic:haiku", providerKeyId: KEY }),
    ]);
    expect(pins).toEqual([{ providerKeyId: KEY, provider: "anthropic", label: "fast" }]);
  });

  it("reads both places at once", () => {
    expect(providerKeyPins("openai:gpt-5", KEY, [route({ providerKeyId: KEY })])).toHaveLength(2);
  });

  it("ignores routes that pin nothing", () => {
    expect(providerKeyPins("openai:gpt-5", null, [route()])).toEqual([]);
  });

  it("resolves an unqualified model's pin against the DEFAULT provider", () => {
    const pins = providerKeyPins("claude-sonnet-4-6", KEY, []);
    expect(pins[0]?.provider).toBe(DEFAULT_PROVIDER);
  });

  it("matches a pin only when the key AND the provider agree", () => {
    const pins = providerKeyPins("openai:gpt-5", KEY, []);
    expect(pinsProviderKey(pins, KEY, "openai")).toBe(true);
    expect(pinsProviderKey(pins, KEY, "anthropic")).toBe(false);
    expect(pinsProviderKey(pins, asAgentsIdentifier<ProviderKeyId>("key-2"), "openai")).toBe(false);
  });
});
