// The mapping, without a container.
//
// WHY THIS SUITE EXISTS BESIDE THE INTEGRATION ONES. A container only ever reads
// rows THIS binary wrote, so the branches that matter during an expand/contract
// window — a status a `Job` row never takes, an invocation type nobody knows, an
// envelope written before the marker existed — are reachable from it only
// through the rows `jobs-rules.integration.test.ts` plants as raw SQL. Here they
// are reachable directly, which is what lets the WRITE side be proven against
// the READ side as a round trip rather than through a database.
//
// AND ONE PROPERTY CAN ONLY BE STATED HERE. `writeApprovalEnvelope` and
// `readApprovalEnvelope` are inverses, and a round trip through both is the
// whole claim the ten column-less fields rest on. A test that wrote through the
// port and read back through the port would prove it too — and would also prove
// the driver works, the CHECK holds and the transaction committed, so a failure
// would not say which of the four broke.

import { describe, expect, test } from "vitest";

import type {
  Approval,
  ApprovalId,
  ApprovalRowId,
  EnvironmentId,
  JsonValue,
  OrganizationId,
  ProjectId,
} from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier, organizationScope, projectScope } from "@platos/context-jobs/application/ports/index.js";

import { UnreadableRowError } from "./mapping.js";
import {
  APPROVAL_METADATA_MARKER,
  APPROVAL_OUTCOME_MARKER,
  JOBS_UNKNOWN_WORK_STATUS,
  readApproval,
  readApprovalEnvelope,
  readApprovalOutcome,
  readApprovalStatus,
  readInvocationType,
  readJob,
  readJobStatus,
  readPayloadSchema,
  scopedWhere,
  tenantWhere,
  UNKNOWN_APPROVAL_STATUS,
  UNKNOWN_INVOCATION_TYPE,
  UNREADABLE_APPROVAL_ENVELOPE,
  UNREADABLE_PAYLOAD_SCHEMA,
  writeApprovalEnvelope,
  writeApprovalOutcome,
  type ApprovalRow,
  type JobRow,
} from "./jobs-rows.js";

const AT = new Date("2026-05-01T09:00:00.000Z");
const ORG = asIdentifier<OrganizationId>("aaaaaaaa-0001-4000-8000-000000000001");
const PROJECT = asIdentifier<ProjectId>("aaaaaaaa-0002-4000-8000-000000000001");
const ENVIRONMENT = asIdentifier<EnvironmentId>("aaaaaaaa-0003-4000-8000-000000000001");

function jobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "aaaaaaaa-0004-4000-8000-000000000001",
    environmentId: ENVIRONMENT,
    externalId: "nightly-rollup",
    displayName: "Nightly rollup",
    description: null,
    invocationType: "manual",
    scheduleCron: null,
    scheduleTimezone: null,
    allowedAgentIds: [],
    payloadSchema: null,
    handler: "async function run() {}",
    timeoutSeconds: 300,
    maxRetries: 0,
    status: "ACTIVE",
    createdBy: "operator-1",
    lastStartedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function approvalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "aaaaaaaa-0005-4000-8000-000000000001",
    environmentId: ENVIRONMENT,
    agentId: null,
    threadId: null,
    turnId: null,
    action: "Delete the production database",
    details: null,
    status: "PENDING",
    timeoutSeconds: 300,
    resolvedAt: null,
    respondedBy: null,
    comment: null,
    toolName: null,
    arguments: null,
    resolution: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function anApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    rowId: asIdentifier<ApprovalRowId>("aaaaaaaa-0005-4000-8000-000000000001"),
    approvalId: asIdentifier<ApprovalId>("appr-0001"),
    source: "request_approval",
    agentId: null,
    threadId: null,
    turnId: null,
    action: "Delete the production database",
    details: null,
    toolName: null,
    arguments: null,
    requestedBy: null,
    requestDigest: null,
    requestedByTokenId: null,
    status: "pending",
    timeoutSeconds: 300,
    createdAt: AT,
    updatedAt: AT,
    resolution: null,
    consumedAt: null,
    outcome: null,
    ...overrides,
  };
}

