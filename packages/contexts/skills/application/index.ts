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
//
// WHY THE FIXTURES ARE PUBLISHED FROM HERE (WIN-258 T5). `application/testing/`
// holds `InMemorySkillsRepository`, whose own header says it "is a REAL
// implementation of the port's contract" and "enforces the two properties a
// Postgres implementation would enforce with constraints". That claim is only
// worth anything if somebody checks it, and the only package that can is the one
// that implements the same port against PostgreSQL:
// `packages/adapters/postgres-tenancy` runs ONE conformance scenario against the
// double and against a real database and compares the two observation lists
// verbatim. Re-exporting the double here is what lets it name the double at all,
// and it hands the adapter the SAME fixtures every use case in this package is
// already written against rather than a second set that could drift from them.
// The precedent is `tenancy`, `agents` and `secrets`, whose `application/index.ts`
// publish their fakes for exactly this reason.
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
export * from "./testing/index.js";
