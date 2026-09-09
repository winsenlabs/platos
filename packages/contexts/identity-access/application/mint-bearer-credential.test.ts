// WIN-268 (M4.2) P1 — the mint, and every refusal it can reach.
//
// The cases are grouped by what would go wrong if the rule were missing, not by
// the order the code checks them, because that is what a reader needs to know:
//
//   THE SECRET — minted once, hashed once, returned once, never stored raw.
//   THE SHAPE  — each refusal is a DIFFERENT code with a named field, so a
//                client learns which input to fix rather than "invalid".
//   THE KINDS  — two of the four bearer kinds are mintable and two are not, and
//                the two that are not have no oracle rather than no permission.
//   THE STORE  — the record the caller sees is the one the STORE wrote, so a
//                store that normalised a value cannot be contradicted by a view.
//
// A REAL DATABASE IS NOT HERE AND IS NOT MISSING. `identity-rest.integration.test.ts`
// proves the mint against PostgreSQL 16 over a socket, including two identical
// requests racing. What is proved here is every branch that a real database
// would make expensive and slow to reach — an over-long TTL, a blank permission,
// a subject on the wrong kind — and each one exactly once.

import { describe, expect, it } from "vitest";

import {
  asIdentifier,
  environmentScope,
  organizationScope,
  type EnvironmentId,
  type OrganizationId,
  type PrincipalId,
  type ProjectId,
} from "@platos/kernel";

import {
  DEFAULT_BEARER_TTL_SECONDS,
  MAX_BEARER_LABEL_LENGTH,
  MAX_BEARER_TTL_SECONDS,
  MINTABLE_BEARER_KINDS,
  isMintableBearerKind,
} from "../domain/index.js";
import { T0 } from "../domain/testing.js";
import { mintBearerCredential, type MintBearerCredentialCommand } from "./mint-bearer-credential.js";
import { testPorts, type TestPorts } from "./testing.js";

const ORGANIZATION = asIdentifier<OrganizationId>("org-1");
const PROJECT = asIdentifier<ProjectId>("project-1");
const ENVIRONMENT = asIdentifier<EnvironmentId>("environment-1");
const SCOPE = environmentScope(ORGANIZATION, PROJECT, ENVIRONMENT);
const OPERATOR = "user-1" as PrincipalId;

function platformCommand(
  overrides: Partial<MintBearerCredentialCommand> = {},
): MintBearerCredentialCommand {
  return {
    kind: "mcp-token",
    scope: SCOPE,
    label: "CI deploy key",
    permissions: ["agents.*"],
    createdByUserId: OPERATOR,
    principalId: OPERATOR,
    subjectId: null,
    permissionTier: "scope",
    ttlSeconds: null,
    ...overrides,
  } as MintBearerCredentialCommand;
}

function entityCommand(
  overrides: Partial<MintBearerCredentialCommand> = {},
): MintBearerCredentialCommand {
  return {
    kind: "entity-bearer-token",
    scope: SCOPE,
    label: "support desk",
    permissions: ["mcp:tools"],
    createdByUserId: OPERATOR,
    principalId: null,
    subjectId: "entity-1",
    permissionTier: null,
    ttlSeconds: null,
    ...overrides,
  } as MintBearerCredentialCommand;
}

async function refusalCode(
  ports: TestPorts,
  command: MintBearerCredentialCommand,
): Promise<string> {
  const result = await mintBearerCredential(ports, command);
  if (result.ok) throw new Error(`expected a refusal; the mint succeeded with ${result.value.credentialId}`);
  return result.error.code;
}

// ---------------------------------------------------------------------------
// THE SECRET
// ---------------------------------------------------------------------------

describe("the secret", () => {
  it("returns the raw token and stores only its digest", async () => {
    const ports = testPorts();
    const result = await mintBearerCredential(ports, platformCommand());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // THE PREFIX IS THE REGISTRY'S. A token minted under the wrong prefix would
    // be routed to the wrong store by `classifyToken` and never verify.
    expect(result.value.token.startsWith("plt_mcp_")).toBe(true);

    // AND NO STORED FIELD IS THE RAW VALUE. This is the assertion the whole
    // "one-time secret" contract rests on.
    //
    // IT IS A FIELD-BY-FIELD COMPARISON AND NOT A SUBSTRING SEARCH, deliberately:
    // the fake hasher spells its digest `digest(<secret>)`, so a `toContain`
    // check over the serialised row would fail on the FAKE's shape rather than on
    // the code's behaviour — and, worse, would pass against a real hasher no
    // matter what the row held. The property being asserted is that the only
    // field derived from the secret is the verifier.
    const rows = [...ports.repository.state.bearerCredentials.values()];
    expect(rows).toHaveLength(1);
    const stored = rows[0] as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(stored)) {
      expect(value, `${field} must not be the raw secret`).not.toBe(result.value.token);
    }
    expect(stored["tokenHash"]).toBe(ports.hasher.hash(result.value.token));
    expect(stored["tokenHash"]).not.toBe(result.value.token);
  });

  it("mints a different secret every time, for the same request", async () => {
    // TWO IDENTICAL COMMANDS MUST NOT SHARE A SECRET. If they did, an
    // idempotency replay and a genuine second mint would be indistinguishable —
    // and the second caller would be handed the first caller's credential.
    const ports = testPorts();
    const first = await mintBearerCredential(ports, platformCommand());
    const second = await mintBearerCredential(ports, platformCommand());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.token).not.toBe(second.value.token);
    expect(first.value.credentialId).not.toBe(second.value.credentialId);
    expect(ports.repository.state.bearerCredentials.size).toBe(2);
  });

  it("expires ninety days out by default, and at the requested instant otherwise", async () => {
    const ports = testPorts();
    const byDefault = await mintBearerCredential(ports, platformCommand());
    expect(byDefault.ok).toBe(true);
    if (!byDefault.ok) return;
    expect(byDefault.value.expiresAt.getTime()).toBe(
      T0.getTime() + DEFAULT_BEARER_TTL_SECONDS * 1000,
    );
    // THE INSTANT IS THE CLOCK'S, not `Date.now()`. A mint that read the wall
    // clock could not be replayed, which is why the port exists.
    const requested = await mintBearerCredential(ports, platformCommand({ ttlSeconds: 60 }));
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(requested.value.expiresAt.getTime()).toBe(T0.getTime() + 60_000);
  });
});

