// What every use case in this context is constructed with.
//
// One frozen bundle rather than nine constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing in
// this package reaches for the wall clock or a random generator. That is what
// makes a use case that expires a cached liveness result, dates a price card, or
// mints a provider key reproducible at any instant.
//
// THE CATALOGUE IS AN INPUT TOO. `domain/catalogue.ts` ships the transcribed
// default and every rule takes it as a parameter, so an installation can extend
// the provider list without a code change and a test can exercise a rule against
// a two-provider catalogue instead of fourteen.
//
// ON `tenancy` AND `secrets`. ADR M0.3 §1 row 4 permits this context exactly
// these two peers plus the kernel, and BOTH handles are genuinely called, which
// is what distinguishes them from the opaque handle `files` holds:
//
//   `secrets` is called on every path that touches material — registering a key
//   creates a credential, rotating one rotates it, and resolving one at runtime
//   reads it. `providers` is the context that composes the vault's
//   `createCredential`/`rotateCredential` with its own ProviderKey write, which
//   is the hand-off `secrets/domain/credential.ts` records.
//
//   `tenancy` is held for the authorization seam in `authorization.ts` — the
//   grant it mints is what a control-surface use case verifies before it reads
//   or writes a row.

import type { Clock, IdGenerator, UnitOfWork } from "@platos/kernel";
import type { SecretsContract } from "@platos/context-secrets";
import type { TenancyContract } from "@platos/context-tenancy";

import type { ProviderCatalogue, ProvidersPolicy } from "../domain/index.js";
import type { ModelRouter, ProviderProbeCache, ProvidersRepository } from "./ports/index.js";

export interface ProvidersDependencies {
  readonly repository: ProvidersRepository;
  readonly modelRouter: ModelRouter;
  readonly probeCache: ProviderProbeCache;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly policy: ProvidersPolicy;
  readonly catalogue: ProviderCatalogue;
  readonly secrets: SecretsContract;
  readonly tenancy: TenancyContract;
}

export function providersDependencies(dependencies: ProvidersDependencies): ProvidersDependencies {
  return Object.freeze({ ...dependencies });
}
