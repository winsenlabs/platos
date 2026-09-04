// What every use case in this context is constructed with.
//
// One frozen bundle rather than eight constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing
// below reaches for the wall clock or a random generator. That is what makes a
// use case that stamps a row, orders a catalogue or measures a run reproducible
// at any instant.
//
// ON `tenancy` AND `files`. ADR M0.3 §1 permits this context exactly three
// dependencies: `tenancy`, `files` and the kernel. Both handles are held here as
// the OPAQUE contract types their owners publish.
//
//   `tenancy` — `skills` never re-derives a tenant scope. The resolved
//     `EnvironmentScope` arrives on the command, having been established by the
//     context that owns the tree.
//
//   `files` — the declared edge along which a skill's bundled assets would be
//     read. It is not called from any rule in this package today.
//
// Neither is invoked from a rule here, deliberately: a rule that depended on
// another context's runtime behaviour would not be exercisable in memory. They
// are declared because §1 declares them, and because the DAG edge is checked
// against this manifest.

import type { Clock, IdGenerator, UnitOfWork } from "@platos/kernel";
import type { FilesContract } from "@platos/context-files";
import type { TenancyContract } from "@platos/context-tenancy";

import type { SkillsPolicy } from "../domain/index.js";
import type {
  EnvironmentKeyDirectory,
  SkillSandbox,
  SkillSourceFetcher,
  SkillsRepository,
} from "./ports/index.js";

export interface SkillsDependencies {
  readonly repository: SkillsRepository;
  readonly sourceFetcher: SkillSourceFetcher;
  readonly environmentKeys: EnvironmentKeyDirectory;
  readonly sandbox: SkillSandbox;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly policy: SkillsPolicy;
  /** Opaque by design: see the note above. */
  readonly tenancy: TenancyContract;
  /** Opaque by design: see the note above. */
  readonly files: FilesContract;
}

export function skillsDependencies(dependencies: SkillsDependencies): SkillsDependencies {
  return Object.freeze({ ...dependencies });
}
