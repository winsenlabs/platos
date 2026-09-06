// `conversations`' canonical store — four ports, one object, one connection, in
// the one directory ADR M0.3 §15 gives the ORM.
//
// FOUR NAMED PROPERTIES, NOT A SPREAD, and the names are
// `ConversationsDependencies`' own slot names. `tools`, `agents`,
// `cost-monitoring` and `channels` each publish ONE composite port whose method
// names are disjoint from everything else in this directory, so their composites
// are spread into `PostgresTenancyAdapter` and satisfied structurally. This
// context publishes FOUR SEPARATE ports and its bundle hands each one over under
// its own name, exactly as `governance`'s five and `secrets`' two do — a bundle
// assembled from this object's keys cannot put one port in another's slot.
//
// `erasureStore` IS SPELLED `conversationsErasure` HERE AND NOWHERE ELSE. The
// bundle's slot is `erasureStore`, and `erasureStore` is not a name a directory
// serving NINE owners can give to one of them: `governance`, `secrets` and
// `privacy` all have erasure surfaces of their own. It is the same rename
// `secrets` made for `repository`, for the same reason, and
// `apps/core-api/src/composition/adapter-bindings.ts` is where the two names are
// put back together.
//
// ONE TRANSACTION ACROSS ALL FOUR, AND ACROSS THE OTHER EIGHT OWNERS. They are
// handed the SAME `TenancyTransactions`, and three separate things depend on it:
//
//   `run-turn.ts` allocates a sequence under a `FOR UPDATE` on the thread row and
//   then inserts the turn. Two stores, one lock, one transaction — a thirteenth
//   adapter package holding only these four would have had its own pool, and the
//   lock would have been taken on one connection while the insert it serialises
//   ran on another.
//
//   `saveSettlement` writes a turn and replaces its steps. `Turn.costCents` is
//   the sum of `Step.costCents`, so a settlement that failed between the two
//   halves would leave a rollup that disagrees with its own parts — which is the
//   exact defect the extraction source shipped in three different code paths.
//
//   `conversations-erasure-target.ts` counts a subject's rows, deletes their
//   threads and anonymises their executions, and `privacy` runs the destructive
//   half inside ITS transaction. The `TransactionScope` it passes is minted by
//   this object's `AsyncLocalStorage` frame; a second `TenancyTransactions` would
//   refuse it with `scope_unknown` — a refusal naming the right fact and the
//   wrong cause.
//
// WHAT IS NOT HERE, AND WHY. `conversations` declares FOUR driven ports and this
// satisfies all four; there is nothing to skip, and that is unusual enough in
// this directory to be worth saying. `application/ports/index.ts` says why in
// its own header: every other collaborator a turn needs — the model, the tools,
// the memory, the budget, the files, the durable seam — is reached through a
// PEER CONTEXT'S published contract rather than through a port declared here, so
// there is no `ModelPort` and no `ToolExecutorPort` for an adapter to implement.
// The eleven peers are wired at the composition root, and the inference seam in
// particular is `providers`' `ModelRouter`, bound where `packages/adapters/model-router-providers`
// is bound.

import type {
  ConversationsErasureStore,
  PostmanRepository,
  ThreadRepository,
  TurnRepository,
} from "@platos/context-conversations/application/ports/index.js";

import { createConversationsErasureStore } from "./conversations-erasure.js";
import { createPostmanRepository } from "./conversations-postman.js";
import { createThreadRepository } from "./conversations-threads.js";
import { createTurnRepository } from "./conversations-turns.js";
import type { TenancyTransactions } from "./transaction.js";

/** The four canonical stores, under the names the context's bundle uses. */
export interface ConversationsStores {
  readonly threads: ThreadRepository;
  readonly turns: TurnRepository;
  readonly postman: PostmanRepository;
  /** `ConversationsDependencies.erasureStore`; see the header for the rename. */
  readonly conversationsErasure: ConversationsErasureStore;
}

/**
 * Build the four stores over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason every
 * composite in this package does: a caller that built its own would get a second
 * `AsyncLocalStorage` frame, and a `TransactionScope` minted by one would be
 * refused by the other with `scope_unknown`.
 */
export function createConversationsStores(
  transactions: TenancyTransactions,
): ConversationsStores {
  return {
    threads: createThreadRepository(transactions),
    turns: createTurnRepository(transactions),
    postman: createPostmanRepository(transactions),
    conversationsErasure: createConversationsErasureStore(transactions),
  };
}
