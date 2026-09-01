// Everything a `secrets` use case is given. One bundle, so a use case signature
// stays `(deps, command)` and the composition root has exactly one thing to wire.
//
// ADR M0.3 §6 budgets constructor-injected dependencies at 6 (warn) / 8 (hard).
// This bundle holds eight because the vault genuinely needs eight collaborators:
// two stores, three cryptographic ports, and the three kernel decoupling ports.
// Nothing here is a convenience — dropping the clock or the id generator would put
// `new Date()` and a random identifier back inside a use case, and with them the
// untestability the ADR's Clock and IdGenerator ports exist to remove.

import type { Clock, IdGenerator, UnitOfWork } from "@platos/kernel";

import type {
  AeadCipher,
  EnvironmentVariableRepository,
  Hasher,
  KeyRing,
  SecretsRepository,
} from "./ports/index.js";

export interface SecretsDependencies {
  readonly repository: SecretsRepository;
  readonly variables: EnvironmentVariableRepository;
  readonly keyRing: KeyRing;
  readonly cipher: AeadCipher;
  readonly hasher: Hasher;
  /** Time is an input. No use case here reads the wall clock. */
  readonly clock: Clock;
  /** Identity is an input. No use case here mints a random identifier. */
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
}
