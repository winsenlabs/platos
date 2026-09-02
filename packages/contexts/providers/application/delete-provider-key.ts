// Use case: remove a provider key.
//
// It removes the LINK, never the material. The credential stays in the vault
// where `secrets` owns it, because another key, another environment variable, or
// a future link may still need it, and because a context that is not the vault's
// sole writer destroying vault rows is exactly the ownership violation the
// sole-writer lint exists to catch.
//
// THE PIN CHECK IS THE WHOLE OPERATION. An agent version can name a specific key
// — in its runtime configuration or on one of its model routes — and deleting a
// key some version still names would leave that version unable to run, with a
// failure that surfaces at the next turn rather than here. So the count is taken
// first and a non-zero one refuses, carrying the number so an operator is told
// how much work the fix is.

import { err, ok, type Result } from "@platos/kernel";

import {
  providerKeyNotFound,
  providerKeyPinnedByAgents,
  type ProviderKey,
  type ProviderKeyId,
} from "../domain/index.js";
import { requireAccess, verifyOperator } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";

export interface DeleteProviderKeyCommand {
  readonly authorization: unknown;
  readonly providerKeyId: ProviderKeyId;
}

export async function deleteProviderKey(
  dependencies: ProvidersDependencies,
  command: DeleteProviderKeyCommand,
): Promise<Result<ProviderKey>> {
  const verified = verifyOperator(dependencies, command.authorization);
  if (!verified.ok) return err(verified.error);
  const granted = requireAccess(verified.value, "secret:mutate");
  if (!granted.ok) return err(granted.error);

  const scope = granted.value.scope;
  const found = await dependencies.repository.findProviderKey(scope, command.providerKeyId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(providerKeyNotFound(command.providerKeyId));
  const key = found.value;

  const pinned = await dependencies.repository.countAgentVersionsPinning(scope, key.providerKeyId);
  if (!pinned.ok) return err(pinned.error);
  if (pinned.value > 0) {
    return err(providerKeyPinnedByAgents(key.providerKeyId, pinned.value));
  }

  const removed = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.deleteProviderKey(scope, key.providerKeyId, transaction),
  );
  if (!removed.ok) return err(removed.error);
  // The row was read inside this use case and is gone now. A `false` here means
  // something else removed it between the read and the write, which is the same
  // outcome the caller asked for and not a failure.
  await dependencies.probeCache.forgetProvider(key.provider);
  return ok(key);
}
