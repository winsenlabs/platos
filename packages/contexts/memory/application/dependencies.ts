// What every use case in this context is constructed with.
//
// One frozen bundle rather than ten constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing in
// this package reaches for the wall clock or a random generator. That is what
// makes a use case that throttles a profile synthesis, stamps a recall, or
// quarantines a memory on feedback reproducible at any instant.
//
// THE POLICY IS AN INPUT TOO. `domain/policy.ts` ships the transcribed default
// and every rule takes it as a parameter, so an installation can widen a page
// ceiling or lower an injection threshold without a code change and a test can
// exercise a rule against a two-row page instead of fifty.
//
// ON `tenancy` AND `providers`. ADR M0.3 §1 row 8 permits this context exactly
// these two peers plus the kernel, and BOTH handles are genuinely called:
//
//   `tenancy` is the authorization seam (`authorization.ts`). Every control
//   surface here verifies an operator grant through it before it reads or writes
//   a row, and the environment a use case works in is taken FROM that grant
//   rather than from an id the caller also supplied.
//
//   `providers` prices the extraction judge. A sweep is billable work no turn
//   asked for; the running system prices it against the model's rate card and
//   attributes the result, and `providers.priceModelUsage` is the published
//   surface that does it. The priced amount travels on the extraction report so
//   the composition root can attribute it to a budget — this context writes no
//   ledger row, because it owns none.

import type { Clock, IdGenerator, UnitOfWork } from "@platos/kernel";
import type { ProvidersContract } from "@platos/context-providers";
import type { TenancyContract } from "@platos/context-tenancy";

import type { MemoryPolicy } from "../domain/index.js";
import type {
  Cache,
  ContentDigest,
  EmbeddingModel,
  ExtractionJudge,
  KnowledgeGraphRepository,
  MemoryRepository,
} from "./ports/index.js";

export interface MemoryDependencies {
  readonly repository: MemoryRepository;
  readonly graph: KnowledgeGraphRepository;
  readonly cache: Cache;
  readonly embeddings: EmbeddingModel;
  readonly judge: ExtractionJudge;
  readonly digest: ContentDigest;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly policy: MemoryPolicy;
  readonly tenancy: TenancyContract;
  readonly providers: ProvidersContract;
}

export function memoryDependencies(dependencies: MemoryDependencies): MemoryDependencies {
  return Object.freeze({ ...dependencies });
}
