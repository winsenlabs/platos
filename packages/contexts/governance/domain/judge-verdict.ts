// Reading the judge's answer.
//
// The judge is asked for `{"score": <number>, "rationale": "...", "passed":
// <boolean>}` and, being a language model, sometimes returns it inside a fenced
// block, sometimes inside prose, and sometimes not at all. The source accepts
// all three and falls back to a zero score with the raw text as the rationale
// rather than throwing, so a malformed answer is a low score with an audit trail
// instead of a lost eval. That behaviour is kept exactly.
//
// WHAT IS NOT KEPT: `Number(parsed.score ?? parsed.rating ?? 0)`. `Number(true)`
// is 1, so a judge answering `{"score": true}` scores 1 on the criterion's raw
// scale — normalised, a hair above the floor — and the eval reads as a real,
// very low score rather than as an unparseable answer. `Number([])` is 0 and
// `Number([7])` is 7, so an array answer scores too. Only a finite NUMBER, or a
// string that is entirely a finite number, is a score here; anything else takes
// the unparseable path, where it is visible.
//
// THE OUTPUT SAYS HOW IT WAS READ. `parsedFrom` distinguishes a judge that
// answered cleanly from one whose JSON had to be dug out of prose from one that
// never answered at all, and `clamped` says whether the score was outside the
// criterion's own scale. The source collapses all four into an indistinguishable
// number, which is why a criterion with a broken scale reads as a criterion
// every conversation fails.

import type { CriterionSnapshot } from "./criterion.js";

export type VerdictSource = "fenced-json" | "embedded-json" | "whole-body" | "unreadable";

export interface JudgeVerdict {
  /** Normalised to 0..100 against the criterion's own scale. */
  readonly score: number;
  readonly rationale: string | null;
  readonly passed: boolean;
  readonly parsedFrom: VerdictSource;
  /** True when the judge's raw score fell outside the criterion's scale. */
  readonly clamped: boolean;
}

const FENCE = /```(?:json)?\s*([\s\S]+?)\s*```/iu;
const OBJECT = /\{[\s\S]*\}/u;
/** The unreadable path keeps this much of the raw body as the rationale. */
export const UNREADABLE_RATIONALE_LENGTH = 2_000;

/**
 * Read one raw judge response against the criterion it was asked about.
 *
 * `passMarkPercent` applies only when the judge expressed no opinion of its own:
 * an explicit `"passed": false` on a high score is respected, because the
 * criterion's own rubric is what the judge was given and it is entitled to
 * disagree with a global threshold.
 */
export function readJudgeVerdict(
  raw: string,
  criterion: CriterionSnapshot,
  passMarkPercent: number,
): JudgeVerdict {
  const found = locate(raw);
  if (found === null) {
    return {
      score: 0,
      rationale: raw.slice(0, UNREADABLE_RATIONALE_LENGTH),
      passed: false,
      parsedFrom: "unreadable",
      clamped: false,
    };
  }
  const rawScore = readScore(found.body);
  if (rawScore === null) {
    return {
      score: 0,
      rationale: raw.slice(0, UNREADABLE_RATIONALE_LENGTH),
      passed: false,
      parsedFrom: "unreadable",
      clamped: false,
    };
  }
  const normalised = normalise(rawScore, criterion);
  const rationale = readRationale(found.body);
  const stated = found.body["passed"];
  return {
    score: normalised.score,
    rationale,
    passed: typeof stated === "boolean" ? stated : normalised.score >= passMarkPercent,
    parsedFrom: found.source,
    clamped: normalised.clamped,
  };
}

/**
 * Map a raw score onto 0..100.
 *
 * The non-positive-range branch answers 0 and is deliberately kept even though
 * `admitCriterion` refuses such a scale: this defends rows written before that
 * rule existed, and the two defences are independent on purpose.
 */
export function normalise(
  rawScore: number,
  criterion: CriterionSnapshot,
): { readonly score: number; readonly clamped: boolean } {
  const range = criterion.scoreScaleMax - criterion.scoreScaleMin;
  if (!(range > 0)) return { score: 0, clamped: false };
  const clampedScore = Math.max(criterion.scoreScaleMin, Math.min(criterion.scoreScaleMax, rawScore));
  return {
    score: ((clampedScore - criterion.scoreScaleMin) / range) * 100,
    clamped: clampedScore !== rawScore,
  };
}

type JsonRecord = Record<string, unknown>;

function locate(raw: string): { readonly body: JsonRecord; readonly source: VerdictSource } | null {
  const fenced = FENCE.exec(raw);
  const fromFence = fenced === null ? null : parseObject(fenced[1] ?? "");
  if (fromFence !== null) return { body: fromFence, source: "fenced-json" };
  const embedded = OBJECT.exec(raw);
  const fromEmbedded = embedded === null ? null : parseObject(embedded[0]);
  if (fromEmbedded !== null) return { body: fromEmbedded, source: "embedded-json" };
  const whole = parseObject(raw);
  if (whole !== null) return { body: whole, source: "whole-body" };
  return null;
}

function parseObject(text: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as JsonRecord;
  } catch {
    return null;
  }
}

/** A finite number, or a string that is entirely one. Nothing else. */
function readScore(body: JsonRecord): number | null {
  const candidate = body["score"] ?? body["rating"];
  if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readRationale(body: JsonRecord): string | null {
  for (const key of ["rationale", "reasoning", "explanation"]) {
    const value = body[key];
    if (typeof value === "string") return value;
  }
  return null;
}
