// The driven ports `secrets` needs. Implemented under `packages/adapters/*`,
// wired at the composition root, never imported by `domain/`.
//
// ADR M0.3 §13: an adapter-facing port belongs to the context whose capability it
// serves, so the vault's repository and its cryptography live here rather than in
// the kernel. The kernel supplies only the cross-cutting decoupling ports this
// context also uses — Clock, IdGenerator, UnitOfWork, OutboxWriter, Logger.
export type {
  AeadCipher,
  Hasher,
  KeyRing,
  OpenRequest,
  RootKeyHandle,
  SealRequest,
} from "./crypto.js";
export type {
  CredentialQuery,
  CredentialWithActiveVersion,
  RetiredSecretVersionCandidate,
  SecretsRepository,
} from "./secrets-repository.js";
export type {
  EnvironmentVariableRepository,
  EnvironmentVariableUpsert,
} from "./environment-variable-repository.js";

// WIN-258 T5 — the domain values the two canonical-store ports' SIGNATURES
// already name.
//
// WITHOUT THIS BLOCK BOTH PORTS ARE UNIMPLEMENTABLE OUTSIDE THIS PACKAGE.
// `secrets-repository.ts` above imports `Credential`, `CredentialDraft`,
// `CredentialSecretVersion`, `CredentialAuditDraft` and seven more from
// `../../domain/*.js` as TYPES and re-exports none of them; `contracts/index.ts`
// publishes the metadata VIEWS rather than the aggregates, on purpose, because a
// caller must never be handed an envelope. So every method here was declared in
// terms of names an adapter package — the only kind of package ADR M0.3 §2
// permits to implement a driven port — had no way to spell. The same omission
// was found three times already on this issue, on `EndUserStore`, on
// `SessionRevocationOrder` and on `cost-monitoring`'s whole aggregate set; this
// is the fourth, and it is repaired the same way: the port entry point publishes
// exactly what the port's own signatures use, and nothing more.
//
// THE FIVE VALUE EXPORTS ARE HERE FOR A STRONGER REASON THAN THE TYPES.
// `CREDENTIAL_KINDS`, `ENVIRONMENT_VARIABLE_KINDS` and
// `ENVELOPE_FORMAT_VERSIONS` are the CLOSED unions three columns are read back
// through. A store that could not name them would have written its own literal
// list, and two lists over one column is how a row becomes unreadable by the
// release that did not write it — `domain/envelope.ts` exists because that
// already happened three times to the envelope. `asSecretsIdentifier` is the
// tagging function `domain/ids.ts` reserves for "adapters reading a row and
// transports parsing a request", which is this caller exactly, and
// `credentialUnavailable` is the one refusal `domain/errors.ts` says a store may
// answer with ABOUT A CREDENTIAL — a store that minted its own would re-open the
// probing oracle that file collapses nine reasons to close.
//
// WIN-258 T7 adds a second, and it is a different kind of answer rather than a
// hole in the first. `environmentVariableVersionConflict` is not about a secret
// at all: it says the row a write was decided from has moved, it names no key
// and no value, and it is the outcome of a WHERE clause rather than of a lookup,
// so it discloses only what the caller's own failed write already told it.
//
// The kernel values these signatures name are republished for the reason
// `identity-access`'s and `cost-monitoring`'s port entry points republish
// theirs: `EnvironmentId`, `Result` and `TransactionScope` are in nearly every
// method above, and an adapter that reached for `@platos/kernel` directly would
// be a second import edge into the kernel from a package whose only declared
// dependency is the context whose port it satisfies.
export type { EnvironmentId, NotResult, Result, TransactionScope } from "@platos/kernel";
// WIN-260 (M2.5): `runResult` joins them, and `NotResult` beside it.
// `UnitOfWork.run` REFUSES a callback whose answer is a `Result` — such a
// callback RESOLVES, and a resolved callback COMMITS, which is the defect
// `cost-monitoring` shipped — so `runResult` is the only way to end a unit of
// work with a failure, and every canonical store's suite needs it. It is
// republished HERE rather than imported from `@platos/kernel` in the adapter,
// for the reason stated above: that would be the second import edge into the
// kernel this paragraph exists to refuse.
// WIN-260 (M2.5): `domainError` joins them, for the reason `tenancy`'s and
// `identity-access`' entry points state — the real-PostgreSQL transaction
// boundary suite asserts that a returned error `Result` ROLLS BACK where it
// used to assert that it committed, and a suite that cannot CONSTRUCT a
// `DomainError` cannot state the case.
export { domainError, err, ok, runResult } from "@platos/kernel";

export type {
  ActorId,
  Credential,
  CredentialAuditAction,
  CredentialAuditDraft,
  CredentialAuditId,
  CredentialAuditOutcome,
  CredentialDraft,
  CredentialId,
  CredentialKind,
  CredentialSecretVersion,
  CredentialSecretVersionDraft,
  EnvelopeBinding,
  EnvelopeFormatVersion,
  EnvironmentVariable,
  EnvironmentVariableId,
  EnvironmentVariableKind,
  RootKeyRingState,
  RootKeyUsage,
  RootKeyVersion,
  SealedEnvelope,
  SecretMaterial,
  SecretRevision,
  SecretVersionId,
} from "../../domain/index.js";
export {
  CREDENTIAL_KINDS,
  ENVELOPE_FORMAT_VERSIONS,
  ENVIRONMENT_VARIABLE_KINDS,
  asSecretsIdentifier,
  credentialNameTaken,
  credentialUnavailable,
  environmentVariableVersionConflict,
  secretVersionAlreadyExists,
} from "../../domain/index.js";
