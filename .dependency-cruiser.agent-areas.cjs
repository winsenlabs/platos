// GENERATED — do not edit by hand.
// Source of truth: scripts/arch/agent-area-cycles.mjs
// Regenerate:      node scripts/arch/agent-area-cycles.mjs --write
// Drift gate:      node scripts/arch/agent-area-cycles.mjs --check
//
// Run it (dependency-cruiser is intentionally NOT a dependency of this repo):
//   npx --yes dependency-cruiser@16 --config .dependency-cruiser.agent-areas.cjs \
//       --output-type err "apps/agent/src/**/*.ts"
//
// The GLOB and not the directory: a bare directory makes dependency-cruiser 16
// report "0 modules cruised" on a TypeScript tree, which reads as a pass.
//
// The zero-dependency gate is `node scripts/arch/agent-area-cycles.mjs --check`,
// which is what CI runs; this config is the same rules in dependency-cruiser's
// own vocabulary, so the circular detection can be pointed at the same graph.

module.exports = {
  "forbidden": [
    {
      "name": "no-agent-area-cycles",
      "comment": "WIN-269 — no import cycle whose every hop is one of apps/agent's MCP, runtime or tool areas.",
      "severity": "error",
      "from": {
        "path": "^apps/agent/src/(mcp-platform|mcp-docs|agent-runtime|tool-gateway)/"
      },
      "to": {
        "circular": true,
        "viaOnly": {
          "path": "^apps/agent/src/(mcp-platform|mcp-docs|agent-runtime|tool-gateway)/"
        }
      }
    },
    {
      "name": "agent-tool-layer-below-runtime",
      "comment": "WIN-269 — apps/agent tool-gateway may not import agent-runtime.",
      "severity": "error",
      "from": {
        "path": "^apps/agent/src/(tool-gateway)/"
      },
      "to": {
        "path": "^apps/agent/src/(agent-runtime)/"
      }
    },
    {
      "name": "agent-tool-layer-below-mcp",
      "comment": "WIN-269 — apps/agent tool-gateway may not import an MCP transport.",
      "severity": "error",
      "from": {
        "path": "^apps/agent/src/(tool-gateway)/"
      },
      "to": {
        "path": "^apps/agent/src/(mcp-platform|mcp-docs)/"
      }
    },
    {
      "name": "agent-runtime-below-mcp",
      "comment": "WIN-269 — apps/agent agent-runtime may not import an MCP transport. Allowlisted, owned by M3.1 (WIN-261): apps/agent/src/agent-runtime/agent.controller.ts",
      "severity": "error",
      "from": {
        "path": "^apps/agent/src/(agent-runtime)/",
        "pathNot": "apps/agent/src/agent-runtime/agent\\.controller\\.ts"
      },
      "to": {
        "path": "^apps/agent/src/(mcp-platform|mcp-docs)/"
      }
    }
  ],
  "options": {
    "enhancedResolveOptions": {
      "extensions": [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".json"
      ]
    },
    "doNotFollow": {
      "path": "node_modules"
    },
    "exclude": {
      "path": "\\.(test|spec|test-fixture)\\.tsx?$"
    },
    "tsPreCompilationDeps": true,
    "reporterOptions": {
      "text": {
        "highlightFocused": true
      }
    }
  }
};
