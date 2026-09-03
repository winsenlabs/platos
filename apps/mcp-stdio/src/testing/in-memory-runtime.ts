// A host runtime module, for evidence.
//
// `PLATOS_MCP_STDIO_RUNTIME_MODULE` names a module the HOST INSTALL supplies, and
// a specifier resolved at run time is invisible to every static boundary checker
// in this repository. That is exactly why the executable evidence points at a
// module that lives IN the repository: the seam is exercised end to end by the
// real binary, and the thing on the far side of it is still source that
// `arch-boundaries` and `v1-project-graph` police like anything else.
//
// It imports `@platos/context-tools` and nothing else — the single project
// `apps/mcp-stdio` is permitted to depend on — so this file cannot become a
// back door around rule (j) even by accident.

import type { ToolsContract } from "@platos/context-tools";

export function createToolsRuntime(): ToolsContract {
  return {
    name: "tools",
    // The `tools` context is still a WIN-251 placeholder; its real surface
    // arrives with the issue that extracts it. Answering "no such aggregate" is
    // the only honest implementation available, and the frame loop under test
    // never calls it.
    describe: async () => await Promise.resolve(null),
  };
}
