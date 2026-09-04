// `domain/connection.ts` — the operator kill switch.
//
// THIS FILE EXISTS BECAUSE THE MODULE HAD NONE. Every other aggregate in this
// context ships a `.test.ts` beside it; `connection.ts` shipped without one, and
// the consequence is exactly the defect this file closes: `assertEnabled` — the
// switch an operator throws to stop a channel spending money — had zero callers
// AND zero cases, so the function could be deleted outright with the whole
// package still green.
//
// The cases below prove the RULE. That the inbound path actually runs it is a
// separate obligation, proved at the call site in
// `contracts/channels-contract.test.ts` ("refuses the inbound turn on a DISABLED
// connection, and spends nothing"). Both are needed: a rule nothing calls is
// decorative, and a call site with no rule beneath it is a coincidence.

import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { assertEnabled, type ChannelConnection } from "./connection.js";
import type { AgentId, ChannelConnectionId, CredentialId } from "./identifiers.js";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

function seed(overrides: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    connectionId: asIdentifier<ChannelConnectionId>("conn-1"),
    scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
    entityId: null,
    provider: "slack",
    displayName: "Acme Slack",
    defaultAgentId: asIdentifier<AgentId>("agent-1"),
    agentRouting: [],
    enabled: true,
    credentialId: asIdentifier<CredentialId>("cred-1"),
    createdAt: EPOCH,
    ...overrides,
  };
}

describe("assertEnabled", () => {
  it("REFUSES a disabled connection, naming it in the error", () => {
    // The refusal half — the only half worth having. `enabled: false` is the one
    // word that differs from the case below.
    const result = assertEnabled(seed({ enabled: false }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_CONNECTION_DISABLED");
    // `precondition_failed`, not `not_found`: the row exists and the operator
    // switched it off. A transport that mapped this to a 404 would tell an
    // integrator the connection had been deleted.
    expect(result.error.category).toBe("precondition_failed");
    expect(result.error.details).toEqual({ connectionId: "conn-1" });
  });

  it("admits an enabled connection, returning the SAME row", () => {
    // The control. It also pins that the gate is a pass-through rather than a
    // rewrite, because `routingFor` reads the routing table off the value the
    // gate returns.
    const connection = seed({ enabled: true });
    const result = assertEnabled(connection);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(connection);
  });
});
