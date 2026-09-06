// The ONE path by which plaintext leaves the encryption boundary.
//
// Three properties, all of them enforced above the cipher:
//
//   1. RUNTIME TIER ONLY. `requireSecretRead` rejects an operator grant however
//      privileged. Operators administer the vault; they do not read out of it.
//   2. ACTIVE ENVELOPE ONLY. A retired version is closed the instant it is
//      retired, and a version the credential no longer points at is not reachable
//      at all.
//   3. EVERY READ IS AUDITED, IN THE SAME TRANSACTION. If the evidence cannot be
//      written, the read does not happen. The extraction source's integration
//      suite pins the same behaviour ("audits every read").
//   4. WIN-259 — A DENIED READ IS AUDITED TOO. `CredentialAudit` has carried a
//      `DENIED` outcome since this context was written and NOTHING ever wrote
//      one: a caller reaching for material it may not have left no trace at all,
//      so the one event a leak investigation most wants — somebody probing the
//      vault — was the one event the trail did not hold. It is written in its
//      OWN unit of work, for the reason `recordDeniedRead` gives.
//
// The return value is `SecretMaterial`, which redacts itself under JSON, string
// coercion, inspection, spreading and enumeration. It is the only type in this
// package that ever holds plaintext.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireSecretRead } from "../domain/access-rules.js";
import { isMintedAuthorization } from "../domain/authorization.js";
import type { EnvironmentAuthorization } from "../domain/authorization.js";
import { isUsable } from "../domain/credential.js";
import type { CredentialKind } from "../domain/credential.js";
import { credentialUnavailable } from "../domain/errors.js";
import type { CredentialId } from "../domain/ids.js";
import type { SecretMaterial } from "../domain/secret-material.js";
import { recordAudit } from "./audit-log.js";
import type { SecretsDependencies } from "./dependencies.js";
import { openSecret } from "./envelope-operations.js";
import { inTransaction } from "./transaction.js";

export interface ReadSecretQuery {
  readonly authorization: EnvironmentAuthorization;
  readonly credentialId?: CredentialId;
  readonly name?: string;
  readonly provider?: string;
  readonly kind?: CredentialKind;
}

function credentialSelector(query: ReadSecretQuery): {
  readonly credentialId?: CredentialId;
  readonly name?: string;
  readonly provider?: string;
  readonly kind?: CredentialKind;
} {
  return {
    ...(query.credentialId === undefined ? {} : { credentialId: query.credentialId }),
    ...(query.name === undefined ? {} : { name: query.name }),
    ...(query.provider === undefined ? {} : { provider: query.provider }),
    ...(query.kind === undefined ? {} : { kind: query.kind }),
  };
}

/**
 * Write the evidence that somebody reached for material they may not have.
 *
 * THREE DELIBERATE CHOICES, each of which is a limit rather than a convenience.
 *
 * IT IS ITS OWN UNIT OF WORK. Every other audit row in this context commits
 * with the state change it describes, so an unauditable change does not happen.
 * A denial changes nothing, so there is no change to roll back — and writing
 * the row inside the read's transaction would roll it back along with the read
 * it is evidence of, which is the same as not writing it.
 *
 * AN UNMINTED AUTHORIZATION IS NOT RECORDED. `actorId` on a forged literal is
 * whatever the forger typed. A trail that accepts it is a trail an attacker can
 * write into, which is worse than a gap: the gap is honest.
 *
 * A CREDENTIAL THAT DOES NOT RESOLVE IS NOT RECORDED, and this is a MEASURED
 * limit of the canonical schema rather than a decision.
 * `CredentialAudit.credentialId` is a required column with a foreign key to
 * `Credential`, so there is no row shape for "denied a read of a credential
 * that does not exist". Probing for a name that is not there is therefore
 * invisible here, and closing that needs a schema change — a nullable
 * `credentialId`, or a separate table — which is not this issue's to make.
 *
 * A failure to append is SWALLOWED, and only here. The fail-closed rule exists
 * so an unauditable mutation does not happen; this mutation already did not
 * happen, and turning a denial into a different denial because the trail was
 * unavailable would tell the caller something about the vault's health.
 */
export async function recordDeniedRead(
  deps: SecretsDependencies,
  query: ReadSecretQuery,
): Promise<void> {
  const authorization = query.authorization;
  if (!isMintedAuthorization(authorization)) return;
  const environmentId = authorization.environmentId;

  const found = await deps.repository.findCredential({
    environmentId,
    ...credentialSelector(query),
  });
  if (!found.ok || found.value === null) return;
  const probed = found.value;
  const version = probed.activeSecretVersion;

  await inTransaction(deps.unitOfWork, (transaction) =>
    recordAudit(
      deps,
      {
        authorization,
        environmentId,
        credentialId: probed.credential.id,
        action: "READ",
        outcome: "DENIED",
        ...(version === null
          ? {}
          : {
              secretRevision: version.secretRevision,
              fromRootKeyVersion: version.rootKeyVersion,
              toRootKeyVersion: version.rootKeyVersion,
            }),
      },
      transaction,
    ),
  );
}

export async function readSecret(
  deps: SecretsDependencies,
  query: ReadSecretQuery,
): Promise<Result<SecretMaterial>> {
  const granted = requireSecretRead(query.authorization);
  if (!granted.ok) {
    await recordDeniedRead(deps, query);
    return err(granted.error);
  }

  const authorization = granted.value;
  const environmentId = authorization.environmentId;

  return inTransaction(deps.unitOfWork, async (transaction) => {
    const found = await deps.repository.findCredential({
      environmentId,
      ...credentialSelector(query),
    });
    if (!found.ok) return err(found.error);
    const current = found.value;
    if (current === null) return err(credentialUnavailable("credential_not_found"));

    const now = deps.clock.now();
    if (!isUsable(current.credential, now)) {
      return err(
        credentialUnavailable(
          current.credential.revokedAt === null ? "no_active_secret_version" : "credential_revoked",
        ),
      );
    }
    const version = current.activeSecretVersion;
    if (version === null) return err(credentialUnavailable("no_active_secret_version"));

    const material = await openSecret(deps, {
      environmentId,
      version,
      activeSecretVersionId: current.credential.activeSecretVersionId,
    });
    if (!material.ok) return err(material.error);

    const audited = await recordAudit(
      deps,
      {
        authorization,
        environmentId,
        credentialId: current.credential.id,
        action: "READ",
        secretRevision: version.secretRevision,
        fromRootKeyVersion: version.rootKeyVersion,
        toRootKeyVersion: version.rootKeyVersion,
      },
      transaction,
    );
    if (!audited.ok) return err(audited.error);

    return ok(material.value);
  });
}
