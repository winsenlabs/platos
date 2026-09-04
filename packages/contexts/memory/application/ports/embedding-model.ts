// The `EmbeddingModel` and `ExtractionJudge` ports — the two model seams this
// context needs, and the reason they are OWNED HERE rather than by `providers`.
//
// `providers` is the sole holder of provider SDKs behind `ModelRouter` (ADR M0.3
// §1 row 4), and nothing below changes that: neither interface names a vendor, a
// model string, a key or a client, and an adapter implementing either one is a
// composition over `providers` — it resolves a route and opens a session through
// that context's own port, so the SDK still lives in exactly one directory and
// §5.1(h) still binds.
//
// WHAT IS OWNED HERE IS THE SHAPE OF THE ANSWER, AND IT IS THIS CONTEXT'S
// VOCABULARY IN BOTH CASES.
//
//   An embedding is a vector of a FIXED WIDTH, because `Memory.embedding` and
//   `MemoryEntity.embedding` are declared `vector(1536)` and a vector of another
//   width cannot be stored, let alone compared. That width is a fact about this
//   context's columns, not about any provider, so the port states it and
//   `admitEmbedding` enforces it before a row is ever built.
//
//   A judge's answer is an ENVELOPE OF CANDIDATE MEMORIES, ENTITIES AND
//   RELATIONSHIPS. Those three words are this context's aggregates. A port that
//   returned "text" would push the envelope's shape into an adapter, where the
//   parse could not be tested against the kind rules it has to satisfy — so the
//   port returns the raw answer AND its token usage, and `parseJudgeEnvelope`
//   reads it here, in the domain, against those rules.
//
// TOKEN USAGE COMES BACK BECAUSE THE SPEND IS THIS CONTEXT'S. An extraction
// sweep is billable work that no turn asked for, and the running system prices
// it and attributes it. `providers.priceModelUsage` is what does the pricing
// (ADR M0.3 §1 row 8 permits `providers`), and it needs the counts — so they
// travel back with the answer rather than being discovered from a log later.

import type { Result } from "@platos/kernel";

import type { ExtractionPolicy } from "../../domain/index.js";

/** The width `Memory.embedding` and `MemoryEntity.embedding` are declared at. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Reject a vector that cannot be stored, before a row is built around it.
 *
 * Width first, then finiteness. A `NaN` component makes every distance
 * computation involving the row return `NaN`, which sorts unpredictably rather
 * than failing — so it is refused at the boundary where it is still attributable
 * to the call that produced it.
 */
export function isStorableEmbedding(vector: readonly number[]): boolean {
  if (vector.length !== EMBEDDING_DIMENSIONS) return false;
  return vector.every((component) => Number.isFinite(component));
}

export interface EmbeddingModel {
  /**
   * Embed one piece of text for storage or for a query.
   *
   * There is deliberately no batch method. The two call sites embed exactly one
   * string — a memory being written, or a query being run — and a batch API
   * whose only caller passes a single element is an interface shaped for a
   * client rather than for its use.
   */
  embed(text: string): Promise<Result<readonly number[]>>;
}

/** What one model call cost, in the counts `providers` prices from. */
export interface JudgeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cache reads, when the provider reported any. Priced at a different rate. */
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly reasoningTokens: number;
}

export const NO_JUDGE_USAGE: JudgeUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningTokens: 0,
});

export interface JudgeAnswer {
  /** The model's raw answer. Parsed by `parseJudgeEnvelope`, never by an adapter. */
  readonly text: string;
  readonly usage: JudgeUsage;
  /** Which model answered, so the spend can be priced and attributed. */
  readonly model: string;
}

export interface ExtractionJudge {
  /**
   * Read a transcript and propose memories, entities and relationships.
   *
   * The policy travels so the judge can be told the kinds and the cap it is
   * working to. It is ADVISORY at this boundary — `selectCandidates` applies the
   * same policy again to whatever comes back — because a model instructed to
   * emit at most ten will sometimes emit eleven, and the cap has to hold.
   */
  extract(transcript: string, policy: ExtractionPolicy): Promise<Result<JudgeAnswer>>;

  /**
   * Write the maintained narrative profile from a subject's atoms.
   *
   * A second method rather than a parameter on the first: the two calls have
   * different inputs, different instructions and different outputs, and a single
   * `generate(prompt)` would put this context's two prompts into an adapter
   * where neither could be exercised against the rules it has to satisfy.
   */
  synthesize(atoms: string): Promise<Result<JudgeAnswer>>;
}
