// Rotate an environment's access key.
//
// THE THREE THINGS THIS HAS TO GET RIGHT, and none of them is the happy path.
//
//   REVOKE DOMINATES. The revocation generation is read BEFORE the rotation
//   queues for the environment lock and compared against what is seen UNDER it.
//   A revoke that starts after this call began therefore still wins: the
//   rotation observes a moved generation and refuses. Reading the generation
//   under the lock instead would make the two operations race, and a rotation
//   could reinstate a key an operator destroyed a moment earlier.
//
//   A RETRY MUST NOT ROTATE TWICE. If the caller re-presents key material that
//   is already the active key, the existing pair is returned unchanged. Without
//   this, a lost response walks the environment down a chain of rotations it
//   never asked for, retiring each key it just installed.
//
//   THE OLD KEY KEEPS WORKING FOR TEN MINUTES. The overlap is what makes
//   rotation a non-event for callers who have not yet picked up the new key.
//
// The arithmetic is `domain/access-key.ts`; the lock is the adapter's.

import {
  DEFAULT_ROTATION_OVERLAP_MS,
  assertGenerationUnchanged,
  accessKeyRotationSuperseded,
  identityStoreUnavailable,
  isRotationReplay,
  planRotation,
  validateRotationMaterial,
  type AccessKeyId,
  type AccessKeyRecord,
  type AccessKeyRotationPlan,
} from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";
import { asIdentifier, err, ok, type EnvironmentId, type Result } from "@platos/kernel";

export type RotateAccessKeyPorts = PortsOf<"repository" | "clock" | "ids">;

export interface RotateAccessKeyInput {
  readonly environmentId: EnvironmentId;
  /** SHA-256 hex of the key the caller generated. The key itself never arrives. */
  readonly keyHash: string;
  /** The public discriminator, `platos_live_...`. */
  readonly keyPrefix: string;
  readonly overlapMs?: number;
}

export async function rotateAccessKey(
  ports: RotateAccessKeyPorts,
  input: RotateAccessKeyInput,
): Promise<Result<AccessKeyRotationPlan>> {
  const material = validateRotationMaterial({
    keyHash: input.keyHash,
    keyPrefix: input.keyPrefix,
    overlapMs: input.overlapMs ?? DEFAULT_ROTATION_OVERLAP_MS,
  });
  if (!material.ok) return err(material.error);

  const keys = ports.repository.accessKeys;
  const observedGeneration = await keys.readRevocationGeneration(input.environmentId);
  if (observedGeneration === null) return err(identityStoreUnavailable());

  const active = await keys.findActiveKey(input.environmentId);
  if (isRotationReplay(active, material.value.keyHash)) {
    return ok(await replayedRotation(ports, input.environmentId, active));
  }

  const plan = planRotation({
    active,
    nextKeyId: asIdentifier<AccessKeyId>(ports.ids.uuid()),
    environmentId: input.environmentId,
    keyHash: material.value.keyHash,
    keyPrefix: material.value.keyPrefix,
    overlapMs: material.value.overlapMs,
    now: ports.clock.now(),
  });

  const committed = await keys.commitRotation({
    environmentId: input.environmentId,
    plan,
    observedGeneration,
  });
  // The generation seen under the lock is the authority. The domain decides what
  // a mismatch means; the store only reports what it saw.
  const unchanged = assertGenerationUnchanged(observedGeneration, committed.generation);
  if (!unchanged.ok) return err(unchanged.error);
  if (!committed.committed) return err(accessKeyRotationSuperseded());

  return ok(plan);
}

/**
 * The idempotent answer: the active key is already the requested one, so return
 * it together with whatever is still inside its overlap.
 */
async function replayedRotation(
  ports: RotateAccessKeyPorts,
  environmentId: EnvironmentId,
  active: AccessKeyRecord | null,
): Promise<AccessKeyRotationPlan> {
  const now = ports.clock.now();
  const nextKey = active as AccessKeyRecord;
  const previous = await ports.repository.accessKeys.findByHash(environmentId, nextKey.keyHash);
  return {
    nextKey,
    retiringKey: previous !== null && previous.accessKeyId !== nextKey.accessKeyId ? previous : null,
    overlapEndsAt: now,
  };
}

/** Revoke every key for an environment and bump the generation. */
export async function revokeAccessKeys(
  ports: RotateAccessKeyPorts,
  input: { readonly environmentId: EnvironmentId },
): Promise<Result<number>> {
  const revoked = await ports.repository.accessKeys.revokeAll(
    input.environmentId,
    ports.clock.now(),
  );
  return ok(revoked);
}
