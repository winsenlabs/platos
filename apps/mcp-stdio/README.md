# @platos/mcp-stdio

ADR M0.3 §4: a thin stdio binary. It owns no business logic; it reuses the
`tools` context transport surface published through that context's
`contracts/`.

This project's SOURCE tree is adopted (WIN-297). It is a real process with a
fail-closed startup, but it holds no adapter: `adapters-only-from-core`
(rule (j)) names `apps/core-api` alone, so this binary receives its
`ToolsContract` from a host-supplied runtime module and refuses to start
without one. Its `package.json`, `tsconfig.json` and this README stay generated
by `scripts/arch/gen-v1-skeleton.mjs`.