function codeOf(work: () => unknown): string {
  try {
    work();
    return "<no refusal>";
  } catch (error) {
    return error instanceof UnreadableRowError ? error.code : `<${String(error)}>`;
  }
}

describe("the three stored vocabularies are validated, not cast", () => {
  test("Job.status maps the two a Job row takes and refuses the other three by name", () => {
    expect(readJobStatus("ACTIVE")).toBe("active");
    expect(readJobStatus("FAILED")).toBe("registration-failed");
    for (const other of ["PENDING", "SUCCEEDED", "CANCELLED", "SOMETHING_NEW"]) {
      expect(codeOf(() => readJobStatus(other))).toBe(JOBS_UNKNOWN_WORK_STATUS);
    }
  });

  test("Job.triggerType admits the four stored types and refuses `agent`, which is CLAIMED", () => {
    // `agent` is a CLAIMED invoker and never a STORED type — `domain/invocation.ts`
    // makes that asymmetry the whole content of the module — so a row holding it
    // is a row this binary cannot describe.
    for (const type of ["manual", "schedule", "webhook", "agent-spawn"]) {
      expect(readInvocationType(type)).toBe(type);
    }
    expect(codeOf(() => readInvocationType("agent"))).toBe(UNKNOWN_INVOCATION_TYPE);
    expect(codeOf(() => readInvocationType("cron"))).toBe(UNKNOWN_INVOCATION_TYPE);
  });

  test("AgentApproval.status maps all four, and EXPIRED is the pair that does not match by name", () => {
    expect(readApprovalStatus("PENDING")).toBe("pending");
    expect(readApprovalStatus("APPROVED")).toBe("approved");
    expect(readApprovalStatus("REJECTED")).toBe("rejected");
    expect(readApprovalStatus("EXPIRED")).toBe("timed_out");
    expect(codeOf(() => readApprovalStatus("TIMED_OUT"))).toBe(UNKNOWN_APPROVAL_STATUS);
  });

  test("the three refusals carry three DISTINCT codes", () => {
    const codes = [JOBS_UNKNOWN_WORK_STATUS, UNKNOWN_INVOCATION_TYPE, UNKNOWN_APPROVAL_STATUS];
    expect(new Set(codes).size).toBe(3);
  });
});

describe("Job.payloadSchema is validated against its CHECK", () => {
  test("null and an object read; an array, a string and a number do not", () => {
    expect(readPayloadSchema(null)).toBeNull();
    expect(readPayloadSchema(undefined)).toBeNull();
    expect(readPayloadSchema({ type: "object" })).toEqual({ type: "object" });
    for (const bad of [[1, 2], "schema", 7, true]) {
      expect(codeOf(() => readPayloadSchema(bad))).toBe(UNREADABLE_PAYLOAD_SCHEMA);
    }
  });
});

