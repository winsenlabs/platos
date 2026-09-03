// Use case: rename a provider key, or make it the default.
//
// The only mutation on this row that touches no material at all. It still takes
// `secret:mutate`, and that is transcribed rather than tightened: promoting a
// key decides which credential every unpinned turn in the environment will
// spend against, which is a decision about secrets even though no secret moves.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitProviderKeyPatch,
  applyPatch,
  providerKeyNotFound,
  type ProviderKey,
  type ProviderKeyId,
  type ProviderKeyPatch,
} from "../domain/index.js";
import { requireAccess, verifyOperator } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import { assertLabelIsFree, saveProviderKey } from "./provider-key-store.js";

export interface UpdateProviderKeyCommand {
  readonly authorization: unknown;
  readonly providerKeyId: ProviderKeyId;
  readonly patch: ProviderKeyPatch;
}

export async function updateProviderKey(
  dependencies: ProvidersDependencies,
  command: UpdateProviderKeyCommand,
): Promise<Result<ProviderKey>> {
  const verified = verifyOperator(dependencies, command.authorization);
  if (!verified.ok) return err(verified.error);
  const granted = requireAccess(verified.value, "secret:mutate");
  if (!granted.ok) return err(granted.error);

  const patch = admitProviderKeyPatch(command.patch);
  if (!patch.ok) return err(patch.error);

  const scope = granted.value.scope;
  const found = await dependencies.repository.findProviderKey(scope, command.providerKeyId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(providerKeyNotFound(command.providerKeyId));

  const existing = found.value;
  if (patch.value.label !== null && patch.value.label !== existing.label) {
    const free = await assertLabelIsFree(dependencies, scope, existing.provider, patch.value.label, existing);
    if (!free.ok) return err(free.error);
  }

  // The incumbent is demoted only when this call PROMOTES the key. A patch that
  // repeats `isDefault: true` on a key that already holds it changes nothing, so
  // it must not take the demotion path and race with a concurrent promotion.
  const promotes = patch.value.isDefault === true && !existing.isDefault;
  const updated = applyPatch(existing, patch.value, dependencies.clock.now());
  return saveProviderKey(dependencies, scope, updated, promotes);
}
