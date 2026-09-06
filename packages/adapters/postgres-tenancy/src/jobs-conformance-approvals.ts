// The `AgentApproval` half of the one scenario. `jobs-conformance.ts` drives the
// `Job` half and holds the header, the clock and the two projections; both write
// into ONE observation map keyed by step name, so the differential still
// compares one object per store.
//
// IT IS A SECOND FILE FOR THE REASON `governance`'s SCENARIO IS TWO. The two
// aggregates share an owner and a scope and nothing else — `domain/index.ts`
// says so — and every question below is about a decision a human is waiting on,
// where every question in the other half is about a definition of work. A
// reader looking for "what does resolving twice do" should not have to read past
// a job's schedule to find it.
//
// THE ORDER OF THE STEPS IS THE CONTRACT. The dedupe lookup is asked AFTER both
// digest rows exist and BEFORE either is resolved, because "the most recent
// PENDING approval whose digest matches" is three predicates and a scenario that
// asked it once could satisfy it by accident on any one of them. The erasure is
// asked LAST, because it destroys the rows every earlier step reads.

import type {
  Approval,
  ApprovalId,
  ApprovalPage,
  ApprovalQuery,
  EnvironmentScope,
  JsonValue,
  RequestDigest,
} from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier, organizationScope } from "@platos/context-jobs/application/ports/index.js";
import { runResult } from "@platos/context-jobs/application/ports/index.js";

import type {
  ApprovalConformanceIds,
  JobsConformanceEnvironment,
  JobsObservation,
} from "./jobs-conformance.js";
import { outcome, projectApproval, WIDE_WINDOW_DAYS } from "./jobs-conformance.js";

/** The three principals the erasure half tells apart. */
const REQUESTER = "subject-a";
const MCP_REQUESTER = "subject-b";
const CANCELLER = "subject-c";
const OPERATOR = "operator-9";

function maybeApproval(approval: Approval | null): unknown {
  return approval === null ? null : projectApproval(approval);
}

function projectPage(page: ApprovalPage): Record<string, unknown> {
  return {
    approvalIds: page.rows.map((row) => row.approvalId),
    total: page.total,
    pendingCount: page.pendingCount,
    limit: page.limit,
    offset: page.offset,
  };
}

/** The window every listing here asks for; see `jobs-conformance.ts`'s header. */
function wide(query: Partial<ApprovalQuery> = {}): ApprovalQuery {
  return { sinceDays: WIDE_WINDOW_DAYS, ...query };
}