describe("the approval envelope round-trips every one of its ten column-less fields", () => {
  test("write then read is the identity on a fully populated approval", () => {
    const approval = anApproval({
      approvalId: asIdentifier<ApprovalId>("appr-mcp-1"),
      source: "mcp_tool_call",
      arguments: { query: "platos" },
      requestedBy: "subject-a",
      requestDigest: asIdentifier("h1"),
      requestedByTokenId: "tok-1",
      consumedAt: new Date("2026-05-02T00:00:00.000Z"),
      status: "approved",
      resolution: {
        status: "approved",
        respondedBy: "operator-9",
        comment: "fine",
        resolvedAt: AT,
        edit: { editedArguments: { query: "platos labs" }, editedBy: "operator-9" },
      },
    });
    const envelope = readApprovalEnvelope(writeApprovalEnvelope(approval));
    expect(envelope).toEqual({
      approvalId: "appr-mcp-1",
      source: "mcp_tool_call",
      requestedBy: "subject-a",
      requestHash: "h1",
      requestedByMcpTokenId: "tok-1",
      consumedAt: "2026-05-02T00:00:00.000Z",
      editedArgs: { query: "platos labs" },
      editedByUserId: "operator-9",
      value: { query: "platos" },
    });
  });

  test("a row with NO marker is a legacy row and the whole object is its arguments", () => {
    // The one deliberate divergence from the live `readArguments`, which answers
    // `value: null` for such a row and discards its arguments on every read.
    expect(readApprovalEnvelope({ table: "orders" })).toMatchObject({
      approvalId: "",
      source: "request_approval",
      value: { table: "orders" },
    });
  });

  test("SQL NULL is the absent envelope, and a non-object column is unreadable", () => {
    expect(readApprovalEnvelope(null)).toMatchObject({ approvalId: "", value: null });
    expect(codeOf(() => readApprovalEnvelope("nope"))).toBe(UNREADABLE_APPROVAL_ENVELOPE);
    expect(codeOf(() => readApprovalEnvelope([1, 2]))).toBe(UNREADABLE_APPROVAL_ENVELOPE);
    expect(
      codeOf(() => readApprovalEnvelope({ [APPROVAL_METADATA_MARKER]: "nope" })),
    ).toBe(UNREADABLE_APPROVAL_ENVELOPE);
  });

  test("the refusal names the COLUMN it found the problem in, not just the row", () => {
    // The metadata guard and the field guards share one CODE, because a caller
    // has one thing to do about either. An OPERATOR does not: "the envelope is
    // not an object" and "the approvalId inside it is a number" are two
    // different repairs, and the column is where that distinction is carried.
    const columnOf = (work: () => unknown): string => {
      try {
        work();
        return "<no refusal>";
      } catch (error) {
        return error instanceof UnreadableRowError ? error.column : `<${String(error)}>`;
      }
    };
    expect(columnOf(() => readApprovalEnvelope({ [APPROVAL_METADATA_MARKER]: "nope" }))).toBe(
      `AgentApproval.arguments.${APPROVAL_METADATA_MARKER}`,
    );
    expect(
      columnOf(() =>
        readApprovalEnvelope({ [APPROVAL_METADATA_MARKER]: { approvalId: 7, source: "x" } }),
      ),
    ).toBe("arguments.__platosApproval.approvalId");
    expect(columnOf(() => readApprovalEnvelope("nope"))).toBe("AgentApproval.arguments");
  });

  test("a metadata field of the wrong type is unreadable rather than coerced", () => {
    for (const metadata of [
      { approvalId: 7, source: "request_approval" },
      { approvalId: "a", source: 7 },
      { approvalId: "a", source: "request_approval", requestedBy: 7 },
      { approvalId: "a", source: "request_approval", requestHash: [] },
      { approvalId: "a", source: "request_approval", requestedByMcpTokenId: {} },
      { approvalId: "a", source: "request_approval", editedByUserId: 1 },
    ]) {
      expect(
        codeOf(() => readApprovalEnvelope({ [APPROVAL_METADATA_MARKER]: metadata })),
      ).toBe(UNREADABLE_APPROVAL_ENVELOPE);
    }
  });
});

