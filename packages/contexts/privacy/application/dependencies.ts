// What every use case in this context is constructed with.
//
// One frozen bundle rather than nine constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing
// below reaches for the wall clock or a random generator. That is what makes a
// use case that expires a tombstone, backs a retry off, or takes a lease
// reproducible at any instant — and this context's rules are almost all about
// instants.
//
// `targets` IS THE GRAFT. ADR M0.3 §3 rejects both obvious shapes for
// right-to-erasure and hosts `ErasureTarget` in the kernel: each context
// implements it for the rows it is sole writer of, and the composition root
// injects the array HERE. It is `readonly ErasureTarget[]` and not a registry
// object on purpose — an array cannot be asked to discover a target, so this
// package can never grow a lookup that would need to know who exists.
//
// ON `tenancy`. ADR M0.3 §1 permits this context exactly two dependencies:
// `tenancy` and the kernel. The handle is held here as the OPAQUE contract type
// its owner publishes. `privacy` never re-derives a tenant scope: the resolved
// scopes arrive on the subjects the directory returned, and this handle is the
// declared edge along which a future re-validation would travel. It is
// deliberately not called from any rule in this package — a rule that depended
// on another context's runtime behaviour would not be exercisable in memory.

import type { Clock, ErasureTarget, IdGenerator, OutboxWriter, UnitOfWork } from "@platos/kernel";
import type { TenancyContract } from "@platos/context-tenancy";

import type { PrivacyPolicy } from "../domain/index.js";
import type {
  LegalHoldRegister,
  PrivacyRepository,
  SubjectDirectory,
  SubjectHasher,
} from "./ports/index.js";

export interface PrivacyDependencies {
  readonly repository: PrivacyRepository;
  readonly directory: SubjectDirectory;
  readonly hasher: SubjectHasher;
  readonly holds: LegalHoldRegister;
  /** Injected at the composition root, one per context that owns erasable rows. */
  readonly targets: readonly ErasureTarget[];
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly outbox: OutboxWriter;
  readonly policy: PrivacyPolicy;
  /** Opaque by design: see the note above. */
  readonly tenancy: TenancyContract;
}

export function privacyDependencies(dependencies: PrivacyDependencies): PrivacyDependencies {
  return Object.freeze({ ...dependencies });
}

/**
 * The targets to run, in a stable order, with the required roster folded in.
 *
 * Sorted by name rather than left in injection order: the composition root's
 * array order is an accident of module wiring, and an operation's outcome list
 * is an audit artefact that two passes must produce identically.
 *
 * A required name with no injected target is included as a name with no target,
 * so the caller records `PRIVACY_TARGET_NOT_WIRED` rather than skipping it. No
 * target wired is not the same as nothing to erase.
 */
export function resolveTargets(
  dependencies: PrivacyDependencies,
): readonly { readonly name: string; readonly target: ErasureTarget | null }[] {
  const byName = new Map<string, ErasureTarget>();
  for (const target of dependencies.targets) byName.set(target.targetName, target);
  const names = new Set<string>([...byName.keys(), ...dependencies.policy.erasure.requiredTargets]);
  return [...names].sort().map((name) => ({ name, target: byName.get(name) ?? null }));
}
