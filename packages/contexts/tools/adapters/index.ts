// The published surface of `tools`' own adapter directory — the barrel
// `apps/core-api` imports to fill the two driven ports no `packages/adapters/`
// directory may hold.
//
// WHY THIS DIRECTORY EXISTS AT ALL, in one paragraph. ADR M0.3 §5.1 rule (h)
// pins each vendor SDK to exactly one home, and for `@modelcontextprotocol/*`
// that home is `packages/contexts/tools/(adapters|transport)/` — see
// `SDK_CONTAINMENT.mcp-sdk-only-in-tools` in `scripts/arch/boundary-rules.mjs`.
// So `ToolDispatch`, which is an MCP client, cannot be a `packages/adapters/`
// directory and cannot be a row of `ADAPTER_BINDINGS`. It is `root-satisfied`:
// built in the composition root from a factory the owning context publishes,
// which is the shape `GOVERNANCE_ROOT_SATISFIED_PORTS` established for `Judge`.
// `ContentDigest` shares the barrel because the root imports one module per
// context, not because it needs containment.
//
// NOTHING ELSE LEAVES. There is no session handle, no client, no transport and no
// `Client` type in this barrel's surface: an install holds the two ports and a
// `close()`, and everything the SDK defines stays behind the boundary rule (h)
// exists to draw.
//
// `packages/contexts/tools/package.json` publishes this file as
// `./adapters/index.js`, and `ADAPTER_ENTRY_PROJECTS` in
// `scripts/arch/gen-v1-skeleton.mjs` is what put it there — with a check that
// joins to `SDK_CONTAINMENT` in both directions, so a context cannot gain an
// adapter barrel that no ADR rule sends it and cannot be denied one the ADR does.

export { createContentDigest } from "./content-digest.js";
export { createToolDispatchAdapter, type ToolDispatchAdapter } from "./dispatch.js";
