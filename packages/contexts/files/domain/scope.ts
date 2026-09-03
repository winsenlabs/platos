// The shared notion of scope for both of this context's aggregates.
//
// `MessageAttachment` and `Artifact` have genuinely different persistence
// stories — one is a pointer at a blob, the other is a versioned inline
// document — but they agree on WHERE they live: an environment, and a thread
// inside it. That agreement is `ThreadScope`, and it is the only thing the two
// aggregates share. Modelling them as one row-shaped union with nullable halves
// would make every field optional and every read a runtime question.
//
// `AttachmentScope` adds the two owner columns the attachment table carries and
// the artifact table does not (`endUserId`, `agentId`). Those columns are why an
// attachment lookup can be denied for a caller who is inside the right
// environment and thread but is not the owner.

import { resolvePath, type EnvironmentScope } from "@platos/kernel";

import type { AgentId, EndUserId, ThreadId } from "./identifiers.js";

/** Where both aggregates agree they live. */
export interface ThreadScope {
  readonly environment: EnvironmentScope;
  readonly threadId: ThreadId;
}

/** The two owner columns `MessageAttachment` carries and `Artifact` does not. */
export interface AttachmentOwner {
  readonly endUserId: EndUserId;
  readonly agentId: AgentId;
}

export interface AttachmentScope extends ThreadScope {
  readonly owner: AttachmentOwner;
}

export function threadScope(environment: EnvironmentScope, threadId: ThreadId): ThreadScope {
  return { environment, threadId };
}

export function attachmentScope(thread: ThreadScope, owner: AttachmentOwner): AttachmentScope {
  return { environment: thread.environment, threadId: thread.threadId, owner };
}

/**
 * The canonical string form of a thread scope, built on the kernel's
 * `resolvePath()` so an object-storage prefix, a log field and a cache
 * namespace agree by construction rather than by convention.
 */
export function threadPath(scope: ThreadScope): string {
  return `${resolvePath(scope.environment)}/thread/${scope.threadId}`;
}

export function sameThreadScope(left: ThreadScope, right: ThreadScope): boolean {
  return threadPath(left) === threadPath(right);
}

/**
 * The tenant boundary, on its own. Dedupe and blob reuse are permitted across
 * threads but never across environments, so the two questions are separate
 * predicates rather than one conflated "same scope".
 */
export function sameEnvironment(left: ThreadScope, right: ThreadScope): boolean {
  return resolvePath(left.environment) === resolvePath(right.environment);
}

export function sameAttachmentScope(left: AttachmentScope, right: AttachmentScope): boolean {
  return (
    sameThreadScope(left, right) &&
    left.owner.endUserId === right.owner.endUserId &&
    left.owner.agentId === right.owner.agentId
  );
}

/** Widen an attachment scope to the thread both aggregates share. */
export function toThreadScope(scope: AttachmentScope): ThreadScope {
  return { environment: scope.environment, threadId: scope.threadId };
}
