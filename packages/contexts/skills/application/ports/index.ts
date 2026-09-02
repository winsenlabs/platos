// The driven ports of the `skills` context.
//
// Four, and the split between them is by TECHNOLOGY OWNER rather than by
// convenience: the canonical store, the network fetch, the environment-key
// directory, and the confined runtime. Each has exactly one adapter, each
// adapter is the sole holder of its client, and none of them is visible from
// `domain/`.
//
// This barrel is published as its own package entrypoint
// (`./application/ports/index.js`) because an adapter must import the interface
// it implements. ADR M0.3 §13 makes adapter-facing ports context-owned rather
// than kernel-hosted: they belong to the context whose capability they serve,
// and living under `packages/adapters/` does not move ownership.
//
// The context-FACING surface is `contracts/`, and these do not appear there. A
// peer context has no business holding this context's repository.
export * from "./skills-repository.js";
export * from "./skill-source-fetcher.js";
export * from "./environment-key-directory.js";
export * from "./skill-sandbox.js";
