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
  LegacyOpenRequest,
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
export type { EnvironmentId, Result, TransactionScope } from "@platos/kernel";
export { err, ok } from "@platos/kernel";

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
  EnvelopeFormatDescriptor,
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

// WIN-259 M2.4 — the values `crypto.ts`'s THREE ports need, and the THIRD time
// this exact omission has been found on this issue.
//
// WITHOUT THIS BLOCK `KeyRing`, `AeadCipher` AND `Hasher` ARE UNIMPLEMENTABLE
// OUTSIDE THIS PACKAGE, and the two blocks above record the same discovery for
// `SecretsRepository` and `EnvironmentVariableRepository`. `crypto.ts` declares
// its ports in terms of `RootKeyRingState`, `SealedEnvelope`, `EnvelopeBinding`
// and `SecretMaterial`, every one of which an adapter can now NAME — but naming
// a type is not building a value. A `KeyRing` has to RETURN a `RootKeyRingState`
// and a `RootKeyVersion`; an `AeadCipher` has to RETURN a `SecretMaterial`; and
// neither constructor was reachable from here. An adapter that could not reach
// them had exactly two options, and both are worse than this export:
//
//   1. Cast a structural literal to the branded type. `RootKeyVersion` is
//      `Branded<number, "RootKeyVersion">` and `rootKeyRingState` is the ONLY
//      thing that checks the ring's one invariant — that the active version is
//      present. A cast skips the check, so a ring whose active key is missing
//      would seal nothing and report success.
//   2. Re-implement `secretMaterial`. That function is the redaction boundary:
//      the plaintext lives in a CLOSURE and every accessor is non-enumerable, so
//      `{ ...material }` is `{}`. A second implementation is a second redaction
//      policy over the same plaintext, and the one that leaks wins.
//
// `envelopeKeyInfo` AND `envelopeAad` ARE THE WIRE FORMAT ITSELF, and they are
// the reason this block is not merely a convenience. `envelope.ts` pins both
// strings byte-for-byte, down to the NUL separator, because "changing a
// separator, an order or a character makes every stored format-1 envelope
// permanently unopenable". An adapter that could not import them would have
// re-typed `platos:credential-secret:v1` and the field order by hand — which is
// how the THREE mutually incompatible envelope shapes in `domain/envelope.ts`'s
// header came to exist in the first place. Exporting them makes the domain the
// single source of the HKDF `info` and the AEAD associated data, so a change to
// either breaks the compile rather than the ciphertext.
//
// `ROOT_KEY_BYTE_LENGTH` is here for the same reason `ENVELOPE_FORMAT_VERSIONS`
// is above: it is a CLOSED fact about the format (AES-256 keys are 32 bytes) and
// a ring parser that carried its own literal would be a second opinion about one
// number. `invalidKeyRing` is the one refusal `domain/errors.ts` reserves for a
// ring that cannot satisfy the vault's invariants, and a parser that minted its
// own would put a fourteenth code in a closed set of thirteen.
export {
  ROOT_KEY_BYTE_LENGTH,
  envelopeAad,
  envelopeKeyInfo,
  invalidKeyRing,
  rootKeyRingState,
  rootKeyVersion,
  secretMaterial,
} from "../../domain/index.js";

// WIN-259 M2.4, second half — what `openLegacy` needs, and the FOURTH time this
// exact omission has been found on this issue.
//
// The block above made `AeadCipher.seal` and `.open` implementable outside this
// package. `openLegacy` is implementable only with three more names, and each is
// there for the reason the block above gives for `envelopeKeyInfo`: the adapter
// must ask the DOMAIN what a legacy format is, never decide for itself.
//
// `requireMigratableFormat` is the closed rule about which formats may be read
// at all. An adapter carrying its own `version === 2 || version === 3` would be a
// second opinion about a set `envelope.ts` derives from `writable`, and the day a
// fourth legacy format is catalogued the two would disagree silently — the
// adapter would refuse material the domain says is migratable.
//
// `requireLegacyEnvelopeShape` is the width rule, and it is the one an adapter is
// most tempted to inline. Format 2's nonce is 12 bytes and format 3's is 16; an
// adapter that hard-coded either would open one format and mis-slice the other,
// and a mis-sliced payload fails the tag check — which looks exactly like a wrong
// key. `AUTH_TAG_BYTES` travels with it for the same reason.
//
// `legacyEnvelopeUnreadable` is the one refusal `domain/errors.ts` reserves for
// this operation. An adapter minting its own would put a sixteenth code in a
// closed set of fifteen, and `contracts/index.test.ts` pins that set.
export type { LegacyEnvelopeParts, LegacySecretPayload } from "../../domain/index.js";
export {
  AUTH_TAG_BYTES,
  MIGRATABLE_ENVELOPE_FORMATS,
  canonicalRowRefusals,
  legacyEnvelopeUnreadable,
  requireLegacyEnvelopeShape,
  requireMigratableFormat,
} from "../../domain/index.js";
