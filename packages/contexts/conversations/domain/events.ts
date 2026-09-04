// The integration event names this context owns.
//
// THIS LIST IS HALF OF WHAT MAKES THE DAG ACYCLIC, AND THE MORE LOAD-BEARING
// HALF. ADR M0.3 §1 row 16 says it in as many words: "every reverse/fan-out flow
// leaves as a domain event or a durable job, so NO context imports
// conversations." `conversations` is the deepest node — it depends on eleven
// peers and is depended on by none — which is only possible if everything that
// USED to be a call back up the graph is a name on this list instead.
//
// EVERY ENTRY BELOW REPLACES A SPECIFIC INBOUND EDGE. Named, so the claim is
// checkable rather than decorative:
//
//   conversations.turn.settled     replaces the turn engine calling
//                                  `CostService.recordUsage`, `recordUserSpend`
//                                  and the Prometheus fan-out from inside the
//                                  request. `cost-monitoring` (§1 row 13) writes
//                                  the ledger; it subscribes rather than being
//                                  called, and it is the event's usage and cost
//                                  that it reads — the same numbers the steps
//                                  hold, because they ARE the steps' numbers.
//   conversations.turn.failed      replaces the same three calls on the failure
//                                  path, which the source omits entirely, losing
//                                  a failed turn's delegated spend.
//   conversations.turn.rated       nothing rates a turn from in here. The name
//                                  exists so `governance` (row 14) has an
//                                  arrival to key its ratings off, rather than
//                                  this context calling it.
//   conversations.thread.compacted replaces the in-process compaction callback.
//                                  The work itself leaves as a durable job.
//   conversations.thread.forked    replaces the observability projection call.
//   conversations.thread.archived  replaces the thread-lifecycle publish.
//   conversations.turn.tool_called replaces the audit write into `tools`' rows.
//                                  `tools` is the sole writer of `ToolCallAudit`
//                                  (row 12); this context is not, and does not
//                                  reach across to write it.
//   conversations.sub_agent.settled replaces the `sub_agent_usage` stream event
//                                  that the durable ledger picks up out of band.
//
// NOTHING HERE PUBLISHES ANYTHING. The outbox adapter is the single physical
// writer of the `Event` table (ADR M0.3 §3 and §7 decision 8) and a context
// reaches it through the kernel `OutboxWriter` inside its own `UnitOfWork`. This
// module is the vocabulary; the emission is in `application/`.
//
// THE NAMES LIVE IN `domain/` so the published contract can carry them without a
// consumer importing the binder — and with it every use case, every port and
// eleven peer contracts — to read a list of strings.

export const CONVERSATIONS_EVENT_NAMES = [
  "conversations.thread.opened",
  "conversations.thread.forked",
  "conversations.thread.compacted",
  "conversations.thread.archived",
  "conversations.turn.opened",
  "conversations.turn.settled",
  "conversations.turn.failed",
  "conversations.turn.abandoned",
  "conversations.turn.tool_called",
  "conversations.sub_agent.settled",
  "conversations.postman.executed",
] as const;

export type ConversationsEventName = (typeof CONVERSATIONS_EVENT_NAMES)[number];
