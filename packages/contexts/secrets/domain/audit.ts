// CredentialAudit — the append-only evidence trail.
//
// Two properties the extraction source's integration suite pins, restated as
// domain rules:
//
//   * "keeps audit rows immutable and FAILS CLOSED when audit insertion fails" —
//     an unauditable mutation does not happen. The audit append is part of the
//     same unit of work as the state change, not a best-effort afterthought.
//   * "records METADATA-ONLY evidence" — an audit row names revisions and root
//     key versions. It never names a plaintext, a ciphertext or a key.
//
// `fromRootKeyVersion` and `toRootKeyVersion` are what make a rotation auditable:
// together they say which key an envelope left and which key it arrived on.

import type { EnvironmentId } from "@platos/kernel";

import type {
  ActorId,
  CredentialAuditId,
  CredentialId,
  RootKeyVersion,
  SecretRevision,
} from "./ids.js";

// `MIGRATE` is the seventh, and it is not a synonym for `CREATE`. A credential
// whose material arrived from a legacy column was protected by a raw single key
// bound to no context — `domain/envelope.ts` catalogues exactly how weak both
// legacy shapes are — and an operator auditing the vault has to be able to find
// those credentials AFTER the legacy column has been dropped and the only
// remaining evidence is this row. Recording them as `CREATE` would have made that
// provenance unrecoverable. It is also the one action that writes a
// `toRootKeyVersion` with no `fromRootKeyVersion`, because the material entered
// the ring rather than moving within it.
export const CREDENTIAL_AUDIT_ACTIONS = [
  "CREATE",
  "READ",
  "ROTATE",
  "REWRAP",
  "REVOKE",
  "PURGE",
  "MIGRATE",
] as const;

export type CredentialAuditAction = (typeof CREDENTIAL_AUDIT_ACTIONS)[number];

export const CREDENTIAL_AUDIT_OUTCOMES = ["SUCCESS", "DENIED", "FAILED"] as const;

export type CredentialAuditOutcome = (typeof CREDENTIAL_AUDIT_OUTCOMES)[number];

export interface CredentialAuditRecord {
  readonly id: CredentialAuditId;
  readonly environmentId: EnvironmentId;
  readonly credentialId: CredentialId;
  readonly action: CredentialAuditAction;
  readonly outcome: CredentialAuditOutcome;
  /** "operator" / "runtime" / "service" / "operations". */
  readonly actorType: string;
  readonly actorId: ActorId;
  /** Set only when an operator acted on someone else's behalf. */
  readonly effectiveUserId: ActorId | null;
  readonly secretRevision: SecretRevision | null;
  readonly fromRootKeyVersion: RootKeyVersion | null;
  readonly toRootKeyVersion: RootKeyVersion | null;
  readonly createdAt: Date;
}

export interface CredentialAuditDraft {
  readonly id: CredentialAuditId;
  readonly environmentId: EnvironmentId;
  readonly credentialId: CredentialId;
  readonly action: CredentialAuditAction;
  readonly outcome: CredentialAuditOutcome;
  readonly actorType: string;
  readonly actorId: ActorId;
  readonly effectiveUserId: ActorId | null;
  readonly secretRevision: SecretRevision | null;
  readonly fromRootKeyVersion: RootKeyVersion | null;
  readonly toRootKeyVersion: RootKeyVersion | null;
  readonly createdAt: Date;
}
