import {
  asIdentifier,
  environmentScope,
  organizationScope,
  projectScope,
  type DomainEvent,
  type EnvironmentScope,
  type TenantScope,
} from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  decideEnvelope,
  environmentOf,
  isProjectedEventName,
  readProjectionRows,
  SUPPORTED_SCHEMA_VERSIONS,
  TURN_FINALIZED_EVENT,
  TURN_ROWS_EVENT,
} from "./envelope.js";
import { PROJECTION_TABLES } from "./projection-tables.js";

const TURN_UUID = "11111111-1111-4111-8111-111111111111";

function scope(environmentId = "env-1"): EnvironmentScope {
  return environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier(environmentId));
}

function envelope(
  name: string,
  payload: unknown,
  options: { schemaVersion?: number; scope?: TenantScope } = {},
): DomainEvent {
  return {
    eventId: asIdentifier("event-1"),
    name,
    schemaVersion: options.schemaVersion ?? 1,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    scope: options.scope ?? scope(),
    requestId: null,
    payload: payload as never,
  };
}

function finalizedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turn: {
      turnId: TURN_UUID,
      threadId: "thread-1",
      agentId: "agent-1",
      status: "completed",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:02.500Z",
      tokens: { inputTokens: 1000, outputTokens: 250 },
      costCents: 125,
    },
    ...overrides,
  };
}

describe("decideEnvelope — an unknown NAME is ignored, never parked", () => {
  it("ignores an envelope belonging to another drain", () => {
    const decision = decideEnvelope(envelope("eventing.notification.requested", {}));
    expect(decision.kind).toBe("ignore");
  });

  it("does not even look at an unrecognised envelope's payload", () => {
    // A payload that would be refused if it were read at all.
    const decision = decideEnvelope(envelope("eventing.notification.requested", "not an object"));
    expect(decision.kind).toBe("ignore");
  });

  it("names exactly the two events it projects", () => {
    expect(Object.keys(SUPPORTED_SCHEMA_VERSIONS).sort()).toEqual(
      [TURN_FINALIZED_EVENT, TURN_ROWS_EVENT].sort(),
    );
    expect(isProjectedEventName(TURN_FINALIZED_EVENT)).toBe(true);
    expect(isProjectedEventName("identity.session.started")).toBe(false);
  });
});

describe("decideEnvelope — a newer VERSION is refused, and refused terminally", () => {
  it("refuses a schema version newer than this drain understands", () => {
    const decision = decideEnvelope(envelope(TURN_FINALIZED_EVENT, finalizedPayload(), { schemaVersion: 2 }));
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("unreachable");
    expect(decision.error.code).toBe("OBSERVABILITY_ENVELOPE_VERSION_UNSUPPORTED");
  });

  it("refuses a version that is not a version at all", () => {
    for (const schemaVersion of [0, -1, 1.5, Number.NaN]) {
      const decision = decideEnvelope(
        envelope(TURN_FINALIZED_EVENT, finalizedPayload(), { schemaVersion }),
      );
      expect(decision.kind).toBe("refuse");
      if (decision.kind !== "refuse") throw new Error("unreachable");
      expect(decision.error.code).toBe("OBSERVABILITY_ENVELOPE_MALFORMED");
    }
  });

  it("reads the name BEFORE the version, so another drain's future event is still ignored", () => {
    const decision = decideEnvelope(envelope("eventing.notification.requested", {}, { schemaVersion: 9 }));
    expect(decision.kind).toBe("ignore");
  });
});

