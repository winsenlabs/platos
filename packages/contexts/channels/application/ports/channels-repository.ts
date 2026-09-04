// The canonical-store port behind which this context's sole-writer ownership of
// its six tables is realised (ADR M0.3 §1, §5.2).
//
// EVERY WRITE TAKES A `TransactionScope`. Reads do not. The asymmetry is
// deliberate: the claim/complete pairs on the inbox and the begin/finalize pairs
// on the refresh fence are only fences if the read-modify-write happens inside
// one transaction, and a port that let a write happen outside one would make
// that unenforceable from here.
//
// NOTHING HERE TAKES OR RETURNS A VENDOR HANDLE. ADR M0.3 §3: "no context passes
// a Prisma txn handle across a port." `TransactionScope` is the kernel's opaque
// token, so this interface is implementable by the in-memory double in
// `application/testing/` as faithfully as by the Postgres adapter — which is
// what makes every use case in this package exercisable in memory.

import type { EnvironmentScope, Result, TransactionScope } from "@platos/kernel";

import type {
  ChannelApp,
  ChannelAppId,
  ChannelConnection,
  ChannelConnectionId,
  ChannelEvent,
  ChannelEventInboxId,
  ChannelInstallation,
  ChannelInstallationId,
  ChannelThreadKey,
  ChannelThreadLink,
  ExternalInstallationId,
  ProviderEventId,
  ThreadId,
  ThreadLinkOwner,
} from "../../domain/index.js";

export interface ChannelsRepository {
  // ---- connections and apps -------------------------------------------------

  findConnection(scope: EnvironmentScope, connectionId: ChannelConnectionId): Promise<Result<ChannelConnection | null>>;

  /**
   * The same row WITHOUT a scope to check it against.
   *
   * Separate from `findConnection` rather than an optional parameter, because
   * the two have different security properties and blurring them is how a
   * scoped read silently becomes an unscoped one. The scoped form is what an
   * operator-facing surface uses. This form exists for the INBOUND path, which
   * has no scope yet — the connection is what establishes it — and is why it
   * carries its own `scope` field for the caller to adopt.
   */
  findConnectionById(connectionId: ChannelConnectionId): Promise<Result<ChannelConnection | null>>;

  saveConnection(connection: ChannelConnection, transaction: TransactionScope): Promise<Result<ChannelConnection>>;

  findApp(scope: EnvironmentScope, appId: ChannelAppId): Promise<Result<ChannelApp | null>>;

  /** The unscoped form, for the inbound path. See `findConnectionById`. */
  findAppById(appId: ChannelAppId): Promise<Result<ChannelApp | null>>;

  saveApp(app: ChannelApp, transaction: TransactionScope): Promise<Result<ChannelApp>>;

  // ---- installations --------------------------------------------------------

  findInstallation(installationId: ChannelInstallationId): Promise<Result<ChannelInstallation | null>>;

  /**
   * The `[appId, externalInstallationId]` unique, as a lookup. An OAuth callback
   * knows only the provider's ids, so this is the only way in from that path.
   */
  findInstallationByExternalId(
    appId: ChannelAppId,
    externalInstallationId: ExternalInstallationId,
  ): Promise<Result<ChannelInstallation | null>>;

  saveInstallation(
    installation: ChannelInstallation,
    transaction: TransactionScope,
  ): Promise<Result<ChannelInstallation>>;

  // ---- thread links ---------------------------------------------------------

  findThreadLink(owner: ThreadLinkOwner, channelThreadKey: ChannelThreadKey): Promise<Result<ChannelThreadLink | null>>;

  /**
   * Insert a link, failing on the unique rather than overwriting.
   *
   * A dedicated insert rather than a general `save` because the unique IS the
   * concurrency control here: two workers racing the same first message must
   * produce one link, and an upsert would silently let the second win.
   */
  insertThreadLink(link: ChannelThreadLink, transaction: TransactionScope): Promise<Result<ChannelThreadLink>>;

  // ---- event inbox ----------------------------------------------------------

  findEvent(inboxId: ChannelEventInboxId): Promise<Result<ChannelEvent | null>>;

  /** The `[appId, eventId]` unique, as a lookup — the idempotency probe. */
  findEventByProviderId(appId: ChannelAppId, eventId: ProviderEventId): Promise<Result<ChannelEvent | null>>;

  /**
   * Insert an admitted event, failing on the `[appId, eventId]` unique.
   *
   * Fails rather than upserts for the same reason as `insertThreadLink`: the
   * unique is the idempotency mechanism, and an upsert would overwrite the
   * in-flight state of a row already being processed.
   */
  insertEvent(event: ChannelEvent, transaction: TransactionScope): Promise<Result<ChannelEvent>>;

  saveEvent(event: ChannelEvent, transaction: TransactionScope): Promise<Result<ChannelEvent>>;

  /**
   * Claimable rows for one app, in claim order, bounded by `limit`.
   *
   * Returns CANDIDATES, not a claim. The claim is a separate compare-and-swap
   * through `saveEvent` inside a transaction, so two workers reading the same
   * candidate list still cannot both hold it.
   */
  findClaimableEvents(appId: ChannelAppId, now: Date, limit: number): Promise<Result<readonly ChannelEvent[]>>;

  /**
   * Thread links pointing at one Platos thread, across both link tables.
   *
   * The erasure path needs this: see `channels-erasure-target.ts` for why it is
   * keyed by THREAD and not by subject.
   */
  findThreadLinksByThread(threadId: ThreadId): Promise<Result<readonly ChannelThreadLink[]>>;
}
