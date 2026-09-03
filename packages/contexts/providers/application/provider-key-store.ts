// The write helpers every ProviderKey mutation shares.
//
// The single-default invariant is enforced in exactly one place, here, and both
// the "link an existing credential" and the "register new material" paths go
// through it. In the source that demotion is written twice — once in the link
// helper and once in the update path — with a lock in one and not the other, so
// the two could and did diverge.
//
// THE DEMOTION AND THE PROMOTION SHARE ONE TRANSACTION. That is what makes the
// store's partial unique index a backstop rather than a race: two operators
// promoting different keys for one provider at the same moment serialise on the
// row they both have to demote, and the loser sees a constraint violation rather
// than a second default.

import { err, ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  defaultsToDemote,
  demote,
  labelIsTaken,
  providerKeyAlreadyExists,
  type ProviderId,
  type ProviderKey,
} from "../domain/index.js";
import type { ProvidersDependencies } from "./dependencies.js";

/**
 * Refuse a label another key in this environment and provider already carries.
 *
 * A pre-check, not the guarantee: the guarantee is the store's
 * `@@unique([environmentId, provider, label])`. It exists so the ordinary
 * collision is refused BEFORE anything irreversible happens — before a
 * credential is created or a secret is rotated — rather than after.
 */
export async function assertLabelIsFree(
  dependencies: ProvidersDependencies,
  scope: EnvironmentScope,
  provider: ProviderId,
  label: string,
  excluding: ProviderKey | null = null,
): Promise<Result<void>> {
  const held = await dependencies.repository.listProviderKeysFor(scope, provider);
  if (!held.ok) return err(held.error);
  if (labelIsTaken(held.value, scope.environmentId, provider, label, excluding?.providerKeyId ?? null)) {
    return err(providerKeyAlreadyExists(provider, label));
  }
  return ok(undefined);
}

/**
 * Demote whichever key currently holds the default for this provider.
 *
 * Runs inside the caller's transaction, before the promotion it makes room for.
 */
export async function demoteIncumbentDefault(
  dependencies: ProvidersDependencies,
  scope: EnvironmentScope,
  promoted: ProviderKey,
  transaction: TransactionScope,
): Promise<Result<void>> {
  const held = await dependencies.repository.listProviderKeysFor(scope, promoted.provider);
  if (!held.ok) return err(held.error);
  const now = dependencies.clock.now();
  for (const incumbent of defaultsToDemote(held.value, promoted)) {
    const written = await dependencies.repository.updateProviderKey(
      demote(incumbent, now),
      transaction,
    );
    if (!written.ok) return err(written.error);
  }
  return ok(undefined);
}

/** Insert a key, making room for it first when it claims the default. */
export async function insertProviderKey(
  dependencies: ProvidersDependencies,
  scope: EnvironmentScope,
  draft: ProviderKey,
): Promise<Result<ProviderKey>> {
  return dependencies.unitOfWork.run(async (transaction) => {
    if (draft.isDefault) {
      const cleared = await demoteIncumbentDefault(dependencies, scope, draft, transaction);
      if (!cleared.ok) return err(cleared.error);
    }
    return dependencies.repository.insertProviderKey(draft, transaction);
  });
}

/** Write a changed key, making room for it first when it claims the default. */
export async function saveProviderKey(
  dependencies: ProvidersDependencies,
  scope: EnvironmentScope,
  updated: ProviderKey,
  claimsDefault: boolean,
): Promise<Result<ProviderKey>> {
  return dependencies.unitOfWork.run(async (transaction) => {
    if (claimsDefault) {
      const cleared = await demoteIncumbentDefault(dependencies, scope, updated, transaction);
      if (!cleared.ok) return err(cleared.error);
    }
    return dependencies.repository.updateProviderKey(updated, transaction);
  });
}
