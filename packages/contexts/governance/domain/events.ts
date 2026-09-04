// The integration event names this context owns.
//
// A closed vocabulary, fixed at extraction, so the fan-out has a name to
// subscribe to before there is a producer to emit it. The outbox writer that
// actually appends these is an infrastructure adapter at the composition root —
// ADR M0.3 §3 makes the kernel outbox adapter the SINGLE physical writer of the
// `Event` table, and a context reaches it through `OutboxWriter` inside its own
// `UnitOfWork` rather than by writing the table. This module is therefore the
// vocabulary and not the emission: nothing here publishes anything.
//
// THE NAMES LIVE IN `domain/` RATHER THAN BESIDE THE BINDER, so the published
// contract can carry them without a consumer importing the binder — and with it
// every use case, every port and both peer contracts — to read a list of
// strings.
//
// ONE NAME IS ABSENT AND ITS ABSENCE IS THE POINT. There is no
// `governance.cost.recorded`. `runJudge` prices the judge call and stores the
// number on `AgentEval.costCents`, and `governance.eval.scored` carries it, but
// the spend ledger is `cost-monitoring`'s (ADR M0.3 §1 row 13) and this context
// neither writes it nor may import it.

export const GOVERNANCE_EVENT_NAMES = [
  "governance.safety.recorded",
  "governance.rating.cast",
  "governance.rating.withdrawn",
  "governance.criterion.created",
  "governance.criterion.updated",
  "governance.criterion.removed",
  "governance.eval.scored",
  "governance.golden_set.created",
  "governance.golden_set.updated",
  "governance.golden_set.removed",
  "governance.eval_run.queued",
] as const;

export type GovernanceEventName = (typeof GOVERNANCE_EVENT_NAMES)[number];
