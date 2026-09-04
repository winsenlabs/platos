// In-memory stand-ins for the three inverted read seams, the judge, and the
// durable eval-run queue.
//
// THE READ SEAMS ANSWER FROM SEEDED DATA AND NARROW BY ENVIRONMENT. A turn
// seeded in one environment is not visible from another, which is the property
// the rating path's cross-tenant test depends on: without it, "a turn in another
// environment is refused" would be testing an absent seed rather than a
// narrowing.
//
// THE JUDGE IS SCRIPTED AND COUNTS ITS CALLS. A judge that answered plausible
// JSON on every call would make the parser's failure paths unreachable, so this
// one is handed exact bodies — including malformed ones — and can be told to
// fail. The call count is what makes "the kill switch stops the judge being
// paid" a tested claim rather than an inferred one.
//
// THE QUEUE HONOURS ITS IDEMPOTENCY KEY, because a double that did not would
// make `alreadyQueued` unreachable and the double-click defence untested.

import { err, ok, asIdentifier, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  judgeUnavailable,
  ledgerUnavailable,
  type AgentId,
  type EndUserId,
  type EvalRunId,
  type ThreadId,
  type TranscriptTurn,
  type TurnId,
} from "../../domain/index.js";
import type {
  ActivityReader,
  AgentActivityCounts,
  EnqueuedEvalRun,
  EvalRunQueue,
  EvalRunRequest,
  Judge,
  JudgeAnswer,
  JudgeRequest,
  RatingTarget,
  RatingTargetReader,
  Transcript,
  TranscriptReader,
} from "../ports/index.js";

interface SeededTurn {
  readonly environmentId: string;
  readonly target: RatingTarget;
}

export class InMemoryRatingTargets implements RatingTargetReader {
  private readonly turns: SeededTurn[] = [];
  private failure: string | null = null;

  failNext(reason: string): void {
    this.failure = reason;
  }

  seed(scope: EnvironmentScope, target: RatingTarget): RatingTarget {
    this.turns.push({ environmentId: scope.environmentId, target });
    return target;
  }

  async find(scope: EnvironmentScope, turnId: TurnId): Promise<Result<RatingTarget | null>> {
    if (this.failure !== null) {
      const reason = this.failure;
      this.failure = null;
      return err(ledgerUnavailable(reason));
    }
    const held = this.turns.find(
      (turn) => turn.environmentId === scope.environmentId && turn.target.turnId === turnId,
    );
    return ok(held?.target ?? null);
  }
}

interface SeededThread {
  readonly environmentId: string;
  readonly transcript: Transcript;
}

export class InMemoryTranscripts implements TranscriptReader {
  private readonly threads: SeededThread[] = [];
  private failure: string | null = null;
  /** Every `[threadId, turnId]` pair this double was asked for, in order. */
  readonly reads: { readonly threadId: string; readonly turnId: string | null }[] = [];

  failNext(reason: string): void {
    this.failure = reason;
  }

  seed(
    scope: EnvironmentScope,
    threadId: ThreadId,
    agentId: AgentId,
    turns: readonly TranscriptTurn[],
  ): Transcript {
    const transcript: Transcript = { threadId, agentId, turns };
    this.threads.push({ environmentId: scope.environmentId, transcript });
    return transcript;
  }

  async read(
    scope: EnvironmentScope,
    threadId: ThreadId,
    turnId: TurnId | null,
  ): Promise<Result<Transcript | null>> {
    this.reads.push({ threadId, turnId });
    if (this.failure !== null) {
      const reason = this.failure;
      this.failure = null;
      return err(ledgerUnavailable(reason));
    }
    const held = this.threads.find(
      (thread) => thread.environmentId === scope.environmentId && thread.transcript.threadId === threadId,
    );
    if (held === undefined) return ok(null);
    if (turnId === null) return ok(held.transcript);
    return ok({
      ...held.transcript,
      turns: held.transcript.turns.filter((turn) => turn.turnId === turnId),
    });
  }
}

export class InMemoryActivity implements ActivityReader {
  private readonly counts = new Map<string, AgentActivityCounts[]>();
  private failing: string | null = null;

  /** Make EVERY subsequent call fail. Models a reader that is simply gone. */
  failEverything(reason: string | null): void {
    this.failing = reason;
  }

  seed(scope: EnvironmentScope, counts: AgentActivityCounts): void {
    const held = this.counts.get(scope.environmentId) ?? [];
    held.push(counts);
    this.counts.set(scope.environmentId, held);
  }

  async countByAgent(
    scope: EnvironmentScope,
    _since: Date,
  ): Promise<Result<readonly AgentActivityCounts[]>> {
    if (this.failing !== null) return err(ledgerUnavailable(this.failing));
    return ok(this.counts.get(scope.environmentId) ?? []);
  }
}

export class ScriptedJudge implements Judge {
  private readonly bodies: string[] = [];
  private failure: string | null = null;
  /** Every request this judge was handed, in order. */
  readonly asked: JudgeRequest[] = [];
  costCents: number | null = 12;

  /** Queue one raw answer. Exhausting the queue repeats the last one. */
  answer(text: string): void {
    this.bodies.push(text);
  }

  /** Discard whatever was queued and answer only this, from now on. */
  only(text: string): void {
    this.bodies.length = 0;
    this.bodies.push(text);
  }

  /** Make the NEXT ask fail, once. */
  failNext(reason: string): void {
    this.failure = reason;
  }

  async ask(request: JudgeRequest): Promise<Result<JudgeAnswer>> {
    this.asked.push(request);
    if (this.failure !== null) {
      const reason = this.failure;
      this.failure = null;
      return err(judgeUnavailable(reason));
    }
    const text = this.bodies.length > 1 ? (this.bodies.shift() as string) : this.bodies[0] ?? "{}";
    return ok({
      text,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        reasoningTokens: null,
      },
      costCents: this.costCents,
    });
  }
}

export class InMemoryEvalRunQueue implements EvalRunQueue {
  private readonly accepted = new Map<string, EvalRunId>();
  private counter = 0;
  private failure: string | null = null;
  readonly requests: EvalRunRequest[] = [];

  failNext(reason: string): void {
    this.failure = reason;
  }

  async enqueue(request: EvalRunRequest): Promise<Result<EnqueuedEvalRun>> {
    this.requests.push(request);
    if (this.failure !== null) {
      const reason = this.failure;
      this.failure = null;
      return err(ledgerUnavailable(reason));
    }
    const held = this.accepted.get(request.idempotencyKey);
    if (held !== undefined) {
      return ok({ runId: held, pairCount: request.pairs.length, alreadyQueued: true });
    }
    this.counter += 1;
    const runId = asIdentifier<EvalRunId>(`run-${String(this.counter).padStart(4, "0")}`);
    this.accepted.set(request.idempotencyKey, runId);
    return ok({ runId, pairCount: request.pairs.length, alreadyQueued: false });
  }
}

/** The end-user id every fixture's seeded turn belongs to. */
export const FIXTURE_END_USER = asIdentifier<EndUserId>("end-user-1");
