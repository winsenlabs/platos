// Migrate a legacy envelope onto format 1 — the operation `domain/envelope.ts`
// named and, until now, nothing performed.
//
// WHAT IT IS NOT. It is not a re-encryption and it is not a rotation. Both of
// those start from an envelope this context already owns, in a row it wrote, and
// re-seal it. This one starts from a STRING in a column this context does not own
// and has never written: `OperatorMfaTotp.encryptedSecret` for format 2, the
// agent's base64 secret columns for format 3. There is nothing to re-wrap,
// because there is no canonical row yet.
//
// AND IT COULD NOT BE ONE. `legacy-envelope.ts` carries the finding: the initial
// migration's CHECK constraints on `CredentialSecretVersion` — salt exactly 32
// bytes, nonce exactly 12, rootKeyVersion strictly positive — are each violated
// by both legacy descriptors, so PostgreSQL has always refused a legacy envelope
// in that table with SQLSTATE 23514. A migration that tried to UPDATE a legacy
// row into a canonical one would have had no row to update.
//
// THE MATERIAL PASSES THROUGH `SecretMaterial` AND NOTHING ELSE. `openLegacy`
// answers with the redacting value, `sealSecret` consumes it, and no local
// variable in this file ever holds a bare string. That matters more here than
// anywhere else in the package: this is the one path on which plaintext that was
// protected by a raw single key, bound to no context, crosses into the vault.
//
// IT CONVERGES RATHER THAN CLOBBERING. A credential that already points at a
// canonical envelope is returned as-is, success, untouched. An operator sweeping
// an environment must be able to run this over every credential and repeat a
// partial sweep — and the alternative reading, "replace whatever is there with
// the legacy material", would let a stale column overwrite a secret that had
// already been rotated properly. That is the dangerous direction, so it is the
// one that is not expressible.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireSecretMutation } from "../domain/access-rules.js";
import type { EnvironmentAuthorization } from "../domain/authorization.js";
import { credentialUnavailable } from "../domain/errors.js";
import { FIRST_SECRET_REVISION, secretRevision } from "../domain/ids.js";
import type { CredentialId } from "../domain/ids.js";
import { requireMigratableFormat } from "../domain/legacy-envelope.js";
import type { LegacySecretPayload } from "../domain/legacy-envelope.js";
import { toCredentialMetadata } from "../domain/metadata.js";
import type { CredentialMetadata } from "../domain/metadata.js";
import { recordAudit } from "./audit-log.js";
import type { SecretsDependencies } from "./dependencies.js";
import { sealSecret } from "./envelope-operations.js";
import { inTransaction } from "./transaction.js";

export interface MigrateLegacyEnvelopeCommand {
  readonly authorization: EnvironmentAuthorization;
  readonly credentialId: CredentialId;
  /** The legacy column's value and the format that says how to read it. */
  readonly legacy: LegacySecretPayload;
}

export async function migrateLegacyEnvelope(
  deps: SecretsDependencies,
  command: MigrateLegacyEnvelopeCommand,
): Promise<Result<CredentialMetadata>> {
  // MUTATION, NOT READ, AND THE DISTINCTION IS LOAD-BEARING. This operation ends
  // with plaintext sealed under the active root key, so it is administered by an
  // operator — the same grant `rotateCredential` and `reEncryptCredential`
  // require. `requireSecretRead` would have been the wrong gate twice over: it
  // admits the runtime tier, and the runtime tier must never be able to introduce
  // material into the vault.
  const granted = requireSecretMutation(command.authorization);
  if (!granted.ok) return err(granted.error);

  // The format is judged BEFORE the credential is loaded and before any key is
  // touched. A caller pointing this at format 1 has made a mistake about its own
  // data, and it should learn that without a row lock being taken on its behalf.
  const format = requireMigratableFormat(command.legacy.formatVersion);
  if (!format.ok) return err(format.error);

  const authorization = granted.value;
  const environmentId = authorization.environmentId;

  return inTransaction(deps.unitOfWork, async (transaction) => {
    const loaded = await deps.repository.loadForUpdate(
      environmentId,
      command.credentialId,
      transaction,
    );
    if (!loaded.ok) return err(loaded.error);
    const current = loaded.value;
    if (current === null) return err(credentialUnavailable("credential_not_found"));
    if (current.credential.revokedAt !== null) {
      return err(credentialUnavailable("credential_revoked"));
    }

    // ALREADY CANONICAL IS A SUCCESS. See the header: this is what makes a
    // half-finished sweep safe to run again, and it is also the guard that stops
    // a legacy column from overwriting a secret an operator has since rotated.
    const existing = current.activeSecretVersion;
    if (existing !== null) return ok(toCredentialMetadata(current.credential, existing));

    const material = await deps.cipher.openLegacy({
      formatVersion: format.value.formatVersion,
      payload: command.legacy.payload,
    });
    if (!material.ok) return err(material.error);

    // REVISION 1, NOT `nextSecretRevision`. There is no previous CANONICAL
    // version — the branch above returned when there was one — so this is the
    // credential's first envelope in this table, and numbering it anything else
    // would claim a history of canonical revisions that never existed.
    const revision = secretRevision(FIRST_SECRET_REVISION);
    if (!revision.ok) return err(revision.error);

    const draft = await sealSecret(deps, {
      environmentId,
      credentialId: current.credential.id,
      secretRevision: revision.value,
      plaintext: material.value,
    });
    if (!draft.ok) return err(draft.error);

    const stored = await deps.repository.insertSecretVersion(draft.value, transaction);
    if (!stored.ok) return err(stored.error);

    const now = deps.clock.now();
    const pointed = await deps.repository.setActiveSecretVersion(
      current.credential.id,
      stored.value.id,
      now,
      transaction,
    );
    if (!pointed.ok) return err(pointed.error);

    // `MIGRATE`, AND IT IS WHY THE CLOSED ACTION SET GREW BY ONE. An operator
    // reading this trail has to be able to see that this credential's material
    // arrived from a raw-key, context-unbound envelope rather than from a
    // `CREATE` an operator typed. The two have different provenance and different
    // blast radii, and an audit row that called both `CREATE` would have made the
    // difference unrecoverable after the legacy column was dropped.
    //
    // `fromRootKeyVersion` IS OMITTED, WHICH `recordAudit` WRITES AS NULL. The
    // source had no root key version at all: formats 2 and 3 record
    // `versionedRootKey: false`. Writing the destination version into both
    // columns — which is what every other action here does — would assert the
    // material moved between two ring versions, and it did not; it entered the
    // ring for the first time. A migrated row is therefore the only one in the
    // trail with a `to` and no `from`, and that asymmetry is the evidence.
    const audited = await recordAudit(
      deps,
      {
        authorization,
        environmentId,
        credentialId: current.credential.id,
        action: "MIGRATE",
        secretRevision: revision.value,
        toRootKeyVersion: stored.value.rootKeyVersion,
      },
      transaction,
    );
    if (!audited.ok) return err(audited.error);

    return ok(toCredentialMetadata(pointed.value, stored.value));
  });
}
