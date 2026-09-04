// The tunable limits, in one place, as data.
//
// Every value here is transcribed from the behaviour the live skill registry,
// importer and runtime already have. They are a POLICY VALUE passed into a use
// case, not a module constant read from the environment, because a limit read
// from the process environment inside a domain rule is untestable and is exactly
// the coupling ADR M0.3 §2 bans. It is also what lets a test drive the prompt
// budget to its exact boundary with a two-character ceiling instead of building
// sixteen thousand characters of prose.

export interface SkillImportPolicy {
  /** Ceiling on a fetched source, in bytes. */
  readonly maxSourceBytes: number;
  /** How long a fetch may take before it is abandoned. */
  readonly fetchTimeoutSeconds: number;
  /**
   * How many redirect hops may be followed. Every hop is re-checked against the
   * address rules, so this is a ceiling on work, not on trust.
   */
  readonly maxRedirects: number;
}

export interface SkillRuntimePolicy {
  /**
   * Ceiling on the merged skill prompt, in characters.
   *
   * Characters, not tokens: this layer has no tokenizer and acquiring one would
   * make a pure rule depend on a model's vocabulary. The live value is sized so
   * that the block stays around a few thousand tokens for any tokenizer.
   */
  readonly maxPromptChars: number;
}

export interface SkillCataloguePolicy {
  /** Ceiling on one page of a catalogue read. */
  readonly maxPageSize: number;
}

export interface SkillsPolicy {
  readonly import: SkillImportPolicy;
  readonly runtime: SkillRuntimePolicy;
  readonly catalogue: SkillCataloguePolicy;
}

const KIBIBYTE = 1024;

export const DEFAULT_SKILLS_POLICY: SkillsPolicy = Object.freeze({
  import: Object.freeze({
    maxSourceBytes: 256 * KIBIBYTE,
    fetchTimeoutSeconds: 10,
    maxRedirects: 3,
  }),
  runtime: Object.freeze({
    maxPromptChars: 16_000,
  }),
  catalogue: Object.freeze({
    maxPageSize: 100,
  }),
});
