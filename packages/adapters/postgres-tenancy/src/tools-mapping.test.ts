// The pure half of the tools store: row -> record, and the audit envelope's
// layout. No database, no container, no client.
//
// It runs in `vitest run` rather than in the integration job, and that is the
// point of the structural row types `./tools-rows.ts` takes: a mapping suite
// that could only run after `prisma generate` is a suite nobody runs. Everything
// here is a decision that can be subtly wrong and is invisible in an integration
// assertion — which member of a union a column may hold, which shape of `Json`
// becomes what, and where in one column two different things live.

import { describe, expect, test } from "vitest";

import { EMPTY_AUDIT_ENVELOPE } from "@platos/context-tools/application/ports/index.js";

import {
  AUDIT_ENVELOPE_KEY,
  AUDIT_VALUE_KEY,
  readAuditArguments,
  readResult,
  SCALAR_RESULT_KEY,
  toAuditEntry,
  writeAuditArguments,
  writeResult,
  type AuditRow,
} from "./tools-audit-rows.js";
import {
  readJsonObject,
  readJsonObjects,
  readStringMap,
  readUnion,
  toExposure,
  toTool,
  UNKNOWN_TOOLS_UNION_MEMBER,
  UnreadableToolsRowError,
  type ExposureRow,
  type ToolRow,
} from "./tools-rows.js";
import { guarded } from "./tools-scope.js";

const AT = new Date("2026-05-01T09:00:00.000Z");

const TOOL: ToolRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "alpha.search",
  description: "search",
  kind: "ENTITY",
  paramSchema: { type: "object" },
  category: "search",
  schemaHash: "0123456789abcdef",
  createdAt: AT,
  updatedAt: AT,
};

function exposureRow(overrides: Partial<ExposureRow> = {}): ExposureRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    environmentId: "33333333-3333-4333-8333-333333333333",
    entityId: "44444444-4444-4444-8444-444444444444",
    enabled: true,
    callbackUrl: "https://backend.example.test/hooks",
    tool: TOOL,
    entity: {
      externalId: "acme",
      connectionKind: "wire",
      mcpClient: null,
      mcpConfig: null,
    },
    ...overrides,
  };
}

describe("union columns are validated, not cast", () => {
  test("a member this binary knows is narrowed", () => {
    expect(readUnion("Tool.kind", ["ENTITY", "RUNTIME"] as const, "RUNTIME")).toBe("RUNTIME");
  });

  test("a member it does not know is refused, with the column named", () => {
    let caught: unknown;
    try {
      readUnion("EntityMcpClient.transport", ["http", "sse"] as const, "grpc");
    } catch (error) {
      caught = error;
    }
    // The column is in the message because "this row is not readable by this
    // binary" is an operational event during an expand/contract window, and an
    // operator reading it has to know WHICH row and WHICH column.
    expect(caught).toBeInstanceOf(UnreadableToolsRowError);
    expect((caught as UnreadableToolsRowError).code).toBe(UNKNOWN_TOOLS_UNION_MEMBER);
    expect((caught as UnreadableToolsRowError).column).toBe("EntityMcpClient.transport");
    expect((caught as Error).message).toContain("grpc");
  });
});

describe("Json columns", () => {
  test("an ARRAY is not an object, even though typeof says otherwise", () => {
    // `typeof [] === "object"`. A caller that spread one would produce header
    // names `0`, `1`, `2`, which is a silently wrong outbound request.
    expect(readJsonObject(["a", "b"])).toEqual({});
    expect(readJsonObject(null)).toEqual({});
    expect(readJsonObject("a string")).toEqual({});
    expect(readJsonObject({ a: 1 })).toEqual({ a: 1 });
  });

  test("readJsonObjects keeps only object members", () => {
    expect(readJsonObjects([{ kind: "bearer" }, "x", null, ["y"]])).toEqual([{ kind: "bearer" }]);
    expect(readJsonObjects({ not: "an array" })).toEqual([]);
  });

  test("a non-string header value is DROPPED rather than stringified", () => {
    // A number coerced to a header value is a silently wrong request; an absent
    // header is a visible 401.
    expect(readStringMap({ Authorization: "Bearer x", Retry: 3 })).toEqual({
      Authorization: "Bearer x",
    });
  });
});

