// What every use case in this context is constructed with.
//
// One frozen bundle rather than a dozen constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing in
// this package reaches for the wall clock or a random generator. That is what
// makes "the last thirty days", a rating's revision stamp and an eval's latency
// reproducible at any instant, and it is why every window in this package can be
// pinned to the millisecond instead of tolerated within a range.
//
// THE LOGGER IS NOT DECORATION. The kernel `SafetyEventSink` requires `record`
// not to throw and not to block the caller's decision, so a malformed
// observation cannot be reported to its producer. It is reported here instead.
// A sink that silently dropped events would be worse than no sink, so the drop
// is a logged, counted event — and `safety-event-sink.test.ts` asserts the log
// line, which is what makes "it was dropped, not lost" a tested claim.
//
// ON `tenancy` AND `agents`. ADR M0.3 §1 row 14 permits this context exactly
// these two peers plus the kernel, and both are genuinely called:
//
//   `tenancy` IS THE AUTHORIZATION SEAM. Every use case verifies the grant it
//   was handed through `authorization.ts` and takes the environment FROM that
//   grant rather than from an id the caller also supplied.
//
//   `agents` ANSWERS TWO QUESTIONS NOTHING ELSE CAN. Which version was live when
//   this conversation ran — the axis a canary is judged along — and which model
//   that version uses, which is the input to the no-self-evaluation invariant.
//   This context authors neither; it reads both through the published contract.
//
// AND THREE QUESTIONS ARE ASKED THROUGH INVERTED PORTS INSTEAD. Turn ownership,
// transcripts and per-agent activity belong to `conversations`, `tools` and
// `jobs`, none of which row 14 permits. `ports/read-seams.ts` records why those
// are ports rather than edges.

import type { Clock, IdGenerator, Logger, UnitOfWork } from "@platos/kernel";
import type { AgentsContract } from "@platos/context-agents";
import type { TenancyContract } from "@platos/context-tenancy";

import type { GovernancePolicy } from "../domain/index.js";
import type {
  ActivityReader,
  CriteriaRepository,
  EvalRunQueue,
  EvalsRepository,
  GoldenSetsRepository,
  Judge,
  RatingTargetReader,
  RatingsRepository,
  SafetyLedger,
  TranscriptReader,
} from "./ports/index.js";

export interface GovernanceDependencies {
  readonly safety: SafetyLedger;
  readonly ratings: RatingsRepository;
  readonly criteria: CriteriaRepository;
  readonly evals: EvalsRepository;
  readonly goldenSets: GoldenSetsRepository;
  readonly ratingTargets: RatingTargetReader;
  readonly transcripts: TranscriptReader;
  readonly activity: ActivityReader;
  readonly judge: Judge;
  readonly evalRuns: EvalRunQueue;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly logger: Logger;
  readonly policy: GovernancePolicy;
  readonly tenancy: TenancyContract;
  readonly agents: AgentsContract;
}

export function governanceDependencies(dependencies: GovernanceDependencies): GovernanceDependencies {
  return Object.freeze({ ...dependencies });
}
