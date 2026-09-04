// Identifiers owned by the `conversations` context (ADR M0.3 §1, context 16).
//
// This context is SOLE WRITER of four rows — `Thread`, `Turn`, `Step` and
// `PostmanExecution` (scripts/arch/table-ownership.mjs) — so the four brands
// below are minted here and nowhere else. Everything else in this file is a
// foreign key those rows carry: read, stored, and never authored.
//
// THE FOREIGN BRANDS ARE SPELLED WITH THEIR OWNER'S TAG ON PURPOSE. A context's
// `domain/` may import only its own domain and `@platos/kernel` (ADR M0.3 §2),
// so it cannot name another context's type. Spelling the brand identically makes
// the two ONE type: an `AgentId` handed across the contract boundary from
// `agents` reaches a repository method here without a cast, and an
// `AgentVersionId` still cannot be passed where an `AgentId` belongs.
//
//   AgentId, AgentVersionId, ClusterId   `agents` owns them (§1 row 5). A thread
//                                        names an agent and optionally a
//                                        cluster; every turn names the exact
//                                        version that produced it, which is the
//                                        axis a canary is judged along.
//   EndUserId                            `identity-access` owns it (row 1). A
//                                        thread belongs to one end user, and
//                                        that is the subject an erasure plan is
//                                        drawn against.
//   ActorId                              An operator `User.id`. Carried by
//                                        `PostmanExecution.actorUserId`, which
//                                        is the ONE row here written on an
//                                        operator's behalf rather than an end
//                                        user's.
//   ModelPriceId                         `providers` owns it (row 4). A step
//                                        records WHICH price card it was
//                                        charged against, so a re-price later
//                                        cannot rewrite history silently.
//   ProviderKeyId                        `providers` owns it. Which key paid.
//   PostmanTemplateId                    `agents` owns the saved request a
//                                        postman execution was launched from.
//   ToolCallId                           A provider-minted correlation id. Not a
//                                        row of ours; it threads a tool call to
//                                        its result inside one step.

import type { Branded } from "@platos/kernel";

/** `Thread.id` — uuid. Environment-scoped; one end user, one agent. */
export type ThreadId = Branded<string, "ThreadId">;

/** `Turn.id` — uuid. Unique by `[threadId, sequence]`. */
export type TurnId = Branded<string, "TurnId">;

/** `Step.id` — uuid. Unique by `[turnId, sequence]`. One model call. */
export type StepId = Branded<string, "StepId">;

/** `PostmanExecution.id` — uuid. One operator-launched request against an agent. */
export type PostmanExecutionId = Branded<string, "PostmanExecutionId">;

/** `Agent.id`. Written by `agents` (ADR M0.3 §1 row 5). */
export type AgentId = Branded<string, "AgentId">;

/** `AgentVersion.id`. Written by `agents`. Every turn pins exactly one. */
export type AgentVersionId = Branded<string, "AgentVersionId">;

/** `AgentCluster.id`. Written by `agents`. A thread's optional routing group. */
export type ClusterId = Branded<string, "ClusterId">;

/** `EndUser.id`. Written by `identity-access` (row 1). The thread's subject. */
export type EndUserId = Branded<string, "EndUserId">;

/**
 * An operator `User.id`.
 *
 * Deliberately not the kernel `PrincipalId`, for the reason `governance` gives
 * of its own actor brand: this context may not import `identity-access` (row 16
 * allows agents, skills, tools, memory, providers, files, cost-monitoring, jobs,
 * secrets, tenancy), so it names the actor without adopting identity's model of
 * one.
 */
export type ActorId = Branded<string, "ActorId">;

/** `ModelPrice.id`. Written by `providers` (row 4). What a step was charged at. */
export type ModelPriceId = Branded<string, "ModelPriceId">;

/** `ProviderKey.id`. Written by `providers`. Which key paid for a step. */
export type ProviderKeyId = Branded<string, "ProviderKeyId">;

/** `PostmanTemplate.id`. Written by `agents`. The saved request, when there was one. */
export type PostmanTemplateId = Branded<string, "PostmanTemplateId">;

/**
 * The provider's correlation id for one tool round trip.
 *
 * A `String`, not a uuid, and not a row this context stores on its own: it
 * threads a `tool-call` content part to its `tool-result` inside a single step,
 * and it is the provider that mints it.
 */
export type ToolCallId = Branded<string, "ToolCallId">;

/**
 * A caller-supplied de-duplication key for a turn.
 *
 * `Turn.idempotencyKey` is unique by `[threadId, idempotencyKey]`, so a
 * transport that redelivers a verified provider event twice gets ONE turn. It is
 * the transport's value, branded here so it cannot be passed where a turn id is
 * expected.
 */
export type IdempotencyKey = Branded<string, "IdempotencyKey">;

/**
 * The opaque handle a postman execution is resumed by.
 *
 * `PostmanExecution.contextHandle` is `@unique` and paired with
 * `contextExpiresAt`. Branded because it is a capability: whoever holds it can
 * name that execution, so it must not be interchangeable with a row id.
 */
export type PostmanContextHandle = Branded<string, "PostmanContextHandle">;

/**
 * Tag an already-provenanced string. Like the kernel's `asIdentifier`, this is
 * an assertion and not validation: adapters reading a row, and transports
 * parsing a request, are the only callers that should reach for it.
 */
export function asConversationsIdentifier<Id extends Branded<string, string>>(value: string): Id {
  return value as Id;
}
