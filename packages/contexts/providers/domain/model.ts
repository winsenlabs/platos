// `Model` — the global model identity this context is sole writer of.
//
// It is deliberately NOT tenant-scoped. A model is a fact about the world: what
// `anthropic:claude-haiku-4-5-20251001` is, how large its context window is, and
// what it can do are the same in every environment. What IS tenant-scoped is
// whether an environment may reach it, and that is `ProviderKey` and
// `EnvironmentProvider`, two different rows with two different lifetimes.
//
// Conflating them is the mistake this separation prevents: an environment
// unlinking a provider would otherwise delete model identities that a completed
// turn's cost record still refers to.
//
// `capabilities` IS AN OPEN LIST OF STRINGS, not an enum. A provider ships a new
// capability faster than a schema migration lands, and the alternative — dropping
// the ones we do not recognise — loses information that a picker could have shown.

import { err, ok, type Result } from "@platos/kernel";

import { modelKeyInvalid } from "./errors.js";
import { asProvidersIdentifier, type ModelId, type ModelKey, type ProviderId } from "./identifiers.js";

/** Longest `Model.key` this context will mint. The column itself is unbounded. */
export const MAX_MODEL_KEY_LENGTH = 512;

export interface Model {
  readonly modelId: ModelId;
  /** Unique across the installation. The catalogue's name for the model. */
  readonly key: ModelKey;
  readonly provider: ProviderId;
  /** Unique with `provider`. Equal to `key` for catalogue-sourced models. */
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly capabilities: readonly string[];
  readonly releaseDate: Date | null;
  readonly deprecationDate: Date | null;
  readonly baseModelName: string | null;
  /** Hidden models stay priceable but are not offered for selection. */
  readonly isHidden: boolean;
  /** When the upstream catalogue this row was read from was itself read. */
  readonly sourceUpdatedAt: Date;
}

/** The mutable half of a model identity, as one upsert supplies it. */
export type ModelFacts = Omit<Model, "modelId" | "key" | "isHidden">;

export function admitModelKey(value: string): Result<ModelKey> {
  const key = value.trim();
  if (key === "") return err(modelKeyInvalid("model key must not be empty"));
  if (key.length > MAX_MODEL_KEY_LENGTH) {
    return err(modelKeyInvalid(`model key must be at most ${MAX_MODEL_KEY_LENGTH} characters`));
  }
  if (key !== value) return err(modelKeyInvalid("model key must not carry leading or trailing whitespace"));
  return ok(asProvidersIdentifier<ModelKey>(key));
}

/** True when a model is offerable: known, not hidden, and not past its end date. */
export function isSelectable(model: Model, at: Date): boolean {
  if (model.isHidden) return false;
  return model.deprecationDate === null || model.deprecationDate.getTime() > at.getTime();
}

/**
 * Has anything about this model identity changed?
 *
 * `sourceUpdatedAt` is excluded on purpose: it moves on every catalogue pass
 * whether or not a fact did, so including it would report a change every time
 * the ingest ran and make the answer useless for deciding whether to write.
 */
export function sameModelFacts(stored: ModelFacts, candidate: ModelFacts): boolean {
  return (
    stored.provider === candidate.provider &&
    stored.name === candidate.name &&
    stored.displayName === candidate.displayName &&
    stored.description === candidate.description &&
    stored.contextWindow === candidate.contextWindow &&
    stored.maxOutputTokens === candidate.maxOutputTokens &&
    stored.baseModelName === candidate.baseModelName &&
    sameInstant(stored.releaseDate, candidate.releaseDate) &&
    sameInstant(stored.deprecationDate, candidate.deprecationDate) &&
    sameCapabilities(stored.capabilities, candidate.capabilities)
  );
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

/**
 * Capability order carries no meaning, so comparison is set-wise. Comparing
 * position would report a change every time the upstream reordered its flags.
 */
function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const held = new Set(left);
  return right.every((capability) => held.has(capability));
}
