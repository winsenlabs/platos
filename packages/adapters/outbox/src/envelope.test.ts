// The envelope, and every refusal it carries.
//
// SEVEN CODES, PAIRWISE DISTINCT, and at least one case per code. FOUR are about
// a DRAFT a producer handed over and THREE about a ROW the database handed back,
// and the split matters to whoever reads the log: the first four are a defect in
// a producer, the last three are a corrupt row, a binary that needs rolling
// forward, or a writer this one has never met.

import { describe, expect, test } from "vitest";

import type {
  DomainEventDraft,
  EnvironmentId,
  JsonValue,
  OrganizationId,
  ProjectId,
  RequestId,
} from "@platos/kernel";
import { asIdentifier, environmentScope, organizationScope, projectScope } from "@platos/kernel";

import {
  decodeEnvelope,
  encodeEnvelope,
  ENVELOPE_FIELD_UNREADABLE,
  ENVELOPE_MARKER,
  ENVELOPE_VERSION,
  ENVELOPE_VERSION_UNKNOWN,
  environmentOf,
  NAME_INVALID,
  PAYLOAD_NOT_SERIALISABLE,
  ROW_PAYLOAD_NOT_OBJECT,
  SCHEMA_VERSION_INVALID,
  SCOPE_NOT_ENVIRONMENT,
  toStorableJson,
} from "./envelope.js";

const ORGANIZATION = asIdentifier<OrganizationId>("11111111-1111-4111-8111-111111111111");
const PROJECT = asIdentifier<ProjectId>("22222222-2222-4222-8222-222222222222");
const AT = new Date("2026-05-01T09:00:00.000Z");

/** The code a call refused with. Fails the case when the call did not refuse. */
function refusalOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : `<uncoded:${String(error)}>`;
  }
  return "<accepted>";
}

const scope = environmentScope(
  ORGANIZATION,
  PROJECT,
  asIdentifier<EnvironmentId>("33333333-3333-4333-8333-333333333333"),
);

function draft<Payload extends JsonValue>(
  overrides: Partial<DomainEventDraft<Payload>> & { readonly payload: Payload },
): DomainEventDraft<Payload> {
  return {
    name: "tenancy.invitation.issued",
    schemaVersion: 1,
    scope,
    requestId: null,
    ...overrides,
  };
}

describe("a draft becomes an object-rooted envelope", () => {
  test("the marker, the version, the request and the scope all survive", () => {
    const encoded = encodeEnvelope(draft({ payload: { invitationId: "inv-1" } }));
    expect(encoded[ENVELOPE_MARKER]).toBe(ENVELOPE_VERSION);
    expect(encoded["schemaVersion"]).toBe(1);
    expect(encoded["requestId"]).toBeNull();
    expect(encoded["scope"]).toEqual({ ...scope });
    expect(encoded["payload"]).toEqual({ invitationId: "inv-1" });
  });

  test("a payload that is NOT an object still produces an object root", () => {
    // `Event_payload_json_root` lives only in the migrations and requires
    // jsonb_typeof(payload) = 'object'. The kernel's JsonValue admits an array,
    // so this draft type-checks and would be refused by PostgreSQL if the
    // payload were stored bare.
    const encoded = encodeEnvelope(draft<JsonValue>({ payload: [1, 2, 3] }));
    expect(Array.isArray(encoded)).toBe(false);
    expect(encoded["payload"]).toEqual([1, 2, 3]);
  });

  test("the stored payload is a COPY, so a caller cannot reach into a written row", () => {
    const payload = { nested: { count: 1 } };
    const encoded = encodeEnvelope(draft({ payload }));
    payload.nested.count = 99;
    expect(encoded["payload"]).toEqual({ nested: { count: 1 } });
  });
});

describe("a draft is refused before anything is minted", () => {
  test("a name that is not dotted, lower-case and three-part is refused", () => {
    for (const name of ["Tenancy.Invitation.Issued", "tenancy.issued", "tenancy invitation issued", ""]) {
      expect(refusalOf(() => encodeEnvelope(draft({ name, payload: {} })))).toBe(NAME_INVALID);
    }
    expect(refusalOf(() => encodeEnvelope(draft({ name: "a.b.c-d", payload: {} })))).toBe("<accepted>");
  });

  test("a schema version that is not a positive whole number is refused", () => {
    for (const schemaVersion of [0, -1, 1.5, Number.NaN]) {
      expect(refusalOf(() => encodeEnvelope(draft({ schemaVersion, payload: {} })))).toBe(
        SCHEMA_VERSION_INVALID,
      );
    }
  });

  test("an organization-scoped event is refused: the row has no column for it", () => {
    // `privacy` emits organization-scoped erasure events today. This refusal is
    // the honest report of a schema limit, not a preference — Event.environmentId
    // is UUID NOT NULL with a live foreign key to Environment.
    expect(refusalOf(() => environmentOf(organizationScope(ORGANIZATION)))).toBe(
      SCOPE_NOT_ENVIRONMENT,
    );
    expect(
      refusalOf(() =>
        encodeEnvelope({
          name: "privacy.erasure.requested",
          schemaVersion: 1,
          scope: organizationScope(ORGANIZATION),
          requestId: null,
          payload: {},
        }),
      ),
    ).toBe(SCOPE_NOT_ENVIRONMENT);
  });

  test("a project-scoped event is refused by the same code", () => {
    expect(refusalOf(() => environmentOf(projectScope(ORGANIZATION, PROJECT)))).toBe(
      SCOPE_NOT_ENVIRONMENT,
    );
  });

  test("a payload JSON cannot carry is refused at the port", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(refusalOf(() => toStorableJson(cyclic as JsonValue))).toBe(PAYLOAD_NOT_SERIALISABLE);
    expect(refusalOf(() => toStorableJson(undefined as unknown as JsonValue))).toBe(
      PAYLOAD_NOT_SERIALISABLE,
    );
    expect(refusalOf(() => toStorableJson((() => 1) as unknown as JsonValue))).toBe(
      PAYLOAD_NOT_SERIALISABLE,
    );
  });
});

