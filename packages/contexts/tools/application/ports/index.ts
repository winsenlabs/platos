// Driven ports this context needs, and the adapter-facing port it OWNS.
//
// `ToolDispatch` is published from here rather than from the kernel: it is
// adapter-facing, not context-facing (ADR M0.3 §13), and it is the boundary
// that makes §5.1 rule (h) — `@modelcontextprotocol/*` in exactly one directory
// — enforceable rather than aspirational. `ToolsRepository` is the
// canonical-store port behind which this context's sole-writer ownership of its
// ten rows is realised. `ContentDigest` is the one primitive two domain rules
// end in and neither may take.
//
// Implemented under `packages/adapters/*` and this context's own `adapters/`,
// wired in `apps/core-api`, never imported by `domain/` (ADR M0.3 §2).
export * from "./tools-repository.js";
export * from "./tool-dispatch.js";
export * from "./content-digest.js";
