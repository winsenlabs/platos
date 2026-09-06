export * from "../generated/control";
export * from "./access-key";
export * from "./auth";
export { createEndUserClient, type EndUserClient } from "./end-user";
export * from "./environment-variables";
export * from "./json";
export * from "./memory-contract";
export * from "./model-pricing";
export * from "./secrets";
export * from "./source-model-manifest";
export * from "./tool-policy";
// WIN-258 T7 — THE UPGRADE REHEARSAL SURFACE IS DELIBERATELY NOT HERE.
// `packages/adapters/postgres-tenancy` runs the store half of the expand/contract
// rehearsal and needs the same frozen-baseline bootstrap and the same rebuilt
// old-binary clients this package uses, so it imports them by module path —
// `@platos/tenancy-database/dist/upgrade-baseline-clients.js` and its two
// siblings — rather than through this barrel.
//
// THE REASON IS THE BROWSER BUNDLE, AND IT IS A MEASURED ONE. Those modules
// `spawnSync` the Prisma CLI and read the migrations directory, so they import
// `node:child_process`, `node:fs` and `node:url` at the top level. Every route
// module in `apps/webapp` that names an enum from this package — `ProjectRole`,
// `OrganizationRole`, `EnvironmentVariableKind` — pulls this barrel into the
// Remix BROWSER build, and re-exporting them here failed that build outright:
// `Node builtin "node:child_process" (imported by
// "../../internal-packages/tenancy-database/dist/upgrade-rehearsal-support.js")
// must be polyfilled for the browser`. This package has no `exports` map on
// purpose — `apps/agent` deep-imports `generated/control/runtime/library` and
// adding one would refuse that — so the module path is what keeps a Node-only
// surface out of a browser bundle.