export async function runApprovalConformance(
  environment: JobsConformanceEnvironment,
  observed: JobsObservation,
  clock: () => Date,
  ids: ApprovalConformanceIds,
): Promise<void> {
  const { stores, scope } = environment;
  const store = stores.approvals;

  function anApproval(index: 0 | 1 | 2 | 3, overrides: Partial<Approval>): Approval {
    const at = clock();
    return {
      rowId: ids.rowIds[index],
      approvalId: asIdentifier<ApprovalId>("appr-0000"),
      source: "request_approval",
      agentId: null,
      threadId: null,
      turnId: null,
      action: "Delete the production database",
      details: null,
      toolName: null,
      arguments: null,
      requestedBy: REQUESTER,
      requestDigest: null,
      requestedByTokenId: null,
      status: "pending",
      timeoutSeconds: 300,
      createdAt: at,
      updatedAt: at,
      resolution: null,
      consumedAt: null,
      outcome: null,
      ...overrides,
    };
  }

  // The generic request: the only row carrying the whole peer chain, because
  // `enforce_domain_ancestry` demands all three agree and this is the row that
  // proves they can.
  const request = anApproval(0, {
    approvalId: asIdentifier<ApprovalId>("appr-req-0001"),
    agentId: ids.agentId,
    threadId: ids.threadId,
    turnId: ids.turnId,
    details: "irreversible",
    arguments: { table: "orders" },
  });
  const firstMcp = anApproval(1, {
    approvalId: asIdentifier<ApprovalId>("appr-mcp-0001"),
    source: "mcp_tool_call",
    action: "MCP tool call: web_search",
    toolName: "web_search",
    arguments: { query: "platos" },
    requestedBy: MCP_REQUESTER,
    requestDigest: asIdentifier<RequestDigest>("d1"),
    requestedByTokenId: "tok-1",
    timeoutSeconds: 3600,
  });
  const secondMcp = anApproval(2, {
    approvalId: asIdentifier<ApprovalId>("appr-mcp-0002"),
    source: "mcp_tool_call",
    action: "MCP tool call: web_search",
    toolName: "web_search",
    arguments: { query: "platos" },
    requestedBy: MCP_REQUESTER,
    requestDigest: asIdentifier<RequestDigest>("d1"),
    requestedByTokenId: "tok-1",
    timeoutSeconds: 3600,
  });
  const cancellation = anApproval(3, {
    approvalId: asIdentifier<ApprovalId>("appr-cancel-0001"),
    source: "cancel_run",
    action: "Cancel the run",
    agentId: ids.agentId,
    threadId: ids.threadId,
    turnId: ids.secondTurnId,
    requestedBy: CANCELLER,
  });

  for (const [name, approval] of [
    ["request", request],
    ["firstMcp", firstMcp],
    ["secondMcp", secondMcp],
    ["cancellation", cancellation],
  ] as const) {
    observed[`approvals.insert.${name}`] = outcome(
      await runResult(environment, (transaction) => store.insertApproval(scope, approval, transaction)),
      projectApproval,
    );
  }

  observed["approvals.find.byApprovalId"] = outcome(
    await store.findByApprovalId(scope, request.approvalId),
    maybeApproval,
  );
  observed["approvals.find.byAbsentApprovalId"] = outcome(
    await store.findByApprovalId(scope, ids.absentApprovalId),
    maybeApproval,
  );
  observed["approvals.find.byRowId"] = outcome(
    await store.findByRowId(scope, firstMcp.rowId),
    maybeApproval,
  );
  observed["approvals.find.byAbsentRowId"] = outcome(
    await store.findByRowId(scope, ids.absentRowId),
    maybeApproval,
  );

  // MOST RECENT, PENDING, `mcp_tool_call` — three predicates, and the answer has
  // to be the SECOND of the two rows sharing the digest.
  observed["approvals.dedupe.hit"] = outcome(
    await store.findPendingByDigest(scope, asIdentifier<RequestDigest>("d1")),
    maybeApproval,
  );
  observed["approvals.dedupe.miss"] = outcome(
    await store.findPendingByDigest(scope, asIdentifier<RequestDigest>("d9")),
    maybeApproval,
  );

  observed["approvals.list.all"] = outcome(await store.list(scope, wide()), projectPage);
  observed["approvals.list.pending"] = outcome(
    await store.list(scope, wide({ status: "pending" })),
    projectPage,
  );
  observed["approvals.list.bySource"] = outcome(
    await store.list(scope, wide({ source: "mcp_tool_call" })),
    projectPage,
  );
  observed["approvals.list.byThread"] = outcome(
    await store.list(scope, wide({ threadId: ids.threadId })),
    projectPage,
  );
  observed["approvals.list.byAgent"] = outcome(
    await store.list(scope, wide({ agentId: ids.agentId })),
    projectPage,
  );
  observed["approvals.list.bySearch"] = outcome(
    await store.list(scope, wide({ search: "PRODUCTION" })),
    projectPage,
  );
  observed["approvals.list.window"] = outcome(
    await store.list(scope, wide({ limit: 2, offset: 1 })),
    projectPage,
  );
  observed["approvals.list.pastTheEnd"] = outcome(
    await store.list(scope, wide({ offset: 99 })),
    projectPage,
  );

  // THE CONDITIONAL WRITE. The first decision transitions the row; a second one
  // lands on nothing, whatever it says.
  const decidedAt = clock();
  const decided: Approval = {
    ...request,
    status: "approved",
    updatedAt: decidedAt,
    resolution: {
      status: "approved",
      respondedBy: OPERATOR,
      comment: "checked with the on-call",
      resolvedAt: decidedAt,
      edit: { editedArguments: { table: "orders", limit: 10 }, editedBy: OPERATOR },
    },
  };
  observed["approvals.resolve.first"] = outcome(
    await runResult(environment, (transaction) => store.resolve(scope, decided, transaction)),
    (moved) => moved,
  );
  const rivalAt = clock();
  observed["approvals.resolve.second"] = outcome(
    await runResult(environment, (transaction) =>
      store.resolve(
        scope,
        {
          ...request,
          status: "rejected",
          updatedAt: rivalAt,
          resolution: {
            status: "rejected",
            respondedBy: "operator-other",
            comment: "no",
            resolvedAt: rivalAt,
            edit: null,
          },
        },
        transaction,
      ),
    ),
    (moved) => moved,
  );
  observed["approvals.resolve.readBack"] = outcome(
    await store.findByApprovalId(scope, request.approvalId),
    maybeApproval,
  );
  observed["approvals.list.afterResolve"] = outcome(await store.list(scope, wide()), projectPage);
  observed["approvals.findPending"] = outcome(await store.findPending(scope), (rows) =>
    rows.map((row) => row.approvalId),
  );

  // THE OUTCOME ENVELOPE, both ways round: an OBJECT outcome, which the live
  // path stored verbatim, and an ARRAY, which `AgentApproval_resolution_json_root`
  // refuses at the column and which therefore has to ride inside one.
  const consumedAt = clock();
  observed["approvals.markConsumed.object"] = outcome(
    await runResult(environment, (transaction) =>
      store.markConsumed(
        scope,
        firstMcp.approvalId,
        { ranAt: "2026-05-01T09:10:00.000Z", ok: true } as JsonValue,
        consumedAt,
        transaction,
      ),
    ),
    (marked) => marked,
  );
  observed["approvals.markConsumed.objectReadBack"] = outcome(
    await store.findByApprovalId(scope, firstMcp.approvalId),
    maybeApproval,
  );
  const arrayConsumedAt = clock();
  observed["approvals.markConsumed.array"] = outcome(
    await runResult(environment, (transaction) =>
      store.markConsumed(
        scope,
        secondMcp.approvalId,
        [1, 2, 3] as JsonValue,
        arrayConsumedAt,
        transaction,
      ),
    ),
    (marked) => marked,
  );
  observed["approvals.markConsumed.arrayReadBack"] = outcome(
    await store.findByApprovalId(scope, secondMcp.approvalId),
    maybeApproval,
  );
  observed["approvals.markConsumed.absent"] = outcome(
    await runResult(environment, (transaction) =>
      store.markConsumed(scope, ids.absentApprovalId, null, clock(), transaction),
    ),
    (marked) => marked,
  );

  // ------------------------------------------------------------- erasure
  //
  // THE SUBJECT IS TWO PLACES AND BOTH HALVES ARE ASKED. `subject-a` only ever
  // REQUESTED; `operator-9` only ever DECIDED; and the row they both touch is
  // the same one, so a store matching one half would answer 1 and 0 where both
  // answers are 1.
  for (const [name, principalId] of [
    ["requester", REQUESTER],
    ["responder", OPERATOR],
    ["mcpRequester", MCP_REQUESTER],
    ["canceller", CANCELLER],
    ["stranger", "nobody-at-all"],
  ] as const) {
    observed[`approvals.countErasable.${name}`] = outcome(
      await store.countErasable({ scope, principalId }),
      (count) => count,
    );
  }
  // A SUBJECT-LESS SELECTOR IS THE FAIL-CLOSED CASE: a null principal would make
  // the `WHERE` a tenant alone, which is everybody's approvals.
  observed["approvals.countErasable.noSubject"] = outcome(
    await store.countErasable({ scope, principalId: null }),
    (count) => count,
  );
  // ADDRESSED AT THE ORGANIZATION, which every row here is environment-keyed
  // under. This is the containment `domain/scope.ts` publishes
  // `environmentFallsWithin` for, and the relation filter this store resolves in
  // ONE statement rather than by widening the tree first.
  const organization: EnvironmentScope["organizationId"] = scope.organizationId;
  observed["approvals.countErasable.atOrganization"] = outcome(
    await store.countErasable({
      scope: organizationScope(organization),
      principalId: CANCELLER,
    }),
    (count) => count,
  );

  observed["approvals.erase.mcpRequester"] = outcome(
    await runResult(environment, (transaction) =>
      store.erase({ scope, principalId: MCP_REQUESTER }, transaction),
    ),
    (erased) => erased,
  );
  observed["approvals.erase.noSubject"] = outcome(
    await runResult(environment, (transaction) =>
      store.erase({ scope, principalId: null }, transaction),
    ),
    (erased) => erased,
  );
  observed["approvals.countErasable.afterErase"] = outcome(
    await store.countErasable({ scope, principalId: MCP_REQUESTER }),
    (count) => count,
  );
  observed["approvals.list.afterErase"] = outcome(await store.list(scope, wide()), projectPage);

  // THE ONE READ THAT CROSSES TENANTS. Both stores are asked it LAST, when
  // exactly one scope still holds a pending row.
  observed["approvals.scopesWithPending"] = outcome(
    await store.findScopesWithPending(),
    (scopes) =>
      scopes.map((found) => [found.organizationId, found.projectId, found.environmentId]),
  );
}
