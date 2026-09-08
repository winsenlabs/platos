// `ActivityReader` — the risk board's DENOMINATORS, and the only one of the
// three read seams that spans more than one owner.
//
// THREE OWNERS IN ONE METHOD, WHICH IS WHY THE PORT EXISTS. `Turn` is
// `conversations`', `ToolCallAudit` is `tools`', `AgentApproval` is `jobs`', and
// ADR M0.3 §1 row 14 lets `governance` import none of the three. All three rows
// live in the one PostgreSQL database whose canonical store this directory is
// (`CANONICAL_STORE_ADAPTERS` maps every owner here), so the three statements
// share one client, one pool and one transaction; what crosses the boundary is
// three integers per agent in `governance`'s own vocabulary, never a row.
//
// ---------------------------------------------------------------------------
// THE NARROWING IS DIFFERENT FOR EACH OF THE THREE, AND THAT ASYMMETRY IS THE
// DEFECT THIS FILE EXISTS TO NOT HAVE.
//
//   `ToolCallAudit` and `AgentApproval` each carry `environmentId`. One column.
//   `Turn` DOES NOT. It has no environment column at all; its tenancy is its
//   thread's, so the turn count has to JOIN.
//
// A reader that narrowed all three the same way would either fail to compile on
// the third or — the shape that actually ships — count turns for the whole
// installation. And a wrong denominator does not look wrong: `risk.ts` divides
// by `Math.max(1, turns)`, so an inflated denominator quietly DEFLATES every
// rate on the board and an agent over the threshold drops below it. There is no
// error, no empty page, nothing to notice. `read-seams.integration.test.ts`
// seeds a second tenant and asserts each of the three counts separately, so a
// narrowing lost on any ONE of them turns that case red on that count.
//
// ONE STATEMENT PER SOURCE, NOT ONE PER AGENT. `SafetyLedger.countByAgent` set
// this precedent for the numerators and `governance-statements.integration.test.ts`
// pins it; the denominators are held to the same rule, and pinned there too.
// Three grouped reads, folded in memory by agent id.
//
// THE TURN COUNT IS RAW SQL AND THAT IS FORCED. Prisma's `groupBy` groups by
// COLUMNS of the model being grouped, and the column this has to group by —
// `Thread.agentId` — is on the joined table. The alternatives are worse: reading
// every thread in the environment to build an `IN` list is an unbounded
// parameter list and a second round trip, and grouping by `threadId` and folding
// in memory is the same read wearing a disguise. One join, one GROUP BY, and
// `Thread(environmentId, ...)` is indexed.
//
// THE UNION IS BY AGENT, NOT BY POSITION. An agent may appear in any one of the
// three sources and not the others — a conversation with no tool call, a tool
// failure on a turnless agent — and `risk-report.ts` merges this with the safety
// counts by union as well. Every agent that did ANY of the three appears, with
// zeros for the rest.
//
// WHAT IS DELIBERATELY NOT COUNTED. `ToolCallAudit` rows whose `status` is not
// `FAILED`: the port's field is `toolErrors`, the column is a `WorkStatus`, and
// `FAILED` is the one value that means the call did not do what it was asked.
// `error` is NOT used as the predicate — it is nullable on every status, so a
// cancelled call carrying a message would be counted as a failure. Approvals are
// counted at EVERY status, because the port's field is `approvalEvents` and the
// risk it measures is how often an agent had to stop and ask, not how often it
// was told yes.
// ---------------------------------------------------------------------------

import type {
  ActivityReader,
  AgentActivityCounts,
  AgentId,
  EnvironmentScope,
  Result,
} from "@platos/context-governance/application/ports/index.js";
import {
  activityUnreadable,
  asGovernanceIdentifier,
  err,
  ok,
} from "@platos/context-governance/application/ports/index.js";

import { refuse } from "./governance-refusal.js";
import { narrowableEnvironment } from "./governance-seam-guards.js";
import type { TenancyTransactions } from "./transaction.js";

/** One row of the joined turn count. `bigint` because `count(*)` is int8. */
interface TurnCountRow {
  readonly agentId: string;
  readonly turns: bigint;
}

/** The three counters an agent accumulates, before it is known to have any. */
interface Tally {
  turns: number;
  toolErrors: number;
  approvalEvents: number;
}

function bucket(counts: Map<string, Tally>, agentId: string): Tally {
  const held = counts.get(agentId);
  if (held !== undefined) return held;
  const fresh: Tally = { turns: 0, toolErrors: 0, approvalEvents: 0 };
  counts.set(agentId, fresh);
  return fresh;
}

export function createActivityReader(transactions: TenancyTransactions): ActivityReader {
  return {
    async countByAgent(
      scope: EnvironmentScope,
      since: Date,
    ): Promise<Result<readonly AgentActivityCounts[]>> {
      const environmentId = narrowableEnvironment(scope);
      if (environmentId === null) {
        return err(activityUnreadable(`no environment to narrow by: ${String(scope.environmentId)}`));
      }
      return refuse(async () => {
        const reader = transactions.reader();

        // TURNS — the join, because `Turn` has no environment of its own.
        // `thread."agentId"` is the grouping column and it is on the JOINED
        // table, which is what Prisma's `groupBy` cannot express.
        const turnRows = await reader.$queryRaw<readonly TurnCountRow[]>`
          SELECT thread."agentId" AS "agentId", count(*) AS "turns"
            FROM "Turn" turn
            JOIN "Thread" thread ON thread."id" = turn."threadId"
           WHERE thread."environmentId" = ${environmentId}::uuid
             AND turn."createdAt" >= ${since}
           GROUP BY thread."agentId"
        `;

        // TOOL ERRORS — one column narrows this one. `agentId` is nullable on
        // the row (`ON DELETE SET NULL` on the agent), and a failure whose agent
        // has been deleted belongs to no bucket on this board, so it is excluded
        // in the WHERE rather than folded into a null key.
        const toolRows = await reader.toolCallAudit.groupBy({
          by: ["agentId"],
          where: {
            environmentId,
            createdAt: { gte: since },
            status: "FAILED",
            agentId: { not: null },
          },
          _count: { _all: true },
        });

        // APPROVALS — every status, per the port's `approvalEvents`.
        const approvalRows = await reader.agentApproval.groupBy({
          by: ["agentId"],
          where: { environmentId, createdAt: { gte: since }, agentId: { not: null } },
          _count: { _all: true },
        });

        const counts = new Map<string, Tally>();
        for (const row of turnRows) {
          // `count(*)` arrives as a `bigint`; the port's field is a `number` and
          // the board divides by it. Narrowed here, once, rather than at the
          // three arithmetic sites downstream.
          bucket(counts, row.agentId).turns = Number(row.turns);
        }
        for (const row of toolRows) {
          if (row.agentId === null) continue;
          bucket(counts, row.agentId).toolErrors = row._count._all;
        }
        for (const row of approvalRows) {
          if (row.agentId === null) continue;
          bucket(counts, row.agentId).approvalEvents = row._count._all;
        }

        return ok(
          [...counts.entries()].map(([agentId, tally]) => ({
            agentId: asGovernanceIdentifier<AgentId>(agentId),
            turns: tally.turns,
            toolErrors: tally.toolErrors,
            approvalEvents: tally.approvalEvents,
          })),
        );
      }, "governance activity countByAgent");
    },
  };
}
