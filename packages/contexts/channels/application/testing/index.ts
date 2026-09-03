// In-memory doubles and builders for this context.
//
// Published from `application/testing/` rather than a separate package so a test
// imports the same module graph the code does. These are exercised by the
// package's own suites and are not part of the published `contracts/` surface —
// nothing outside this context may reach them.
export * from "./fixtures.js";
export * from "./builders.js";
export * from "./in-memory-adapters.js";
export * from "./in-memory-channels-repository.js";