describe("decideEnvelope — the finalized-Turn payload", () => {
  it("projects a well-formed payload into rows", () => {
    const decision = decideEnvelope(envelope(TURN_FINALIZED_EVENT, finalizedPayload()));
    expect(decision.kind).toBe("project");
    if (decision.kind !== "project") throw new Error("unreachable");
    expect(decision.rows.turns_v1).toHaveLength(1);
    expect(decision.rows.turns_v1[0]?.turn_id).toBe(TURN_UUID);
  });

  it("stamps the ENVELOPE's scope onto the row, so the payload cannot claim another tenant", () => {
    const decision = decideEnvelope(
      envelope(TURN_FINALIZED_EVENT, finalizedPayload({ organizationId: "org-evil" }), {
        scope: scope("env-7"),
      }),
    );
    if (decision.kind !== "project") throw new Error("unreachable");
    expect(decision.rows.turns_v1[0]?.organization_id).toBe("org-1");
    expect(decision.rows.turns_v1[0]?.environment_id).toBe("env-7");
  });

  it("refuses an envelope addressed wider than one environment", () => {
    for (const wide of [organizationScope(asIdentifier("org-1")), projectScope(asIdentifier("org-1"), asIdentifier("proj-1"))]) {
      const decision = decideEnvelope(envelope(TURN_FINALIZED_EVENT, finalizedPayload(), { scope: wide }));
      expect(decision.kind).toBe("refuse");
    }
  });

  it("ignores an unknown field a newer producer added", () => {
    const decision = decideEnvelope(
      envelope(TURN_FINALIZED_EVENT, finalizedPayload({ somethingNew: { deeply: "nested" } })),
    );
    expect(decision.kind).toBe("project");
  });

  it("refuses a payload whose required field is absent, and names it", () => {
    const payload = finalizedPayload();
    delete (payload.turn as Record<string, unknown>).completedAt;
    const decision = decideEnvelope(envelope(TURN_FINALIZED_EVENT, payload));
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("unreachable");
    expect(decision.error.fields[0]?.field).toBe("turn.completedAt");
  });

  it("refuses a status outside the closed set", () => {
    const payload = finalizedPayload();
    (payload.turn as Record<string, unknown>).status = "running";
    const decision = decideEnvelope(envelope(TURN_FINALIZED_EVENT, payload));
    expect(decision.kind).toBe("refuse");
  });

  it("refuses an unparseable instant rather than filing the Turn at the epoch", () => {
    const payload = finalizedPayload();
    (payload.turn as Record<string, unknown>).acceptedAt = "yesterday";
    const decision = decideEnvelope(envelope(TURN_FINALIZED_EVENT, payload));
    expect(decision.kind).toBe("refuse");
  });

  it("refuses a steps list that is not a list", () => {
    const decision = decideEnvelope(envelope(TURN_FINALIZED_EVENT, finalizedPayload({ steps: "one" })));
    expect(decision.kind).toBe("refuse");
  });

  it("accepts an absent steps list — a Turn with no steps really has none", () => {
    const decision = decideEnvelope(envelope(TURN_FINALIZED_EVENT, finalizedPayload()));
    if (decision.kind !== "project") throw new Error("unreachable");
    expect(decision.rows.steps_v1).toHaveLength(0);
  });

  it("reads a step and inherits the envelope's scope for it", () => {
    const decision = decideEnvelope(
      envelope(
        TURN_FINALIZED_EVENT,
        finalizedPayload({
          steps: [
            {
              stepId: "22222222-2222-4222-8222-222222222222",
              turnId: TURN_UUID,
              threadId: "thread-1",
              agentId: "agent-1",
              sequence: 0,
              provider: "provider-a",
              model: "model-a",
              status: "completed",
              startedAt: "2026-01-01T00:00:00.000Z",
              completedAt: "2026-01-01T00:00:01.000Z",
              // A key the reader has never heard of, and one it refuses to carry.
              prompt: "the whole system prompt",
              attributes: { finish_reason: "stop", prompt: "again" },
            },
          ],
        }),
      ),
    );
    if (decision.kind !== "project") throw new Error("unreachable");
    const row = decision.rows.steps_v1[0];
    expect(row?.environment_id).toBe("env-1");
    expect(row?.attributes_json).toBe(JSON.stringify({ finish_reason: "stop" }));
    expect(JSON.stringify(row)).not.toContain("system prompt");
  });

  it("accepts an instant given as epoch milliseconds", () => {
    const payload = finalizedPayload();
    (payload.turn as Record<string, unknown>).acceptedAt = 1_767_225_600_000;
    const decision = decideEnvelope(envelope(TURN_FINALIZED_EVENT, payload));
    expect(decision.kind).toBe("project");
  });
});

describe("readProjectionRows — the pre-V1 queue's payload", () => {
  it("reads a row payload back", () => {
    const decision = readProjectionRows({
      turns_v1: [{ organization_id: "org-1", turn_id: TURN_UUID, duration_ms: 12 }],
    });
    expect(decision.kind).toBe("project");
    if (decision.kind !== "project") throw new Error("unreachable");
    expect(decision.rows.turns_v1).toHaveLength(1);
    expect(decision.rows.turns_v1[0]?.duration_ms).toBe(12);
  });

  it("refuses a payload that is a scalar, which the column has really held", () => {
    expect(readProjectionRows("{}").kind).toBe("refuse");
    expect(readProjectionRows(null).kind).toBe("refuse");
    expect(readProjectionRows([]).kind).toBe("refuse");
  });

  it("refuses a table whose value is not an array", () => {
    expect(readProjectionRows({ turns_v1: { a: 1 } }).kind).toBe("refuse");
  });

  it("refuses an entry that is not an object", () => {
    expect(readProjectionRows({ turns_v1: ["row"] }).kind).toBe("refuse");
  });

  it("refuses a NESTED cell, which the pre-V1 decoder would have let through", () => {
    const decision = readProjectionRows({ turns_v1: [{ turn_id: TURN_UUID, attrs: { a: 1 } }] });
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("unreachable");
    expect(decision.error.fields[0]?.field).toBe("turns_v1.attrs");
  });

  it("ignores a table a newer writer added, and keeps the four this binary owns", () => {
    const decision = readProjectionRows({
      turns_v1: [{ turn_id: TURN_UUID }],
      spans_v2: [{ anything: 1 }],
    });
    if (decision.kind !== "project") throw new Error("unreachable");
    expect(Object.keys(decision.rows).sort()).toEqual([...PROJECTION_TABLES].sort());
    expect(decision.rows.turns_v1).toHaveLength(1);
  });

  it("yields four empty tables for an empty payload", () => {
    const decision = readProjectionRows({});
    if (decision.kind !== "project") throw new Error("unreachable");
    for (const table of PROJECTION_TABLES) expect(decision.rows[table]).toHaveLength(0);
  });

  it("is reachable through decideEnvelope under the rows event name", () => {
    const decision = decideEnvelope(
      envelope(TURN_ROWS_EVENT, { turns_v1: [{ turn_id: TURN_UUID }] }),
    );
    expect(decision.kind).toBe("project");
  });
});

describe("environmentOf", () => {
  it("accepts an environment scope", () => {
    expect(environmentOf(scope())).not.toBeNull();
  });

  it("refuses anything wider, because a row has no wider address", () => {
    expect(environmentOf(organizationScope(asIdentifier("org-1")))).toBeNull();
    expect(environmentOf(projectScope(asIdentifier("org-1"), asIdentifier("proj-1")))).toBeNull();
  });
});