// ---------------------------------------------------------------------------
// THE SHAPE — one code per mistake
// ---------------------------------------------------------------------------

describe("the refusals", () => {
  it("refuses a blank or over-long label under CREDENTIAL_MATERIAL_INVALID", async () => {
    const ports = testPorts();
    expect(await refusalCode(ports, platformCommand({ label: "   " }))).toBe(
      "CREDENTIAL_MATERIAL_INVALID",
    );
    expect(
      await refusalCode(ports, platformCommand({ label: "x".repeat(MAX_BEARER_LABEL_LENGTH + 1) })),
    ).toBe("CREDENTIAL_MATERIAL_INVALID");
    // THE BOUNDARY IS INCLUSIVE, and it is the oracle's: `token.service.ts` says
    // "1–80 chars". A test that only checked 200 would not notice an off-by-one.
    const atLimit = await mintBearerCredential(
      ports,
      platformCommand({ label: "x".repeat(MAX_BEARER_LABEL_LENGTH) }),
    );
    expect(atLimit.ok).toBe(true);
    // NOTHING WAS WRITTEN BY THE REFUSALS: two refused mints and one accepted.
    expect(ports.repository.state.bearerCredentials.size).toBe(1);
  });

  it("refuses an empty permission list and a blank entry", async () => {
    const ports = testPorts();
    expect(await refusalCode(ports, platformCommand({ permissions: [] }))).toBe(
      "CREDENTIAL_MATERIAL_INVALID",
    );
    // A BLANK ENTRY IS NOT AN EMPTY LIST. `["agents.*", ""]` passes a length
    // check and grants nothing under the empty string; the legacy handler
    // accepted it.
    expect(await refusalCode(ports, platformCommand({ permissions: ["agents.*", ""] }))).toBe(
      "CREDENTIAL_MATERIAL_INVALID",
    );
  });

  it("refuses a lifetime that is zero, fractional, or longer than the cap", async () => {
    const ports = testPorts();
    expect(await refusalCode(ports, platformCommand({ ttlSeconds: 0 }))).toBe(
      "CREDENTIAL_MATERIAL_INVALID",
    );
    expect(await refusalCode(ports, platformCommand({ ttlSeconds: -1 }))).toBe(
      "CREDENTIAL_MATERIAL_INVALID",
    );
    expect(await refusalCode(ports, platformCommand({ ttlSeconds: 1.5 }))).toBe(
      "CREDENTIAL_MATERIAL_INVALID",
    );
    // THE CAP IS THIS MILESTONE'S AND NOT THE ORACLE'S. Neither legacy handler
    // has one, so both will issue a credential that outlives the company; the
    // constant's own note records that this is new rather than extracted.
    expect(
      await refusalCode(ports, platformCommand({ ttlSeconds: MAX_BEARER_TTL_SECONDS + 1 })),
    ).toBe("CREDENTIAL_MATERIAL_INVALID");
    const atCap = await mintBearerCredential(
      ports,
      platformCommand({ ttlSeconds: MAX_BEARER_TTL_SECONDS }),
    );
    expect(atCap.ok).toBe(true);
  });

  it("refuses a scope that is not ONE environment", async () => {
    const ports = testPorts();
    // AN ORGANIZATION SCOPE IS NOT A NARROWER ONE. A credential bounded by an
    // organization would pass every environment check inside it, which is the
    // opposite of what a scoped token is for.
    expect(
      await refusalCode(ports, platformCommand({ scope: organizationScope(ORGANIZATION) })),
    ).toBe("CREDENTIAL_MATERIAL_INVALID");
  });

  it("refuses a subject on the wrong kind under its OWN code", async () => {
    const ports = testPorts();
    // TWO DIFFERENT MISTAKES, TWO DIFFERENT CODES. "Fix the value you sent" and
    // "you are minting the wrong KIND" send a client to different places, and a
    // single `CREDENTIAL_MATERIAL_INVALID` for both would send it to the wrong
    // one half the time.
    expect(await refusalCode(ports, entityCommand({ subjectId: null }))).toBe(
      "CREDENTIAL_SUBJECT_MISMATCH",
    );
    expect(await refusalCode(ports, platformCommand({ subjectId: "entity-1" }))).toBe(
      "CREDENTIAL_SUBJECT_MISMATCH",
    );
  });

  it("refuses a permission tier on the kind whose table has no such column", async () => {
    const ports = testPorts();
    expect(await refusalCode(ports, platformCommand({ permissionTier: null }))).toBe(
      "CREDENTIAL_MATERIAL_INVALID",
    );
    expect(await refusalCode(ports, entityCommand({ permissionTier: "admin" }))).toBe(
      "CREDENTIAL_MATERIAL_INVALID",
    );
  });

  it("turns a store refusal into CREDENTIAL_MINT_REFUSED and never into a crash", async () => {
    const ports = testPorts();
    const first = await mintBearerCredential(ports, platformCommand());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // A DUPLICATE DIGEST IS THE REAL STORE'S UNIQUE CONSTRAINT, reproduced by
    // the double. The refusal must be a CONFLICT and not an "unavailable": the
    // store ANSWERED, and telling a caller "unavailable" would send it into a
    // retry loop against a decision.
    const clash = ports.repository.state.bearerCredentials;
    const existing = [...clash.values()][0];
    if (existing === undefined) throw new Error("nothing was written");
    // Force the next mint onto the same digest by making the minter repeat.
    const repeating = {
      ...ports,
      minter: { ...ports.minter, mint: () => first.value.token as never },
    };
    const result = await mintBearerCredential(repeating as TestPorts, platformCommand());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CREDENTIAL_MINT_REFUSED");
    expect(clash.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE KINDS
// ---------------------------------------------------------------------------

describe("the mintable kinds", () => {
  it("names exactly the two the schema has an oracle for", () => {
    expect([...MINTABLE_BEARER_KINDS]).toEqual(["mcp-token", "entity-bearer-token"]);
    // The two that are NOT mintable, and the reason is recorded in
    // `domain/bearer-token.ts`: `PersonalAccessToken` and `EndUserSession` have
    // zero production call sites, so nothing says what a minted `role` or
    // `identityId` should be.
    expect(isMintableBearerKind("personal-access-token")).toBe(false);
    expect(isMintableBearerKind("end-user-session")).toBe(false);
    expect(isMintableBearerKind("mcp-token")).toBe(true);
  });

  it("gives an entity token the self-referential principal the oracle uses", async () => {
    const ports = testPorts();
    const result = await mintBearerCredential(ports, entityCommand({ principalId: null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = [...ports.repository.state.bearerCredentials.values()][0];
    // `mcp:pat:<credential id>` — the oracle's default, and derived from the id
    // this use case minted rather than from anything a transport could compose.
    expect(row?.principalId).toBe(`mcp:pat:${result.value.credentialId}`);
    // AND THE OPERATOR IS STILL RECORDED SEPARATELY: an entity token acts as an
    // end user and is ISSUED by an operator, and dropping either would lose the
    // audit trail or mis-state the principal.
    expect(row?.tier).toBe("END_USER");
  });

  it("gives a platform token the operator's own principal and the OPERATOR tier", async () => {
    const ports = testPorts();
    const result = await mintBearerCredential(ports, platformCommand());
    expect(result.ok).toBe(true);
    const row = [...ports.repository.state.bearerCredentials.values()][0];
    expect(row?.principalId).toBe(OPERATOR);
    // `McpToken.tier` IS NOT THIS. The domain's tier is OPERATOR/END_USER; the
    // permission tier rides beside it and is reported on the view.
    expect(row?.tier).toBe("OPERATOR");
    expect(result.ok && result.value.permissionTier).toBe("scope");
  });
});

// ---------------------------------------------------------------------------
// THE STORE
// ---------------------------------------------------------------------------

describe("the record the caller is shown", () => {
  it("reports the permissions the STORE holds, not the ones the request sent", async () => {
    const ports = testPorts();
    const result = await mintBearerCredential(ports, platformCommand({ permissions: ["a", "b"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = [...ports.repository.state.bearerCredentials.values()][0];
    expect(result.value.permissions).toEqual(row?.permissions);
    // NOT VACUOUS: the row really holds them, so this is a join rather than an
    // echo of the input through two variables.
    expect(row?.permissions).toEqual(["a", "b"]);
  });

  it("carries the credential id the store wrote", async () => {
    const ports = testPorts();
    const result = await mintBearerCredential(ports, platformCommand());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = [...ports.repository.state.bearerCredentials.values()][0];
    expect(result.value.credentialId).toBe(row?.credentialId);
  });
});
