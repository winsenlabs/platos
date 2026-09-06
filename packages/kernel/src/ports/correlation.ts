// ADR M0.3 §4 kernel port: CorrelationSource.
//
// WHY THIS PORT EXISTS AT ALL. `RequestScope` already carries a `requestId`, and
// the observability gate already requires one on every event, span and log line.
// What was missing was a way for the id to REACH anything: at M2.4 exactly one
// port named `RequestScope` (`DurableRuntime`), no use case took one, and every
// one of the eight `DomainEventDraft`s appended through the kernel outbox
// supplied `requestId: null`. The identifier was minted at the process edge and
// went no further, which makes it a generated id rather than a correlated one.
//
// Threading `RequestScope` through every use case would have been the other
// answer, and it is the wrong one twice over. It changes the signature of every
// use case in seventeen contexts to carry a value none of them makes a decision
// with — ADR M0.3 §2's whole point is that a use case takes what it decides on —
// and it still would not reach the adapters, which are called by the use cases
// rather than by the transport.
//
// So correlation is AMBIENT, exactly as the transaction frame in
// `packages/adapters/postgres-tenancy` already is, and this port is the seam
// across which the ambient value is read. The process edge implements it (over
// `AsyncLocalStorage`, in `apps/core-api/src/runtime/correlation.ts`, which is
// already the only place in V1 that decides what a request identifier is), and
// adapters consume it. No context names it, because no context decides with it.
//
// `current()` RETURNS NULL OUTSIDE A REQUEST, AND THAT IS LOAD-BEARING. Work
// that is not a request — a drain tick, a scheduled sweep, a boot-time
// migration — belongs to no request, and an implementation that invented an id
// for it would put a correlation on a log line that appears in no request's
// trace. A fabricated correlation is worse than an absent one: absence is
// visible, and a fabrication is not.

import type { RequestId } from "../vo/identifier.js";

/** The correlation identity of the work in flight. */
export interface CorrelationRef {
  /**
   * The identifier the process edge adopted or minted for this request.
   *
   * ADOPTED IS NOT THE SAME AS TRUSTED. An inbound header is attacker-controlled
   * and the edge validates its shape before adopting it, so anything reaching
   * this port is already known to be safe in a header, a log field, a span
   * attribute and a URL. An adapter may therefore put it in a statement or a
   * column without escaping it again — which is only true because the edge did
   * the work, and is why nothing else in the system is allowed to mint one.
   */
  readonly requestId: RequestId;
}

export interface CorrelationSource {
  /** The correlation of the work in flight, or null outside any request. */
  current(): CorrelationRef | null;
}
