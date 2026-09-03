// An in-memory `ChannelsRepository`.
//
// It is a REAL implementation of the port's contract, not a mock: it enforces
// the two uniques (`[appId, eventId]` and the per-owner thread key) by refusing
// a colliding insert, exactly as Postgres does. That is what makes the
// duplicate-admission and link-race tests meaningful — against a mock that
// accepted everything, the code paths that HANDLE a lost race would never run.
//
// `failNext` is the negative-control seam. A repository that cannot fail cannot
// prove that a use case propagates a failure instead of swallowing it, and
// "the store is down" is not otherwise reachable from a test.

import { err, ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  byClaimOrder,
  eventDuplicate,
  isClaimable,
  linkIdentity,
  repositoryUnavailable,
  threadLinkConflict,
  type ChannelApp,
  type ChannelAppId,
  type ChannelConnection,
  type ChannelConnectionId,
  type ChannelEvent,
  type ChannelEventInboxId,
  type ChannelInstallation,
  type ChannelInstallationId,
  type ChannelThreadKey,
  type ChannelThreadLink,
  type ExternalInstallationId,
  type ProviderEventId,
  type ThreadId,
  type ThreadLinkOwner,
} from "../../domain/index.js";
import type { ChannelsRepository } from "../ports/index.js";

export class InMemoryChannelsRepository implements ChannelsRepository {
  readonly connections = new Map<string, ChannelConnection>();
  readonly apps = new Map<string, ChannelApp>();
  readonly installations = new Map<string, ChannelInstallation>();
  readonly links = new Map<string, ChannelThreadLink>();
  readonly events = new Map<string, ChannelEvent>();

  /** Every transaction a write was handed, so a test can assert atomicity. */
  readonly writes: TransactionScope[] = [];

  private pendingFailure: string | null = null;

  /** Make exactly the next port call fail with `CHANNELS_REPOSITORY_UNAVAILABLE`. */
  failNext(reason = "injected"): void {
    this.pendingFailure = reason;
  }

  private guard<Value>(): Result<Value> | null {
    if (this.pendingFailure === null) return null;
    const reason = this.pendingFailure;
    this.pendingFailure = null;
    return err(repositoryUnavailable(reason));
  }

  // ---- seeding (test-only; not part of the port) -----------------------------

  seedConnection(connection: ChannelConnection): ChannelConnection {
    this.connections.set(connection.connectionId, connection);
    return connection;
  }

  seedApp(app: ChannelApp): ChannelApp {
    this.apps.set(app.appId, app);
    return app;
  }

  seedInstallation(installation: ChannelInstallation): ChannelInstallation {
    this.installations.set(installation.installationId, installation);
    return installation;
  }

  seedEvent(event: ChannelEvent): ChannelEvent {
    this.events.set(event.inboxId, event);
    return event;
  }

  // ---- connections and apps -------------------------------------------------

  async findConnection(
    scope: EnvironmentScope,
    connectionId: ChannelConnectionId,
  ): Promise<Result<ChannelConnection | null>> {
    const failure = this.guard<ChannelConnection | null>();
    if (failure !== null) return failure;
    const found = this.connections.get(connectionId) ?? null;
    // A row outside the requested environment is INVISIBLE, not forbidden:
    // reporting it as found-but-denied would confirm its existence to a caller
    // in another tenant.
    if (found === null || found.scope.environmentId !== scope.environmentId) return ok(null);
    return ok(found);
  }

  async findConnectionById(connectionId: ChannelConnectionId): Promise<Result<ChannelConnection | null>> {
    const failure = this.guard<ChannelConnection | null>();
    if (failure !== null) return failure;
    return ok(this.connections.get(connectionId) ?? null);
  }

  async saveConnection(
    connection: ChannelConnection,
    transaction: TransactionScope,
  ): Promise<Result<ChannelConnection>> {
    const failure = this.guard<ChannelConnection>();
    if (failure !== null) return failure;
    this.writes.push(transaction);
    this.connections.set(connection.connectionId, connection);
    return ok(connection);
  }

  async findApp(scope: EnvironmentScope, appId: ChannelAppId): Promise<Result<ChannelApp | null>> {
    const failure = this.guard<ChannelApp | null>();
    if (failure !== null) return failure;
    const found = this.apps.get(appId) ?? null;
    if (found === null || found.scope.environmentId !== scope.environmentId) return ok(null);
    return ok(found);
  }

  async findAppById(appId: ChannelAppId): Promise<Result<ChannelApp | null>> {
    const failure = this.guard<ChannelApp | null>();
    if (failure !== null) return failure;
    return ok(this.apps.get(appId) ?? null);
  }

