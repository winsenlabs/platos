// The `skills` domain (ADR M0.3 §1, context 6).
//
// One aggregate and one binding pair, plus the pure rules that decide what a
// turn sees.
//
//   CatalogueEntry           the `Skill` row. ORGANIZATION-scoped, identified by
//                            (organization, slug, version) rather than by its
//                            uuid, so re-registering a manifest updates one row
//                            instead of accumulating rows.
//   ProjectInstallation      the `ProjectSkill` row — a project adopts a skill.
//   EnvironmentInstallation  the `EnvironmentSkill` row — one environment binds
//                            that adoption, with its own config.
//
// The catalogue and the installs sit at DIFFERENT LEVELS of the tenant tree, and
// almost every rule here follows from that: "which skills exist" is an
// organization question, "which skills are usable here" is an environment one,
// and `domain/visibility.ts` is the single place the two are reconciled.
//
// The manifest half of the context (`manifest*.ts`) is a parser over untrusted
// text that arrives from a URL an operator pasted. It takes no dependency, does
// no evaluation, and returns failures as values.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./policy.js";
export * from "./manifest.js";
export * from "./manifest-yaml.js";
export * from "./manifest-parse.js";
export * from "./catalogue.js";
export * from "./installation.js";
export * from "./visibility.js";
export * from "./category.js";
export * from "./tool-namespace.js";
export * from "./environment-readiness.js";
export * from "./prompt-composition.js";
export * from "./import-source.js";
