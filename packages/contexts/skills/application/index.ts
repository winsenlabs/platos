// The `skills` application layer.
//
// Use cases, one per file, each a plain function over a frozen dependency
// bundle. There is no service class and no framework: a use case is invokable in
// memory against the in-memory doubles in `application/testing/`, and every one
// of them returns the kernel's `Result` rather than throwing.
//
// May import this context's `domain/`, its own `application/ports/`, its own
// `contracts/`, and the published `contracts/` of the peer contexts ADR M0.3 §1
// permits — which for `skills` is `tenancy` and `files`.
export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./views.js";
export * from "./read-catalogue.js";
export * from "./register-skill.js";
export * from "./import-skill.js";
export * from "./install-skill.js";
export * from "./bind-skill.js";
export * from "./patch-skill.js";
export * from "./compose-runtime.js";
export * from "./run-skill-tool.js";
export * from "./seed-official-skills.js";
export * from "./skills-erasure-target.js";
export * from "./skills-contract.js";