describe("a stored row is decoded, or refused with a code that says why", () => {
  const row = (payload: unknown) => ({
    eventId: "01926f9c-0000-7000-8000-000000000001",
    environmentId: "33333333-3333-4333-8333-333333333333",
    eventType: "tenancy.invitation.issued",
    payload,
    createdAt: AT,
  });

  test("a round trip through the envelope keeps every envelope field", () => {
    const encoded = encodeEnvelope(
      draft({ payload: { invitationId: "inv-1" }, requestId: asIdentifier<RequestId>("req-1") }),
    );
    const decoded = decodeEnvelope(row(encoded));
    expect(decoded.name).toBe("tenancy.invitation.issued");
    expect(decoded.schemaVersion).toBe(1);
    expect(decoded.requestId).toBe("req-1");
    expect(decoded.scope).toEqual({ ...scope });
    expect(decoded.payload).toEqual({ invitationId: "inv-1" });
    expect(decoded.occurredAt).toBe(AT);
  });

  test("a row written BEFORE the envelope existed reads as a scopeless event", () => {
    // Expand and contract, in the direction that actually happens: `Event` has a
    // live writer in the legacy tree that stores a bare body. Its rows have no
    // marker, no schemaVersion and no scope, and a reader that refused them
    // could not drain the table it is pointed at.
    const decoded = decodeEnvelope(row({ channel: "slack", messageId: "m-1" }));
    expect(decoded.scope).toBeNull();
    expect(decoded.schemaVersion).toBe(1);
    expect(decoded.requestId).toBeNull();
    expect(decoded.payload).toEqual({ channel: "slack", messageId: "m-1" });
  });

  test("a payload that is not a JSON object is refused", () => {
    for (const payload of [null, 7, "text", [1, 2]]) {
      expect(refusalOf(() => decodeEnvelope(row(payload)))).toBe(ROW_PAYLOAD_NOT_OBJECT);
    }
  });

  test("an envelope version this binary does not know is refused, not guessed", () => {
    expect(
      refusalOf(() => decodeEnvelope(row({ [ENVELOPE_MARKER]: ENVELOPE_VERSION + 1, payload: {} }))),
    ).toBe(ENVELOPE_VERSION_UNKNOWN);
  });

  test("a malformed field inside a known envelope is its own refusal", () => {
    const cases: readonly unknown[] = [
      { [ENVELOPE_MARKER]: 1, schemaVersion: "one", requestId: null, scope: { ...scope }, payload: {} },
      { [ENVELOPE_MARKER]: 1, schemaVersion: 1, requestId: 7, scope: { ...scope }, payload: {} },
      { [ENVELOPE_MARKER]: 1, schemaVersion: 1, requestId: null, scope: "nope", payload: {} },
      { [ENVELOPE_MARKER]: 1, schemaVersion: 1, requestId: null, scope: { level: "environment" }, payload: {} },
      {
        [ENVELOPE_MARKER]: 1,
        schemaVersion: 1,
        requestId: null,
        scope: { level: "galaxy", organizationId: "o", projectId: "p" },
        payload: {},
      },
    ];
    for (const payload of cases) {
      expect(refusalOf(() => decodeEnvelope(row(payload)))).toBe(ENVELOPE_FIELD_UNREADABLE);
    }
  });

  test("an organization-scoped envelope still decodes, because a reader must read what is there", () => {
    const decoded = decodeEnvelope(
      row({
        [ENVELOPE_MARKER]: 1,
        schemaVersion: 1,
        requestId: null,
        scope: { level: "organization", organizationId: "org-1" },
        payload: {},
      }),
    );
    expect(decoded.scope).toEqual({ level: "organization", organizationId: "org-1" });
  });

  test("the eight codes are pairwise distinct", () => {
    const codes = [
      NAME_INVALID,
      SCHEMA_VERSION_INVALID,
      SCOPE_NOT_ENVIRONMENT,
      PAYLOAD_NOT_SERIALISABLE,
      ROW_PAYLOAD_NOT_OBJECT,
      ENVELOPE_VERSION_UNKNOWN,
      ENVELOPE_FIELD_UNREADABLE,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });
});