describe("the outcome envelope", () => {
  test("every JsonValue survives the wrap, including the ones the column refuses", () => {
    for (const value of [
      null,
      7,
      "done",
      true,
      [1, 2, 3],
      { ok: true },
      { nested: { deep: [1] } },
    ] as readonly JsonValue[]) {
      expect(readApprovalOutcome(writeApprovalOutcome(value))).toEqual(value);
    }
  });

  test("a null outcome is SQL NULL rather than a wrapper holding null", () => {
    // The distinction the `_json_root` CHECK makes: a JSON `null` has
    // `jsonb_typeof` `'null'` and is refused; SQL NULL is admitted by the
    // constraint's first clause.
    expect(writeApprovalOutcome(null)).toBeNull();
  });

  test("an object with no marker reads back as itself — the live path's rows", () => {
    expect(readApprovalOutcome({ ok: true })).toEqual({ ok: true });
    // Including the lossy wrapper that path wrote for a non-object, which is the
    // most that can be recovered from a wrapper that never said whether it was one.
    expect(readApprovalOutcome({ value: 5 })).toEqual({ value: 5 });
  });

  test("a NESTED marker is a value, because only the root is inspected", () => {
    const nested = { detail: { [APPROVAL_OUTCOME_MARKER]: 7 } };
    expect(readApprovalOutcome(writeApprovalOutcome(nested))).toEqual(nested);
  });
});

describe("readJob and readApproval assemble whole aggregates", () => {
  test("a NULL allowedAgentIds reads as the empty list, which the DDL permits", () => {
    expect(readJob(jobRow({ allowedAgentIds: null })).allowedAgentIds).toEqual([]);
    expect(readJob(jobRow({ allowedAgentIds: ["a", "b"] })).allowedAgentIds).toEqual(["a", "b"]);
  });

  test("a null externalId is a job with no key, which can be read and never dispatched", () => {
    expect(readJob(jobRow({ externalId: null })).jobKey).toBeNull();
  });

  test("the schedule and the budget are re-nested from their four flat columns", () => {
    const job = readJob(
      jobRow({ scheduleCron: "0 * * * *", scheduleTimezone: "Europe/London", maxRetries: 3 }),
    );
    expect(job.schedule).toEqual({ cron: "0 * * * *", timezone: "Europe/London" });
    expect(job.budget).toEqual({ timeoutSeconds: 300, maxRetries: 3 });
  });

  test("a PENDING approval has no resolution, whatever the decision columns hold", () => {
    const approval = readApproval(
      approvalRow({ respondedBy: "operator-legacy", comment: "stale", resolvedAt: AT }),
    );
    expect(approval.resolution).toBeNull();
  });

  test("a decided approval with no resolvedAt falls back to updatedAt", () => {
    const later = new Date("2026-06-01T12:00:00.000Z");
    const approval = readApproval(
      approvalRow({ status: "APPROVED", respondedBy: "operator-9", updatedAt: later }),
    );
    expect(approval.resolution).toEqual({
      status: "approved",
      respondedBy: "operator-9",
      comment: null,
      resolvedAt: later,
      edit: null,
    });
  });

  test("a consumedAt that is not an instant is unreadable rather than an Invalid Date", () => {
    expect(
      codeOf(() =>
        readApproval(
          approvalRow({
            arguments: {
              [APPROVAL_METADATA_MARKER]: {
                approvalId: "a",
                source: "request_approval",
                consumedAt: "not-a-date",
              },
            },
          }),
        ),
      ),
    ).toBe(UNREADABLE_APPROVAL_ENVELOPE);
  });
});

describe("the two scope filters", () => {
  test("scopedWhere is the environment and nothing else", () => {
    expect(
      scopedWhere({
        level: "environment",
        organizationId: ORG,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
      }),
    ).toEqual({ environmentId: ENVIRONMENT });
  });

  test("tenantWhere resolves containment through the tree rather than by widening it", () => {
    // An `IN` list built from a prior read of the environments is the N+1 this
    // shape exists to keep out of the erasure; each of the three levels below is
    // ONE relation filter the database resolves in the same statement.
    expect(
      tenantWhere({
        level: "environment",
        organizationId: ORG,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
      }),
    ).toEqual({ environmentId: ENVIRONMENT });
    expect(tenantWhere(projectScope(ORG, PROJECT))).toEqual({
      environment: { projectId: PROJECT },
    });
    expect(tenantWhere(organizationScope(ORG))).toEqual({
      environment: { project: { organizationId: ORG } },
    });
  });
});
