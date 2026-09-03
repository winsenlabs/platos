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
//
// The return value is `SecretMaterial`, which redacts itself under JSON, string
// coercion, inspection, spreading and enumeration. It is the only type in this
// package that ever holds plaintext.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireSecretRead } from "../domain/access-rules.js";
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

export async function readSecret(
  deps: SecretsDependencies,
  query: ReadSecretQuery,
): Promise<Result<SecretMaterial>> {
  const granted = requireSecretRead(query.authorization);
  if (!granted.ok) return err(granted.error);

  const authorization = granted.value;
  const environmentId = authorization.environmentId;

  return inTransaction(deps.unitOfWork, async (transaction) => {
    const found = await deps.repository.findCredential({
      environmentId,
      ...(query.credentialId === undefined ? {} : { credentialId: query.credentialId }),
      ...(query.name === undefined ? {} : { name: query.name }),
      ...(query.provider === undefined ? {} : { provider: query.provider }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
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
