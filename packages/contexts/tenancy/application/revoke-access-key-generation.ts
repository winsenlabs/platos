// Use case: advance an environment's access-key revocation generation.
//
// THIS USE CASE EXISTS ONLY BECAUSE OF A SINGLE-WRITER VIOLATION, and it is the
// tenancy-side half of the fix. `Environment.accessKeyRevocationVersion` is a
// tenancy-owned column that identity-access's access-key code writes directly
// today (`internal-packages/tenancy-database/src/access-key.ts`,
// `revokeAccessKeys`). The full argument is on
// `EnvironmentAccessKeyRevocationCounter`.
//
// The semantics are copied exactly, because access-key correctness depends on
// them: take the environment row lock, increment unconditionally, and let the
// caller compare the returned generation against the one it snapshotted. A
// rotation whose snapshot no longer matches must abort — that is what stops a
// rotation in flight from resurrecting a key a concurrent revocation just
// killed.
//
// It deliberately does NOT touch `AccessKey` rows. Those belong to
// identity-access, and tenancy revoking them would be the same violation in the
// other direction.

import type { EnvironmentId, Result } from "@platos/kernel";
import { err, ok } from "@platos/kernel";

import { accessKeyGenerationSuperseded, tenantNotFound } from "../domain/index.js";

import type { TenancyDependencies } from "./dependencies.js";

export interface RevokeAccessKeyGenerationCommand {
  readonly environmentId: EnvironmentId;
  /**
   * The generation the caller observed before it asked. When supplied and
   * stale, the request is refused rather than silently applied — the caller's
   * view of the world has already been superseded.
   */
  readonly expectedGeneration?: number;
}

export type RevokeAccessKeyGeneration = (
  command: RevokeAccessKeyGenerationCommand,
) => Promise<Result<number>>;

type Dependencies = Pick<
  TenancyDependencies,
  "accessKeyRevocation" | "locks" | "unitOfWork"
>;

export function createRevokeAccessKeyGeneration(
  dependencies: Dependencies,
): RevokeAccessKeyGeneration {
  const { accessKeyRevocation, locks, unitOfWork } = dependencies;
  return async (command) =>
    unitOfWork.run(async (transaction) => {
      const locked = await locks.lockEnvironmentForUpdate(command.environmentId, transaction);
      if (!locked) return err(tenantNotFound("environment"));

      if (command.expectedGeneration !== undefined) {
        const current = await accessKeyRevocation.read(command.environmentId);
        if (current === null) return err(tenantNotFound("environment"));
        if (current !== command.expectedGeneration) {
          return err(accessKeyGenerationSuperseded(current, command.expectedGeneration));
        }
      }
      return ok(await accessKeyRevocation.bump(command.environmentId, transaction));
    });
}
