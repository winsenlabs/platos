import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type ActorId, type ProviderKeyId, type RouteLabel } from "./identifiers.js";
import { STORED_PROVIDER_KEY_FIELD } from "./model-route.js";
import { DEFAULT_AGENTS_POLICY } from "./policy.js";
import { buildSnapshot, canonicalJson, type AgentVersionSnapshot } from "./snapshot.js";
import {
  CARRIED_TOOL_LIST_KEY,
  packVersionRow,
  publicMemoryConfig,
  publicToolsConfig,
  readVersionRow,
  RUNTIME_ENVELOPE_KEY,
  runtimeEnvelope,
  type AgentVersionRowData,
} from "./version-envelope.js";

const DEFAULTS = DEFAULT_AGENTS_POLICY.defaults;
const AUTHOR = { createdBy: asAgentsIdentifier<ActorId>("operator-1"), note: "note" };

function pack(snapshot: AgentVersionSnapshot): AgentVersionRowData {
  return packVersionRow(snapshot, AUTHOR, 3, "ALL", DEFAULTS);
}

function unpack(row: AgentVersionRowData): AgentVersionSnapshot {
  return readVersionRow(
    {
      model: row.model,
      systemPrompt: row.systemPrompt,
      maxSteps: row.maxSteps,
      contextLimit: row.contextLimit,
      promptBlocks: row.promptBlocks,
      dynamicBlocks: row.dynamicBlocks,
      toolsBlockConfig: row.toolsBlockConfig,
      modelRoutes: row.modelRoutes,
      memoryConfig: row.memoryConfig,
      outputSchema: row.outputSchema ?? null,
    },
    DEFAULTS,
  );
}

describe("the envelope", () => {
  it("puts carried state under the reserved key and nowhere else", () => {
    const row = pack(buildSnapshot({ historyMode: "compact", visibility: "public-guest" }, DEFAULTS));
    const envelope = runtimeEnvelope(row.memoryConfig);
    expect(envelope["historyMode"]).toBe("compact");
    expect(envelope["visibility"]).toBe("public-guest");
    expect(row.memoryConfig).toHaveProperty(RUNTIME_ENVELOPE_KEY);
  });

  it("reads an empty envelope from a memoryConfig that has none", () => {
    expect(runtimeEnvelope({ a: 1 })).toEqual({});
    expect(runtimeEnvelope(null)).toEqual({});
    expect(runtimeEnvelope("oops")).toEqual({});
  });

  it("keeps the operator's own memory configuration OUTSIDE the envelope", () => {
    const row = pack(buildSnapshot({ memoryConfig: { retentionDays: 30 } }, DEFAULTS));
    expect(row.memoryConfig["retentionDays"]).toBe(30);
    expect(publicMemoryConfig(row.memoryConfig)).toEqual({ retentionDays: 30 });
  });

  it("STRIPS the envelope from what an operator reads back", () => {
    const row = pack(buildSnapshot({ memoryConfig: { retentionDays: 30 } }, DEFAULTS));
    expect(publicMemoryConfig(row.memoryConfig)).not.toHaveProperty(RUNTIME_ENVELOPE_KEY);
  });

  it("reads an all-envelope memoryConfig as no public configuration at all", () => {
    const row = pack(buildSnapshot({}, DEFAULTS));
    expect(publicMemoryConfig(row.memoryConfig)).toBeNull();
  });

  it("refuses to let a caller smuggle an envelope in through the public half", () => {
    const row = pack(buildSnapshot({ memoryConfig: { [RUNTIME_ENVELOPE_KEY]: { visibility: "x" } } }, DEFAULTS));
    expect(runtimeEnvelope(row.memoryConfig)["visibility"]).toBeNull();
  });
});

describe("the tool list moves between containers", () => {
  it("writes enabledTools into the ENVELOPE, not into the tools column", () => {
    const row = pack(buildSnapshot({ toolsBlockConfig: { enabledTools: ["mail.send"] } }, DEFAULTS));
    expect(row.toolsBlockConfig).not.toHaveProperty(CARRIED_TOOL_LIST_KEY);
    expect(runtimeEnvelope(row.memoryConfig)[CARRIED_TOOL_LIST_KEY]).toEqual(["mail.send"]);
  });

  it("reads it back INTO the projected tools config", () => {
    const row = pack(buildSnapshot({ toolsBlockConfig: { enabledTools: ["mail.send"] } }, DEFAULTS));
    expect(publicToolsConfig(row)?.[CARRIED_TOOL_LIST_KEY]).toEqual(["mail.send"]);
  });

  it("omits the envelope entry entirely when there is no list", () => {
    const row = pack(buildSnapshot({ toolsBlockConfig: { displayMode: "full" } }, DEFAULTS));
    expect(runtimeEnvelope(row.memoryConfig)).not.toHaveProperty(CARRIED_TOOL_LIST_KEY);
  });

  it("writes toolMode into the tools column as `mode` when the column has none", () => {
    const row = pack(buildSnapshot({ toolMode: "sub-agent" }, DEFAULTS));
    expect(row.toolsBlockConfig["mode"]).toBe("sub-agent");
  });

  it("does NOT overwrite a mode the column already carries", () => {
    const row = pack(buildSnapshot({ toolMode: "sub-agent", toolsBlockConfig: { mode: "execute-tool" } }, DEFAULTS));
    expect(row.toolsBlockConfig["mode"]).toBe("execute-tool");
  });

  it("answers null for a version with no tools configuration at all", () => {
    expect(publicToolsConfig({ toolsBlockConfig: null, memoryConfig: {} })).toBeNull();
  });
});

