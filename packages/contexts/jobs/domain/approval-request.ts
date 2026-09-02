// Requesting an approval, and recognising a duplicate request.
//
// THE DIGEST SUBJECT IS A WIRE FORMAT, NOT AN IMPLEMENTATION DETAIL. The live
// `computeRequestHash` is:
//
//     createHash("sha256").update(JSON.stringify({
//       o: scope.organizationId, p: scope.projectId, e: scope.environmentId,
//       t: toolName, a: redactedArgs,
//     })).digest("hex")
//
// Three properties of that expression are load-bearing and every one of them is
// invisible if you only read the field list:
//
//   1. THE KEYS ARE SINGLE LETTERS — `o`, `p`, `e`, `t`, `a`. Not `organizationId`.
//   2. THE ORDER IS FIXED by the object literal, and `JSON.stringify` preserves
//      insertion order. Reordering changes every digest.
//   3. THE ARGUMENTS ARE STRINGIFIED AS GIVEN, so two logically equal argument
//      objects whose keys arrived in different orders hash DIFFERENTLY and do not
//      dedupe. That is a live weakness, not a design; it is preserved here and
//      reported rather than silently corrected, because correcting it would make
//      every approval in flight at cutover fail to match its retry.
//
// The subject is therefore built by one function, used by both the mint and the
// lookup path, so the two cannot drift.

import { asIdentifier, type JsonValue } from "@platos/kernel";

import type { AgentId, ApprovalId, RequestDigest, ThreadId, TurnId } from "./identifiers.js";
import type { ApprovalSource } from "./approval-status.js";
import type { DigestFunction } from "./payload.js";

export interface ApprovalScopeClaim {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/**
 * Build the exact string the live system digests. Exported so a test can assert
 * the shape rather than only the hash, and so a future migration to a stable
 * serialisation has one place to change and one place to prove.
 */
export function approvalDigestSubject(
  scope: ApprovalScopeClaim,
  toolName: string,
  redactedArguments: JsonValue,
): string {
  return JSON.stringify({
    o: scope.organizationId,
    p: scope.projectId,
    e: scope.environmentId,
    t: toolName,
    a: redactedArguments,
  });
}

export function computeApprovalDigest(
  digest: DigestFunction,
  scope: ApprovalScopeClaim,
  toolName: string,
  redactedArguments: JsonValue,
): RequestDigest {
  return asIdentifier<RequestDigest>(digest(approvalDigestSubject(scope, toolName, redactedArguments)));
}

/** What a caller must supply to open an approval. */
export interface ApprovalRequest {
  readonly approvalId: ApprovalId;
  readonly source: ApprovalSource;
  readonly action: string;
  readonly details: string | null;
  readonly agentId: AgentId | null;
  readonly threadId: ThreadId | null;
  readonly turnId: TurnId | null;
  readonly toolName: string | null;
  readonly arguments: JsonValue | null;
  readonly requestedBy: string | null;
  readonly requestedByTokenId: string | null;
  readonly requestDigest: RequestDigest | null;
  readonly timeoutSeconds: number;
}

/**
 * The action label the live MCP path writes when the caller supplies none:
 * `` `MCP tool call: ${toolName}` ``. Kept here so the string a human reads in an
 * approval queue has one definition.
 */
export function mcpActionLabel(toolName: string): string {
  return `MCP tool call: ${toolName}`;
}