describe("Tool and exposure mapping", () => {
  test("a NULL category becomes the empty string, never null", () => {
    expect(toTool({ ...TOOL, category: null }).category).toBe("");
  });

  test("a wire exposure is dispatchable when its callback is absolute", () => {
    expect(toExposure(exposureRow(), []).dispatchable).toBe(true);
    expect(toExposure(exposureRow({ callbackUrl: null }), []).dispatchable).toBe(false);
    // A `ws://` upgrade and a relative path are the two shapes a backend that
    // can only be reached over its live socket sends.
    expect(toExposure(exposureRow({ callbackUrl: "ws://x/y" }), []).dispatchable).toBe(false);
    expect(toExposure(exposureRow({ callbackUrl: "/hooks" }), []).dispatchable).toBe(false);
  });

  test("an mcp exposure is dispatchable only when a client row exists", () => {
    const row = exposureRow({
      entity: { externalId: "acme", connectionKind: "mcp", mcpClient: null, mcpConfig: null },
    });
    expect(toExposure(row, []).dispatchable).toBe(false);
    const withClient = exposureRow({
      entity: {
        externalId: "acme",
        connectionKind: "mcp",
        mcpClient: { entityId: "e" },
        mcpConfig: { injectMcpContext: true },
      },
    });
    const resolved = toExposure(withClient, []);
    // The callback is irrelevant to an MCP entity, and `injectMcpContext` rides
    // on the exposure so dispatch need not read the config row again.
    expect({ dispatchable: resolved.dispatchable, inject: resolved.injectMcpContext }).toEqual({
      dispatchable: true,
      inject: true,
    });
  });

  test("a null callback becomes the empty string on the record", () => {
    expect(toExposure(exposureRow({ callbackUrl: null }), []).callbackUrl).toBe("");
  });
});

describe("the audit envelope's layout", () => {
  const envelope = {
    externalEntityId: "acme",
    endUserId: "user-1",
    actorUserId: "operator-1",
    spanId: "span-1",
    parentSpanId: null,
    source: "mcp",
    mcpPrincipalId: "mcp:pat:1",
    mcpClientId: "client-1",
  } as const;

  const entry = {
    envelope,
    arguments: { q: "hello" },
  } as unknown as Parameters<typeof writeAuditArguments>[0];

  test("the reserved keys are the SOURCE's, not this adapter's", () => {
    // Changing either orphans every row already written, and makes the shipping
    // list endpoint unable to read a row this adapter wrote.
    expect(AUDIT_ENVELOPE_KEY).toBe("__platosAudit");
    expect(AUDIT_VALUE_KEY).toBe("value");
    const packed = writeAuditArguments(entry) as Record<string, Record<string, unknown>>;
    expect(Object.keys(packed).sort()).toEqual(["__platosAudit", "value"]);
    // Two of the source's names are not the domain's, and the difference is
    // carried rather than renamed away.
    expect(packed.__platosAudit?.entityId).toBe("acme");
    expect(packed.__platosAudit?.mcpUserId).toBe("mcp:pat:1");
  });

  test("what is written comes back unchanged", () => {
    expect(readAuditArguments(writeAuditArguments(entry))).toEqual({
      envelope,
      argumentsValue: { q: "hello" },
    });
  });

  test("a row with no reserved key is a PRE-ENVELOPE row, not a corrupt one", () => {
    // Its whole column is the arguments. This is the expand/contract read the
    // adapter owes rows already in the database.
    expect(readAuditArguments({ q: "unsealed", n: 2 })).toEqual({
      envelope: EMPTY_AUDIT_ENVELOPE,
      argumentsValue: { q: "unsealed", n: 2 },
    });
  });

  test("a source this binary has not heard of reads as null, not as a refusal", () => {
    const read = readAuditArguments({ __platosAudit: { source: "telepathy" }, value: {} });
    expect(read.envelope.source).toBeNull();
  });

  test("a scalar result is wrapped on the way in and unwrapped on the way out", () => {
    // `ToolCallAudit_result_json_root` admits only an object or an array, and
    // `AuditEntry.result` is `unknown`.
    expect(writeResult(42)).toEqual({ [SCALAR_RESULT_KEY]: 42 });
    expect(writeResult("s")).toEqual({ [SCALAR_RESULT_KEY]: "s" });
    expect(writeResult(null)).toBeNull();
    expect(writeResult(undefined)).toBeNull();
    // An object and an array are already legal roots and pass through.
    expect(writeResult({ rows: 1 })).toEqual({ rows: 1 });
    expect(writeResult([1, 2])).toEqual([1, 2]);
    expect(readResult(writeResult(42))).toBe(42);
    expect(readResult(writeResult([1, 2]))).toEqual([1, 2]);
    expect(readResult(null)).toBeNull();
  });

  test("the endUserId COLUMN wins over the envelope's copy", () => {
    // After erasure the column is null and the envelope still names the subject.
    // Reading the envelope first would resurrect an identity erasure removed.
    const row: AuditRow = {
      id: "55555555-5555-4555-8555-555555555555",
      environmentId: "33333333-3333-4333-8333-333333333333",
      toolId: null,
      toolName: "alpha.search",
      agentId: null,
      threadId: null,
      endUserId: null,
      traceId: null,
      arguments: writeAuditArguments(entry),
      result: null,
      error: null,
      status: "SUCCEEDED",
      latencyMs: 3,
      costCents: null,
      createdAt: AT,
    };
    const mapped = toAuditEntry(row);
    expect(mapped.endUserId).toBeNull();
    expect(mapped.envelope.endUserId).toBe("user-1");
  });

  test("costCents is a STRING and never a number", () => {
    const row: AuditRow = {
      id: "55555555-5555-4555-8555-555555555556",
      environmentId: "33333333-3333-4333-8333-333333333333",
      toolId: null,
      toolName: "alpha.search",
      agentId: null,
      threadId: null,
      endUserId: null,
      traceId: null,
      arguments: {},
      result: null,
      error: null,
      status: "FAILED",
      latencyMs: 3,
      // `Decimal(18, 6)` does not fit a double. The driver hands back an object.
      costCents: { toString: () => "123456789012.345678" },
      createdAt: AT,
    };
    expect(toAuditEntry(row).costCents).toBe("123456789012.345678");
  });
});