describe("the routing column", () => {
  it("writes the STORED spelling of a pinned key", () => {
    const routes = [
      {
        label: asAgentsIdentifier<RouteLabel>("fast"),
        model: "openai:gpt-5",
        providerKeyId: asAgentsIdentifier<ProviderKeyId>("key-1"),
        isDefault: true,
      },
    ];
    const row = pack(buildSnapshot({ modelRoutes: routes }, DEFAULTS));
    expect((row.modelRoutes[0] as Record<string, unknown>)[STORED_PROVIDER_KEY_FIELD]).toBe("key-1");
  });

  it("writes an empty array for a version with no routing table", () => {
    expect(pack(buildSnapshot({}, DEFAULTS)).modelRoutes).toEqual([]);
  });
});

describe("outputSchema is omitted rather than nulled", () => {
  it("leaves the key off the row when the snapshot has no schema", () => {
    expect(pack(buildSnapshot({}, DEFAULTS))).not.toHaveProperty("outputSchema");
  });

  it("writes the schema when there is one", () => {
    expect(pack(buildSnapshot({ outputSchema: { type: "object" } }, DEFAULTS)).outputSchema).toEqual({
      type: "object",
    });
  });
});

describe("the round trip", () => {
  const rich = () =>
    buildSnapshot(
      {
        model: "openai:gpt-5",
        systemPrompt: "Be brief.",
        promptBlocks: [{ id: "b", type: "identity", name: "", content: "You are X.", enabled: true, editable: true, order: 1 }],
        dynamicBlocks: [{ key: "city", name: "City", defaultContent: "London" }],
        maxSteps: 7,
        contextLimit: 99,
        historyMode: "compact",
        compactThreshold: 12,
        enableUserProfiling: true,
        toolMode: "sub-agent",
        executionMode: "durable",
        toolsBlockConfig: { displayMode: "hybrid", pinnedTools: ["a"], enabledTools: ["b"] },
        subAgentConfig: { model: "anthropic:haiku", maxSteps: 3 },
        memoryConfig: { retentionDays: 30 },
        metaTools: { find_tools: true },
        featureFlags: { beta: false },
        outputSchema: { type: "object" },
        extractionPolicy: { enabled: true },
        enableThreading: true,
        threadingConfig: { window: 5 },
        contextMapping: { entityIdsKey: "entity_ids" },
        providerKeyId: "key-1",
        visibility: "public-guest",
        maxJobsPerTurn: 4,
        agentRetryConfig: { maxRetries: 2 },
        modelRoutes: [
          {
            label: asAgentsIdentifier<RouteLabel>("fast"),
            model: "openai:gpt-5-mini",
            providerKeyId: asAgentsIdentifier<ProviderKeyId>("key-2"),
            isDefault: true,
          },
        ],
      },
      DEFAULTS,
    );

  it("returns every field except the materialised tool mode unchanged", () => {
    const snapshot = rich();
    const { toolsBlockConfig: _packed, ...roundTripped } = unpack(pack(snapshot));
    const { toolsBlockConfig: _original, ...started } = snapshot;
    expect(canonicalJson(roundTripped)).toBe(canonicalJson(started));
  });

  it("MATERIALISES `mode` into the tools config, which is the one thing the trip adds", () => {
    // Not a defect and not identity: `packVersionRow` writes `toolMode` into the
    // column as `mode` when the column has none, and the projection reads it
    // back. So a snapshot that carried a tool mode and no nested mode gains one.
    // The snapshot keeps its own `toolMode` alongside it, which is what makes
    // the two agree by construction rather than by convention.
    const snapshot = rich();
    expect(snapshot.toolsBlockConfig?.mode).toBeUndefined();
    const tripped = unpack(pack(snapshot));
    expect(tripped.toolsBlockConfig?.mode).toBe(snapshot.toolMode);
  });

  it("is a FIXPOINT from the second trip, so a re-save does not drift", () => {
    const once = unpack(pack(rich()));
    expect(canonicalJson(unpack(pack(once)))).toBe(canonicalJson(once));
  });

  it("is a fixpoint for a plain snapshot too", () => {
    const once = unpack(pack(buildSnapshot({ historyMode: "compact", memoryConfig: { a: 1 } }, DEFAULTS)));
    expect(canonicalJson(unpack(pack(once)))).toBe(canonicalJson(once));
  });

  it("reads a row written before a field existed as that field's DEFAULT", () => {
    const legacy = readVersionRow(
      {
        model: "openai:gpt-5",
        systemPrompt: null,
        maxSteps: 5,
        contextLimit: 10,
        promptBlocks: [],
        dynamicBlocks: [],
        toolsBlockConfig: {},
        modelRoutes: [],
        // No envelope at all: a row from before the carried state existed.
        memoryConfig: {},
        outputSchema: null,
      },
      DEFAULTS,
    );
    expect(legacy.historyMode).toBe(DEFAULTS.historyMode);
    expect(legacy.executionMode).toBe(DEFAULTS.executionMode);
    expect(legacy.visibility).toBeNull();
  });

  it("carries the authorship and the note onto the row unchanged", () => {
    const row = pack(buildSnapshot({}, DEFAULTS));
    expect(row.createdBy).toBe("operator-1");
    expect(row.note).toBe("note");
    expect(row.versionNumber).toBe(3);
    expect(row.toolDefaultPolicy).toBe("ALL");
  });
});
