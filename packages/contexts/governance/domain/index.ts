// The `governance` domain barrel.
//
// Pure domain. May import its own domain and `@platos/kernel` only (ADR M0.3
// §2). Nothing here reads a clock, a store, a network client or an environment
// variable: every rule in this package is a function of its arguments, which is
// what makes a safety vocabulary, a judge's verdict, a regression threshold and
// a risk band exercisable without infrastructure.

export * from "./agent-eval.js";
export * from "./criterion.js";
export * from "./errors.js";
export * from "./eval-aggregate.js";
export * from "./golden-set.js";
export * from "./identifiers.js";
export * from "./judge-model.js";
export * from "./judge-verdict.js";
export * from "./policy.js";
export * from "./rating.js";
export * from "./regression.js";
export * from "./risk.js";
export * from "./safety-event.js";
export * from "./safety-observation.js";
export * from "./safety-summary.js";
export * from "./satisfaction.js";
export * from "./window.js";
