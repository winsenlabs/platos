// Aggregate builders.
//
// Every builder takes an overrides bag and fills the rest with a valid default,
// so a test states ONLY the fields its assertion depends on. A test that spells
// out fifteen irrelevant fields hides which one it is actually about, and it
// breaks for reasons unrelated to what it covers.
//
// The defaults are deliberately the SAFE, boring case: an enabled connection, an
// active installation with an IDLE fence, a freshly admitted event. A test for a
// revoked installation says `{ status: "revoked" }` and that one word is the
// whole difference between it and its neighbour.

import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import {
  admitEvent,
  createThreadLink,
  linkIdentity,
  type AgentId,
  type ChannelApp,
  type ChannelAppId,
  type ChannelConnection,
  type ChannelConnectionId,
  type ChannelEvent,
  type ChannelEventInboxId,
  type ChannelInstallation,
  type ChannelInstallationId,
  type ChannelRoutingRule,
  type ChannelThreadId,
  type ChannelThreadKey,
  type ChannelThreadLink,
  type CredentialId,
  type ExternalInstallationId,
  type ProviderEventId,
  type RefreshExpectation,
  type SealedEventPayload,
  type ThreadId,
  type ThreadLinkOwner,
} from "../../domain/index.js";
import { testEnvironmentScope } from "./fixtures.js";
import type { InMemoryChannelsRepository } from "./in-memory-channels-repository.js";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

export function agentId(value = "agent-1"): AgentId {
  return asIdentifier<AgentId>(value);
}

export function threadId(value = "thread-1"): ThreadId {
  return asIdentifier<ThreadId>(value);
}

export function threadKey(value = "channel:C123:1700000000.1"): ChannelThreadKey {
  return asIdentifier<ChannelThreadKey>(value);
}

export function credentialId(value = "cred-1"): CredentialId {
  return asIdentifier<CredentialId>(value);
}

/** A `channel` rule, spelled the way an operator's stored table spells it. */
export function channelRule(id: string, agent = "agent-1"): ChannelRoutingRule {
  return { match: { type: "channel", id }, agentId: agentId(agent) };
}

/** A `prefix` rule. `value` is stored LOWER-CASED — see `domain/routing.ts`. */
export function prefixRule(value: string, agent = "agent-1"): ChannelRoutingRule {
  return { match: { type: "prefix", value: value.toLowerCase() }, agentId: agentId(agent) };
}

export function buildConnection(overrides: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    connectionId: asIdentifier<ChannelConnectionId>("conn-1"),
    scope: testEnvironmentScope(),
    entityId: null,
    provider: "slack",
    displayName: "Acme Slack",
    defaultAgentId: agentId(),
    agentRouting: [],
    enabled: true,
    credentialId: credentialId(),
    createdAt: EPOCH,
    ...overrides,
  };
}

export function buildApp(overrides: Partial<ChannelApp> = {}): ChannelApp {
  return {
    appId: asIdentifier<ChannelAppId>("app-1"),
    scope: testEnvironmentScope(),
    provider: "slack",
    displayName: "Acme App",
    clientId: "client-1",
    credentialId: credentialId(),
    scopes: ["chat:write"],
    distribution: "private",
    defaultAgentId: agentId(),
    agentRouting: [],
    createdAt: EPOCH,
    ...overrides,
  };
}

export function buildInstallation(overrides: Partial<ChannelInstallation> = {}): ChannelInstallation {
  return {
    installationId: asIdentifier<ChannelInstallationId>("inst-1"),
    appId: asIdentifier<ChannelAppId>("app-1"),
    externalInstallationId: asIdentifier<ExternalInstallationId>("T123"),
    displayName: "Acme Workspace",
    credentialId: credentialId(),
    credentialRevision: 1,
    grantedScopes: ["chat:write"],
    defaultAgentId: null,
    agentRouting: [],
    status: "active",
    revokedAt: null,
    lastEventAt: null,
    refreshState: "IDLE",
    refreshClaimId: null,
    refreshStartedAt: null,
    refreshRepairCode: null,
    tokenGeneration: 1,
    createdAt: EPOCH,
    ...overrides,
  };
}

/**
 * The expectation that MATCHES `buildInstallation()`'s defaults.
 *
 * Provided as a builder so a test proving the fence rejects a stale expectation
 * has to say WHICH axis it staled — `{ tokenGeneration: 2 }` — rather than
 * rebuilding the whole record and possibly changing two things at once.
 */
export function buildExpectation(overrides: Partial<RefreshExpectation> = {}): RefreshExpectation {
  return { credentialId: credentialId(), credentialRevision: 1, tokenGeneration: 1, ...overrides };
}

export function buildSealedPayload(overrides: Partial<SealedEventPayload> = {}): SealedEventPayload {
  return { formatVersion: 1, keyVersion: 7, ciphertext: "sealed", ...overrides };
}

export function buildEvent(overrides: Partial<ChannelEvent> = {}): ChannelEvent {
  const base = admitEvent({
    inboxId: asIdentifier<ChannelEventInboxId>("inbox-1"),
    appId: asIdentifier<ChannelAppId>("app-1"),
    eventId: asIdentifier<ProviderEventId>("Ev123"),
    payload: buildSealedPayload(),
    now: EPOCH,
  });
  return { ...base, ...overrides };
}

export function buildEnvironment(environmentId = "env-1"): EnvironmentScope {
  return testEnvironmentScope(environmentId);
}

/**
 * Seed an already-linked conversation.
 *
 * Writes straight into the repository's map rather than through
 * `insertThreadLink`, so a test that seeds a link is not also asserting that
 * inserting one works — and so "the link already existed" can be set up for the
 * race cases where the insert is expected to FAIL.
 */
export function createThreadLinkFor(
  repository: InMemoryChannelsRepository,
  owner: ThreadLinkOwner,
  channelThreadKey: string,
  threadIdValue: string,
): ChannelThreadLink {
  const key = asIdentifier<ChannelThreadKey>(channelThreadKey);
  const link = createThreadLink({
    linkId: asIdentifier<ChannelThreadId>(`link-${threadIdValue}`),
    owner,
    channelThreadKey: key,
    threadId: threadId(threadIdValue),
    now: EPOCH,
  });
  repository.links.set(linkIdentity(owner, key), link);
  return link;
}
