// Every ceiling, budget and kill switch this context enforces, in one value.
//
// WHY IT IS A VALUE AND NOT A CONSTANT. The extraction source reads
// `process.env.PLATOS_MAX_JOBS_PER_TURN`, `PLATOS_MAX_CHILDREN_PER_TURN`,
// `PLATOS_TURN_MAX_MS`, `PLATOS_MAX_ATTACHMENT_BYTES` and a dozen more from
// inside the methods that enforce them, which puts the environment in the middle
// of the turn engine and makes every ceiling untestable without setting a
// variable. Here the composition root reads the environment once and hands the
// finished policy in, so a test pins a ceiling by passing a number and the
// domain never names a variable at all.
//
// THE NUMBERS BELOW ARE THE RUNNING SYSTEM'S, TRANSCRIBED. Where the source has
// a default, it is the default here, cited at the field. Where it has no ceiling
// at all, one is introduced and SAID SO rather than quietly adopted — there are
// two, `maxStepsPerTurn` and `maxThreadPageSize`, and both are named below.
//
// A KILL SWITCH IS A BOOLEAN, NOT AN ABSENT COLLABORATOR. The source disables
// two thirds of its features by leaving an optional Nest dependency uninjected,
// so "the feature is off" and "the wiring is broken" are the same state and
// neither is visible. `turnsEnabled` and `subAgentsEnabled` are the two switches
// this context genuinely owns, and each has its own refusal code.

export interface ThreadPolicy {
  /** Source: `MAX_TAGS_PER_THREAD = 20` (memory/conversation.service.ts). */
  readonly maxTags: number;
  /** Source: `MAX_TAG_LENGTH = 50`. */
  readonly maxTagLength: number;
  /** Source: the auto-namer truncates a generated title to 100 characters. */
  readonly maxTitleLength: number;
  /** Source: no ceiling exists. Introduced here; a prompt carries this object. */
  readonly maxSessionContextBytes: number;
  /** Source: `if (forkCount >= 10) throw new ThreadForkLimitError()`. */
  readonly maxForksPerThread: number;
  /** Source: none. Introduced here; forks of forks are otherwise unbounded. */
  readonly maxForkDepth: number;
  /** Source: `Math.max(1, Math.min(limit ?? 50, 500))` on the messages page. */
  readonly maxPageSize: number;
}

export interface TurnPolicy {
  /** The kill switch. False refuses every turn with its own code. */
  readonly turnsEnabled: boolean;
  /**
   * Source: NONE. `stopWhen: isStepCount(agentConfig.maxSteps)` takes whatever
   * the agent version row says, with no upper clamp anywhere in the source. A
   * version row with `maxSteps: 100000` is an unbounded provider bill, so a
   * ceiling is introduced here and the agent's own number is clamped to it.
   */
  readonly maxStepsPerTurn: number;
  /** Source: the agent-version default, `maxSteps: 20`. */
  readonly defaultStepsPerTurn: number;
  /** Source: none. Introduced; a thread that never settles grows without end. */
  readonly maxTurnsPerThread: number;
  /** Source: none at this layer. Introduced; the prompt has to be built. */
  readonly maxInputBytes: number;
  /** Source: `Math.max(30_000, PLATOS_TURN_MAX_MS ?? 300_000)`. */
  readonly turnDeadlineMs: number;
  /** Source: the tool catalogue is unbounded. Introduced; every tool is prompt. */
  readonly maxToolsPerTurn: number;
}

export interface SubAgentPolicy {
  /** The second kill switch: delegation off, ordinary turns still running. */
  readonly subAgentsEnabled: boolean;
  /** Source: `SUBAGENT_MAX_DEPTH = 2`. */
  readonly maxDepth: number;
  /** Source: `SUBAGENT_DEFAULT_CHILDREN_PER_TURN = 5`. */
  readonly maxFanOut: number;
  /** Source: `Math.max(1, Math.min(20, spec.maxTurns ?? 6))`. */
  readonly maxStepsPerSubAgent: number;
}

export interface AttachmentPolicy {
  /** Source: `PLATOS_MAX_ATTACHMENT_BYTES ?? 20 * 1024 * 1024`. */
  readonly maxBytesPerAttachment: number;
  /** Source: `PLATOS_MAX_TURN_ATTACHMENT_TOTAL_BYTES ?? 80 * 1024 * 1024`. */
  readonly maxBytesPerTurn: number;
  /** Source: none. Introduced; the byte ceilings do not bound the COUNT. */
  readonly maxAttachmentsPerTurn: number;
  /**
   * The media types a prompt content part can carry.
   *
   * `providers`' vocabulary has an `ImagePart` and a catch-all `FilePart`, so
   * this list is about what the MODEL can be given rather than what the store
   * can hold: a type outside it is refused with its own code instead of being
   * silently dropped from the prompt, which is what the source does.
   */
  readonly promptableMediaTypePrefixes: readonly string[];
}

export interface CompactionPolicy {
  /** Source: `"Keep under 500 words."` in the compaction instruction. */
  readonly maxSummaryLength: number;
  /** Source: `if (toCompact.length < 5) return` — nothing under five is worth it. */
  readonly minTurnsToCompact: number;
}

export interface ConversationsPolicy {
  readonly thread: ThreadPolicy;
  readonly turn: TurnPolicy;
  readonly subAgent: SubAgentPolicy;
  readonly attachment: AttachmentPolicy;
  readonly compaction: CompactionPolicy;
}

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;

export const DEFAULT_CONVERSATIONS_POLICY: ConversationsPolicy = Object.freeze({
  thread: Object.freeze({
    maxTags: 20,
    maxTagLength: 50,
    maxTitleLength: 100,
    maxSessionContextBytes: 64 * KIBIBYTE,
    maxForksPerThread: 10,
    maxForkDepth: 5,
    maxPageSize: 500,
  }),
  turn: Object.freeze({
    turnsEnabled: true,
    maxStepsPerTurn: 64,
    defaultStepsPerTurn: 20,
    maxTurnsPerThread: 10_000,
    maxInputBytes: MEBIBYTE,
    turnDeadlineMs: 300_000,
    maxToolsPerTurn: 256,
  }),
  subAgent: Object.freeze({
    subAgentsEnabled: true,
    maxDepth: 2,
    maxFanOut: 5,
    maxStepsPerSubAgent: 20,
  }),
  attachment: Object.freeze({
    maxBytesPerAttachment: 20 * MEBIBYTE,
    maxBytesPerTurn: 80 * MEBIBYTE,
    maxAttachmentsPerTurn: 16,
    promptableMediaTypePrefixes: Object.freeze(["image/", "application/pdf", "text/"]),
  }),
  compaction: Object.freeze({
    maxSummaryLength: 4_000,
    minTurnsToCompact: 5,
  }),
});
