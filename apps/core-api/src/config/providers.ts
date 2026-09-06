// The PROVIDERS section — how this process talks to a model, not WHICH KEY it
// talks with.
//
// THE ONE DECISION THIS FILE MAKES, AND WHY IT IS THE INTERESTING ONE. There is
// no `OPENAI_API_KEY` here and no `ANTHROPIC_API_KEY`, and their absence is the
// design rather than an omission to fill in later. ADR M0.3 §1 makes `providers`
// the context that owns provider credentials, and they are per-ORGANISATION rows
// in its canonical store, encrypted under the security section's root key. A
// process-level variable holding one would be a second copy of a tenant-scoped
// secret at a scope that has no tenant — every organisation on the install would
// share it, the cost ledger would attribute its spend to nobody, and revoking it
// would be a redeploy rather than a row update.
//
// The legacy compose stack does pass `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` to
// the agent process. That is the shape M2 is extracting away from, and naming
// them here would carry it forward into the surface built to replace it.
//
// WHAT DOES BELONG AT PROCESS SCOPE is everything about the CALL rather than the
// caller: which model an install falls back to when no agent names one, how long
// this process is willing to wait, and how many times it retries. Those are the
// same for every organisation because they are properties of this deployable's
// latency budget, not of anyone's account.

import type { ConfigFieldSpec, ConfigSectionSpec } from "./schema.js";
import type { GroupPresence, SectionReader } from "./stores.js";

const defaultModel: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_PROVIDERS_DEFAULT_MODEL",
  kind: "string",
  required: false,
  defaultValue: null,
  secret: false,
  describe: "the vendor-qualified model used when nothing else names one",
  // `vendor:model`, both halves non-empty. The compose stack's
  // `anthropic:claude-haiku-4-5-20251001` is the shape. An unqualified model
  // name is the failure this catches: the router cannot decide which vendor to
  // ask, and the first turn of the first conversation is where it would say so.
  pattern: "[a-z0-9][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._-]*",
  patternDescribe: "a vendor-qualified model, in the form vendor:model",
  minimumLength: 3,
});

export const PROVIDERS_SECTION: ConfigSectionSpec = Object.freeze({
  id: "providers",
  describe: "how this process calls a model provider",
  groups: Object.freeze([
    Object.freeze({
      id: "modelRouter",
      describe: "the model router's process-scoped call settings",
      anchor: defaultModel,
      requiredWithAnchor: Object.freeze([]),
      optional: Object.freeze([
        Object.freeze({
          name: "PLATOS_PROVIDERS_REQUEST_TIMEOUT_MS",
          kind: "integer",
          required: false,
          // Two minutes. Long enough for a reasoning model's first token, short
          // enough that a hung upstream cannot hold a worker past the 300000ms
          // turn budget the legacy stack sets.
          defaultValue: "120000",
          secret: false,
          describe: "how long one provider call may take before it is abandoned",
          minimum: 1000,
          maximum: 600000,
        }),
        Object.freeze({
          name: "PLATOS_PROVIDERS_MAX_RETRIES",
          kind: "integer",
          required: false,
          defaultValue: "2",
          secret: false,
          // Zero is meaningful and is why the minimum is 0 rather than 1: an
          // install that meters spend per call may want no retry at all, and
          // "retries disabled" must be expressible without a second flag.
          describe: "how many times a failed provider call is retried; 0 disables retrying",
          minimum: 0,
          maximum: 10,
        }),
        Object.freeze({
          name: "PLATOS_PROVIDERS_EMBEDDING_MODEL",
          kind: "string",
          required: false,
          defaultValue: null,
          secret: false,
          describe: "the vendor-qualified embedding model; omit to leave embedding unwired",
          pattern: "[a-z0-9][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._-]*",
          patternDescribe: "a vendor-qualified model, in the form vendor:model",
          minimumLength: 3,
        }),
      ]),
    }),
  ]),
});

export interface ModelRouterConfiguration {
  readonly defaultModel: string;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  /** Null when this install did not name one; embedding stays unwired. */
  readonly embeddingModel: string | null;
}

export interface ProvidersConfiguration {
  readonly modelRouter: ModelRouterConfiguration | null;
}

export function assembleProviders(read: SectionReader, declared: GroupPresence): ProvidersConfiguration {
  return Object.freeze({
    modelRouter: !declared("modelRouter")
      ? null
      : Object.freeze({
          defaultModel: read("PLATOS_PROVIDERS_DEFAULT_MODEL") ?? "",
          requestTimeoutMs: Number(read("PLATOS_PROVIDERS_REQUEST_TIMEOUT_MS")),
          maxRetries: Number(read("PLATOS_PROVIDERS_MAX_RETRIES")),
          embeddingModel: read("PLATOS_PROVIDERS_EMBEDDING_MODEL"),
        }),
  });
}
