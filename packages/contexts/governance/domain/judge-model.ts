// The judge model specification, and the no-self-evaluation invariant.
//
// A model specification is `<provider>:<model>`; a bare `<model>` means the
// default provider. That is the source's format, and two of its three readers of
// that format are wrong in ways that are individually silent.
//
// FIRST DEFECT, FIXED: `colonIdx > 0 ? slice(0, colonIdx) : "anthropic"` treats
// a LEADING colon as "no provider segment", so `":gpt-4o"` resolves to provider
// `anthropic` and model `":gpt-4o"` — a model name that begins with a colon,
// handed to the wrong vendor's client. A leading colon is refused here, with the
// same reasoning that made `agents` refuse it in `model-route.ts`.
//
// SECOND DEFECT, FIXED, AND IT IS THE SECURITY-RELEVANT ONE: the invariant
// "the judge model MUST NOT be the model that produced the conversation being
// scored" is enforced in the source by `judgeModelString === agentModel`, a
// STRING comparison between a value that is conventionally prefixed and a value
// that often is not. An agent whose model column reads
// `claude-haiku-4-5-20251001` and a criterion whose judge reads
// `anthropic:claude-haiku-4-5-20251001` are the same model and that comparison
// says they differ, so the guard passes and the model grades its own homework —
// the exact thing the invariant exists to prevent, failing open. Here both sides
// are PARSED and the comparison is on the resolved pair, so the prefixed and
// unprefixed spellings of one model are one model.
//
// THE PROVIDER SET IS CLOSED. The source's resolver throws on an unknown
// provider deep inside the call, after the criterion has been loaded and the
// transcript assembled. It is refused up front here, with its own code, because
// a spelling mistake in a criterion should not cost a transcript read.

import { err, ok, type Result } from "@platos/kernel";

import { evalSelfJudged, judgeModelInvalid } from "./errors.js";

/** The providers a judge adapter can be asked for. */
export const JUDGE_PROVIDERS = ["anthropic", "openai", "google"] as const;

export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];

/** The provider a bare `<model>` resolves to. The source's own default. */
export const DEFAULT_JUDGE_PROVIDER: JudgeProvider = "anthropic";

export interface JudgeModel {
  readonly provider: JudgeProvider;
  readonly model: string;
  /** The canonical `<provider>:<model>` form, whatever spelling arrived. */
  readonly spec: string;
}

export function isJudgeProvider(value: string): value is JudgeProvider {
  return (JUDGE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Parse a model specification.
 *
 * A specification with more than one colon keeps everything after the FIRST as
 * the model name — vendor model ids contain colons — while a specification that
 * BEGINS with one is refused rather than reinterpreted.
 */
export function parseJudgeModel(spec: string): Result<JudgeModel> {
  const trimmed = (spec ?? "").trim();
  if (trimmed === "") return err(judgeModelInvalid(spec ?? "", "blank"));
  const colon = trimmed.indexOf(":");
  if (colon === 0) return err(judgeModelInvalid(trimmed, "leading-separator"));
  if (colon < 0) {
    return ok({ provider: DEFAULT_JUDGE_PROVIDER, model: trimmed, spec: `${DEFAULT_JUDGE_PROVIDER}:${trimmed}` });
  }
  const provider = trimmed.slice(0, colon);
  const model = trimmed.slice(colon + 1).trim();
  if (model === "") return err(judgeModelInvalid(trimmed, "empty-model"));
  if (!isJudgeProvider(provider)) return err(judgeModelInvalid(trimmed, "unsupported-provider"));
  return ok({ provider, model, spec: `${provider}:${model}` });
}

/**
 * The no-self-evaluation invariant, on the RESOLVED pair.
 *
 * The agent's model is parsed with the same rules, so an agent configured
 * without a provider prefix is still recognised as the judge it matches. An
 * agent model this parser cannot read is NOT a licence to proceed: it is refused
 * as an invalid judge comparison, because "we could not tell whether this is
 * self-evaluation" must never resolve to "carry on".
 */
export function requireDistinctJudge(judge: JudgeModel, agentModel: string): Result<JudgeModel> {
  const agent = parseJudgeModel(agentModel);
  if (!agent.ok) return err(judgeModelInvalid(agentModel, "agent-model-unreadable"));
  if (agent.value.provider === judge.provider && agent.value.model === judge.model) {
    return err(evalSelfJudged(judge.spec, agent.value.spec));
  }
  return ok(judge);
}
