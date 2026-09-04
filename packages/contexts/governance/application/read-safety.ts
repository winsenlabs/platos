// Use cases: read the safety ledger.
//
// A page, and a rollup. Both take their environment from the grant and their
// window from the injected clock, so neither can reach another tenant and both
// are pinnable to the millisecond.
//
// THE SEARCH TERM DOES NOT REACH `detail`. The source's ledger search matches
// the tool name and, when the term looks like an identifier, the agent and
// thread ids. It deliberately does not match `detail` — that column carries the
// redacted evidence a detector captured, and a substring search over it is a
// read primitive for exactly the material the ledger exists to contain. That
// omission is preserved and stated, because it looks like a missing feature and
// is not.
//
// AN EMPTY SEARCH IS NOT A SEARCH. `""` becomes null rather than a filter that
// matches everything, which is the difference between "no filter" and "a filter
// that happens to be satisfied" when the term is later logged.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitPage,
  summarise,
  windowFrom,
  type AgentId,
  type SafetyDetector,
  type SafetyEvent,
  type SafetyEventId,
  type SafetySeverity,
  type SafetySummary,
  type ThreadId,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";

export interface ReadSafetyQuery {
  readonly authorization: unknown;
}

export interface PageSafetyEventsQuery extends ReadSafetyQuery {
  readonly limit?: number | null;
  readonly offset?: number | null;
  readonly sinceDays?: number | null;
  readonly detector?: SafetyDetector | null;
  readonly severity?: SafetySeverity | null;
  readonly agentId?: AgentId | null;
  readonly threadId?: ThreadId | null;
  readonly search?: string | null;
}

export interface SafetyEventPageResult {
  readonly items: readonly SafetyEvent[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly sinceDays: number;
}

export interface DescribeSafetyEventQuery extends ReadSafetyQuery {
  readonly safetyEventId: SafetyEventId;
}

export interface SummariseSafetyQuery extends ReadSafetyQuery {
  readonly sinceDays?: number | null;
}

export interface SafetySummaryResult extends SafetySummary {
  readonly sinceDays: number;
}

export async function pageSafetyEvents(
  dependencies: GovernanceDependencies,
  query: PageSafetyEventsQuery,
): Promise<Result<SafetyEventPageResult>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const policy = dependencies.policy.safety;
  const page = admitPage({ limit: query.limit ?? null, offset: query.offset ?? null }, policy);
  if (!page.ok) return err(page.error);
  const window = windowFrom(dependencies.clock.now(), query.sinceDays ?? null, policy);

  const read = await dependencies.safety.page(grant.value.scope, {
    since: window.since,
    limit: page.value.limit,
    offset: page.value.offset,
    detector: query.detector ?? null,
    severity: query.severity ?? null,
    agentId: query.agentId ?? null,
    threadId: query.threadId ?? null,
    search: blankToNull(query.search ?? null),
  });
  if (!read.ok) return err(read.error);
  return ok({
    items: read.value.items,
    total: read.value.total,
    limit: page.value.limit,
    offset: page.value.offset,
    sinceDays: window.days,
  });
}

export async function describeSafetyEvent(
  dependencies: GovernanceDependencies,
  query: DescribeSafetyEventQuery,
): Promise<Result<SafetyEvent | null>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  return dependencies.safety.findById(grant.value.scope, query.safetyEventId);
}

export async function summariseSafety(
  dependencies: GovernanceDependencies,
  query: SummariseSafetyQuery,
): Promise<Result<SafetySummaryResult>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const window = windowFrom(dependencies.clock.now(), query.sinceDays ?? null, dependencies.policy.safety);
  const rows = await dependencies.safety.tally(grant.value.scope, window.since);
  if (!rows.ok) return err(rows.error);
  return ok({ ...summarise(rows.value), sinceDays: window.days });
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
