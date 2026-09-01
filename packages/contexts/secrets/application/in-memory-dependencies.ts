// One call that assembles a fully wired, entirely in-memory `secrets` context.
//
// This is the shape of the composition root, minus the adapters: the same eight
// dependencies, bound the same way. A test that drives the vault through this is
// exercising the real use cases and the real domain rules, and only the
// infrastructure is doubled.

import { inMemoryAeadCipher, inMemoryClock, inMemoryHasher, inMemoryIdGenerator, inMemoryKeyRing, inMemoryUnitOfWork } from "./in-memory-crypto.js";
import type { InMemoryClock, InMemoryKeyRing, InMemoryUnitOfWork } from "./in-memory-crypto.js";
import { inMemorySecretsStore } from "./in-memory-store.js";
import type { InMemorySecretsStore } from "./in-memory-store.js";
import type { SecretsDependencies } from "./dependencies.js";

export interface InMemorySecretsOptions {
  readonly activeRootKeyVersion?: number;
  readonly presentRootKeyVersions?: readonly number[];
  readonly startedAt?: Date;
}

export interface InMemorySecrets {
  readonly dependencies: SecretsDependencies;
  readonly store: InMemorySecretsStore;
  readonly keyRing: InMemoryKeyRing;
  readonly clock: InMemoryClock;
  readonly unitOfWork: InMemoryUnitOfWork;
}

export function inMemorySecrets(options: InMemorySecretsOptions = {}): InMemorySecrets {
  const store = inMemorySecretsStore();
  const keyRing = inMemoryKeyRing(
    options.activeRootKeyVersion ?? 1,
    options.presentRootKeyVersions ?? [options.activeRootKeyVersion ?? 1],
  );
  const clock = options.startedAt === undefined ? inMemoryClock() : inMemoryClock(options.startedAt);
  const unitOfWork = inMemoryUnitOfWork([store]);
  const dependencies: SecretsDependencies = {
    repository: store,
    variables: store,
    keyRing,
    cipher: inMemoryAeadCipher(keyRing),
    hasher: inMemoryHasher(),
    clock,
    ids: inMemoryIdGenerator(),
    unitOfWork,
  };
  return { dependencies, store, keyRing, clock, unitOfWork };
}