// ---------------------------------------------------------------------------
// The driver-failure boundary. `guarded` is the ONE place this port's promise
// — "a store failure is a business outcome, not an exception" — is kept, and
// the two rules it holds are invisible in every integration assertion because
// both are about what a THROW becomes. Neither had a case until the tranche-5
// mutation sweep found both guards unfalsifiable.
// ---------------------------------------------------------------------------

describe("what a throw becomes on the way out of the store", () => {
  test("a TransactionScopeError is RE-THROWN, never folded into a Result", async () => {
    // It means a write was issued outside its unit of work — a defect in the
    // composition, not an outcome a use case can handle. Swallowing it into a
    // refusal would let a write that never ran read as a store that was busy,
    // and every caller would carry on.
    const scopeError = Object.assign(new Error("no transaction is open"), {
      name: "TransactionScopeError",
    });
    await expect(
      guarded("replaceExposures", async () => {
        throw scopeError;
      }),
    ).rejects.toBe(scopeError);
  });

  test("any OTHER driver error becomes a refusal that names the driver's code", async () => {
    const unique = Object.assign(new Error("unique violation"), { code: "P2002" });
    const refused = await guarded("saveCall", async () => {
      throw unique;
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.error.details.reason).toBe("saveCall:P2002");
  });

  test("a CLIENT-SIDE validation error carries no code, so the refusal names its CLASS", async () => {
    // The distinction this case pins: `saveCall:P2002` is a constraint the
    // database refused and `saveCall:PrismaClientValidationError` is a bug in
    // this package. Falling back to the literal `unknown` made the two read
    // identically, which cost an hour on the first real run of the constraints
    // suite. Two guards returning one string cannot be told apart.
    const validation = Object.assign(new Error("Invalid value for argument"), {
      name: "PrismaClientValidationError",
    });
    const refused = await guarded("saveCall", async () => {
      throw validation;
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.error.details.reason).toBe(
      "saveCall:PrismaClientValidationError",
    );
  });

  test("a thrown value that is not an object at all still refuses, and says so", async () => {
    const refused = await guarded("pageAudit", async () => {
      throw "a string";
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.error.details.reason).toBe("pageAudit:unknown");
  });
});