  async saveApp(app: ChannelApp, transaction: TransactionScope): Promise<Result<ChannelApp>> {
    const failure = this.guard<ChannelApp>();
    if (failure !== null) return failure;
    this.writes.push(transaction);
    this.apps.set(app.appId, app);
    return ok(app);
  }

  // ---- installations --------------------------------------------------------

  async findInstallation(installationId: ChannelInstallationId): Promise<Result<ChannelInstallation | null>> {
    const failure = this.guard<ChannelInstallation | null>();
    if (failure !== null) return failure;
    return ok(this.installations.get(installationId) ?? null);
  }

  async findInstallationByExternalId(
    appId: ChannelAppId,
    externalInstallationId: ExternalInstallationId,
  ): Promise<Result<ChannelInstallation | null>> {
    const failure = this.guard<ChannelInstallation | null>();
    if (failure !== null) return failure;
    for (const installation of this.installations.values()) {
      if (installation.appId === appId && installation.externalInstallationId === externalInstallationId) {
        return ok(installation);
      }
    }
    return ok(null);
  }

  async saveInstallation(
    installation: ChannelInstallation,
    transaction: TransactionScope,
  ): Promise<Result<ChannelInstallation>> {
    const failure = this.guard<ChannelInstallation>();
    if (failure !== null) return failure;
    this.writes.push(transaction);
    this.installations.set(installation.installationId, installation);
    return ok(installation);
  }

  // ---- thread links ---------------------------------------------------------

  async findThreadLink(
    owner: ThreadLinkOwner,
    channelThreadKey: ChannelThreadKey,
  ): Promise<Result<ChannelThreadLink | null>> {
    const failure = this.guard<ChannelThreadLink | null>();
    if (failure !== null) return failure;
    return ok(this.links.get(linkIdentity(owner, channelThreadKey)) ?? null);
  }

  /** Refuses a colliding insert, exactly as the unique index does. */
  async insertThreadLink(
    link: ChannelThreadLink,
    transaction: TransactionScope,
  ): Promise<Result<ChannelThreadLink>> {
    const failure = this.guard<ChannelThreadLink>();
    if (failure !== null) return failure;
    const identity = linkIdentity(link.owner, link.channelThreadKey);
    const existing = this.links.get(identity);
    if (existing !== undefined) {
      return err(threadLinkConflict(link.channelThreadKey, existing.threadId, link.threadId));
    }
    this.writes.push(transaction);
    this.links.set(identity, link);
    return ok(link);
  }

  async findThreadLinksByThread(threadId: ThreadId): Promise<Result<readonly ChannelThreadLink[]>> {
    const failure = this.guard<readonly ChannelThreadLink[]>();
    if (failure !== null) return failure;
    return ok([...this.links.values()].filter((link) => link.threadId === threadId));
  }

  // ---- event inbox ----------------------------------------------------------

  async findEvent(inboxId: ChannelEventInboxId): Promise<Result<ChannelEvent | null>> {
    const failure = this.guard<ChannelEvent | null>();
    if (failure !== null) return failure;
    return ok(this.events.get(inboxId) ?? null);
  }

  async findEventByProviderId(
    appId: ChannelAppId,
    eventId: ProviderEventId,
  ): Promise<Result<ChannelEvent | null>> {
    const failure = this.guard<ChannelEvent | null>();
    if (failure !== null) return failure;
    for (const event of this.events.values()) {
      if (event.appId === appId && event.eventId === eventId) return ok(event);
    }
    return ok(null);
  }

  /** Refuses a colliding insert, exactly as the `[appId, eventId]` unique does. */
  async insertEvent(event: ChannelEvent, transaction: TransactionScope): Promise<Result<ChannelEvent>> {
    const failure = this.guard<ChannelEvent>();
    if (failure !== null) return failure;
    for (const existing of this.events.values()) {
      if (existing.appId === event.appId && existing.eventId === event.eventId) {
        return err(eventDuplicate(event.eventId));
      }
    }
    this.writes.push(transaction);
    this.events.set(event.inboxId, event);
    return ok(event);
  }

  async saveEvent(event: ChannelEvent, transaction: TransactionScope): Promise<Result<ChannelEvent>> {
    const failure = this.guard<ChannelEvent>();
    if (failure !== null) return failure;
    this.writes.push(transaction);
    this.events.set(event.inboxId, event);
    return ok(event);
  }

  async findClaimableEvents(
    appId: ChannelAppId,
    now: Date,
    limit: number,
  ): Promise<Result<readonly ChannelEvent[]>> {
    const failure = this.guard<readonly ChannelEvent[]>();
    if (failure !== null) return failure;
    const claimable = [...this.events.values()]
      .filter((event) => event.appId === appId && isClaimable(event, now))
      .sort(byClaimOrder)
      .slice(0, limit);
    return ok(claimable);
  }
}
