// The `ChannelsRepository` composite — `channels`' canonical store, in the one
// directory ADR M0.3 §15 gives the ORM.
//
// FOUR STORES, ONE OBJECT, ONE CONNECTION. `ChannelConnection` and `ChannelApp`
// are in `channels-connections.ts`, `ChannelInstallation` in
// `channels-installations.ts`, `ChannelThread` and `ChannelAppThread` in
// `channels-links.ts`, `ChannelEventInbox` in `channels-inbox.ts`. The split is
// by LIFECYCLE rather than by method count — a connection is edited, a link is
// permanent, an event is leased — and it is what keeps each of the four inside
// ADR M0.3 §6's file budget. All four are handed the SAME `TenancyTransactions`,
// so a use case that admits an event, links its thread and stamps the
// installation in one `UnitOfWork.run` gets ONE transaction across all four.
//
// AND ONE TRANSACTION WITH THE OTHER FIVE OWNERS IN THIS DIRECTORY. `tenancy`,
// `identity-access`, `tools`, `agents` and `cost-monitoring` already share it,
// for the reason §15 gives: one PostgreSQL database is one client is one adapter
// directory. A sixth owner changes nothing about that — ownership is carried by
// the owner TAG on the row and `sole-writer.mjs` asks, per WRITE, whether this
// directory is one of `ownerDirectories(OWNER[model])`. A write to `Memory` from
// here still fails, because `memory` has no entry in `CANONICAL_STORE_ADAPTERS`;
// what the new entry grants is exactly the six rows `channels` owns.
//
// IT IS ALSO WHAT MAKES THE INBOUND PATH ATOMIC AT ALL. Admitting an event and
// linking its channel thread are writes to two of this context's tables, and
// dispatching the turn the link points at is a write `conversations` owns. A
// thirteenth adapter package holding only this context's repository would have
// had its own pool, so the admission and the link would have been two
// transactions with a window between them — and a crash inside that window
// leaves an admitted event whose conversation has no thread.
//
// WHAT IS NOT HERE, AND WHY. `channels` declares FIVE driven ports and this
// satisfies ONE of them. The other four are named rather than silently omitted:
//
//   `ChannelAdapter` and `ChannelAdapterRegistry` are the provider SEAM. ADR
//   M0.3 §1 makes `channels` "sole holder of Slack/etc SDKs behind
//   `ChannelAdapter`" and §5.1(h) pins each vendor client to one adapter
//   directory; `packages/adapters/channel-slack` is that directory and has
//   exactly one import edge, to the port's entry point. Satisfying it from here
//   would put a provider SDK inside the directory that holds the ORM, which is
//   the one thing §15 and §5.1(h) together forbid.
//
//   `ChannelCredentialReader` reads the VAULT. `secrets` is sole writer of
//   `Credential` and the §1 DAG gives `channels` no edge to it, which is exactly
//   why the port exists (reader-port inversion, ADR M0.3 §2). This directory
//   holds no vault grant and no root key, and `CANONICAL_STORE_ADAPTERS` has no
//   entry for `secrets`, so it could not write the row even if it held one.
//
//   `AgentDirectory` is the forged-id guard's peer read. `agents` owns `Agent`
//   and `channels` has no DAG edge to it; the check travels through the port and
//   is wired at the composition root, the same inversion `tenancy` uses for
//   `OperatorDirectory`.
//
//   `ChannelEventCipher` is CRYPTO. The inbox's payload is sealed BEFORE
//   insertion and this store never sees plaintext — which is the property that
//   makes `encryptedPayload` safe to hold at all — so implementing the cipher
//   here would put the key that opens every row in the process that stores them.

import type { ChannelsRepository } from "@platos/context-channels/application/ports/index.js";

import { createChannelConnectionStore } from "./channels-connections.js";
import { createChannelEventInboxStore } from "./channels-inbox.js";
import { createChannelInstallationStore } from "./channels-installations.js";
import { createChannelThreadLinkStore } from "./channels-links.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * Build the repository over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason the other
 * four composites in this package do: a caller that built its own would get a
 * second `AsyncLocalStorage` frame, and a write carrying a scope minted by one
 * would be refused by the other with `scope_unknown` — a refusal that names the
 * right fact and the wrong cause.
 */
export function createChannelsRepository(transactions: TenancyTransactions): ChannelsRepository {
  return {
    ...createChannelConnectionStore(transactions),
    ...createChannelInstallationStore(transactions),
    ...createChannelThreadLinkStore(transactions),
    ...createChannelEventInboxStore(transactions),
  };
}
