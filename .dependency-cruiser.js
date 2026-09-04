// GENERATED — do not edit by hand.
// Source of truth: scripts/arch/boundary-rules.mjs
// Regenerate:      node scripts/arch/gen-dependency-cruiser.mjs
// Drift gate:      node scripts/arch/gen-dependency-cruiser.mjs --check
//
// The dependency-cruiser encoding of ADR M0.3 (WIN-248) boundary rules. It is
// wired to the WIN-251 root solution tsconfig. Run
//   depcruise packages apps --config .dependency-cruiser.js
// when dependency-cruiser is activated. The zero-dependency checker
// scripts/arch/arch-boundaries.mjs enforces the same rule set now and is proven
// non-vacuous by scripts/arch/arch-boundaries.test.mjs.
//
// The banned core-import list encoded below is exactly:
//   @nestjs, @prisma, prisma, ioredis, redis, @clickhouse, minio, @aws-sdk, @tri[g]ger\.dev, @modelcontextprotocol, openai, @anthropic-ai

module.exports = {
  "forbidden": [
    {
      "name": "no-infra-in-core",
      "comment": "domain/application of a context must not import an infrastructure SDK; they see infrastructure only through Platos-owned ports.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/[^/]+/(domain|application)/"
      },
      "to": {
        "path": "node_modules/(@nestjs|@prisma|prisma|ioredis|redis|@clickhouse|minio|@aws-sdk|@tri[g]ger\\.dev|@modelcontextprotocol|openai|@anthropic-ai)"
      }
    },
    {
      "name": "no-core-to-adapter",
      "comment": "domain/application must not import adapters or transport of any context.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/[^/]+/(domain|application)/"
      },
      "to": {
        "path": "^(packages/adapters/|packages/contexts/[^/]+/(adapters|transport)/)"
      }
    },
    {
      "name": "domain-imports-only-kernel",
      "comment": "a context's domain layer may import only its own domain and packages/kernel — not application, not any other context.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/([^/]+)/domain/"
      },
      "to": {
        "path": "^packages/(contexts|adapters|kernel)/",
        "pathNot": "^packages/(kernel/|contexts/$1/domain/)"
      }
    },
    {
      "name": "cross-context-contracts-only",
      "comment": "a context may import another context only through its published contracts/ — never its domain, application, adapters, or transport.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/([^/]+)/"
      },
      "to": {
        "path": "^packages/contexts/(?!$1/)[^/]+/(domain|application|adapters|transport)/"
      }
    },
    {
      "name": "context-dag-identity-access",
      "comment": "ADR M0.3 §1 domainDeps: identity-access may not depend on tenancy, secrets, providers, agents, skills, tools, memory, channels, files, observability, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/identity-access/"
      },
      "to": {
        "path": "^packages/contexts/(tenancy|secrets|providers|agents|skills|tools|memory|channels|files|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-tenancy",
      "comment": "ADR M0.3 §1 domainDeps: tenancy may not depend on secrets, providers, agents, skills, tools, memory, channels, files, observability, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/tenancy/"
      },
      "to": {
        "path": "^packages/contexts/(secrets|providers|agents|skills|tools|memory|channels|files|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-secrets",
      "comment": "ADR M0.3 §1 domainDeps: secrets may not depend on identity-access, tenancy, providers, agents, skills, tools, memory, channels, files, observability, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/secrets/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|tenancy|providers|agents|skills|tools|memory|channels|files|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-providers",
      "comment": "ADR M0.3 §1 domainDeps: providers may not depend on identity-access, agents, skills, tools, memory, channels, files, observability, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/providers/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|agents|skills|tools|memory|channels|files|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-agents",
      "comment": "ADR M0.3 §1 domainDeps: agents may not depend on identity-access, secrets, tools, memory, channels, files, observability, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/agents/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|secrets|tools|memory|channels|files|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-skills",
      "comment": "ADR M0.3 §1 domainDeps: skills may not depend on identity-access, secrets, providers, agents, tools, memory, channels, observability, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/skills/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|secrets|providers|agents|tools|memory|channels|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-tools",
      "comment": "ADR M0.3 §1 domainDeps: tools may not depend on agents, skills, memory, channels, files, observability, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/tools/"
      },
      "to": {
        "path": "^packages/contexts/(agents|skills|memory|channels|files|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-memory",
      "comment": "ADR M0.3 §1 domainDeps: memory may not depend on identity-access, secrets, agents, skills, tools, channels, files, observability, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/memory/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|secrets|agents|skills|tools|channels|files|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-channels",
      "comment": "ADR M0.3 §1 domainDeps: channels may not depend on secrets, providers, agents, skills, tools, memory, files, observability, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/channels/"
      },
      "to": {
        "path": "^packages/contexts/(secrets|providers|agents|skills|tools|memory|files|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-files",
      "comment": "ADR M0.3 §1 domainDeps: files may not depend on identity-access, secrets, providers, agents, skills, tools, memory, channels, observability, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/files/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|secrets|providers|agents|skills|tools|memory|channels|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-observability",
      "comment": "ADR M0.3 §1 domainDeps: observability may not depend on identity-access, secrets, providers, agents, skills, tools, memory, channels, files, cost-monitoring, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/observability/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|secrets|providers|agents|skills|tools|memory|channels|files|cost-monitoring|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-cost-monitoring",
      "comment": "ADR M0.3 §1 domainDeps: cost-monitoring may not depend on identity-access, secrets, agents, skills, tools, memory, channels, files, observability, governance, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/cost-monitoring/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|secrets|agents|skills|tools|memory|channels|files|observability|governance|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-governance",
      "comment": "ADR M0.3 §1 domainDeps: governance may not depend on identity-access, secrets, providers, skills, tools, memory, channels, files, observability, cost-monitoring, jobs, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/governance/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|secrets|providers|skills|tools|memory|channels|files|observability|cost-monitoring|jobs|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-jobs",
      "comment": "ADR M0.3 §1 domainDeps: jobs may not depend on identity-access, secrets, providers, agents, skills, tools, memory, channels, files, observability, cost-monitoring, governance, conversations, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/jobs/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|secrets|providers|agents|skills|tools|memory|channels|files|observability|cost-monitoring|governance|conversations|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-conversations",
      "comment": "ADR M0.3 §1 domainDeps: conversations may not depend on identity-access, channels, observability, governance, eventing, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/conversations/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|channels|observability|governance|eventing|privacy)/"
      }
    },
    {
      "name": "context-dag-eventing",
      "comment": "ADR M0.3 §1 domainDeps: eventing may not depend on identity-access, secrets, providers, agents, skills, tools, memory, channels, files, observability, cost-monitoring, governance, jobs, conversations, privacy.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/eventing/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|secrets|providers|agents|skills|tools|memory|channels|files|observability|cost-monitoring|governance|jobs|conversations|privacy)/"
      }
    },
    {
      "name": "context-dag-privacy",
      "comment": "ADR M0.3 §1 domainDeps: privacy may not depend on identity-access, secrets, providers, agents, skills, tools, memory, channels, files, observability, cost-monitoring, governance, jobs, conversations, eventing.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/privacy/"
      },
      "to": {
        "path": "^packages/contexts/(identity-access|secrets|providers|agents|skills|tools|memory|channels|files|observability|cost-monitoring|governance|jobs|conversations|eventing)/"
      }
    },
    {
      "name": "no-cross-context-cycles",
      "comment": "import cycle across contexts is forbidden; the context graph must stay acyclic.",
      "severity": "error",
      "from": {},
      "to": {
        "circular": true
      }
    },
    {
      "name": "kernel-is-leaf",
      "comment": "packages/kernel must not import any context, any adapter, or any infrastructure SDK; it is interfaces and pure value objects only.",
      "severity": "error",
      "from": {
        "path": "^packages/kernel/"
      },
      "to": {
        "path": "^(packages/contexts/|packages/adapters/)|node_modules/(@nestjs|@prisma|prisma|ioredis|redis|@clickhouse|minio|@aws-sdk|@tri[g]ger\\.dev|@modelcontextprotocol|openai|@anthropic-ai)"
      }
    },
    {
      "name": "identity-isolation",
      "comment": "identity-access is the leaf that kills the wrong-way auth edges; it must not import tools/providers/cost-monitoring/governance/channels.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/identity-access/"
      },
      "to": {
        "path": "^packages/contexts/(tools|providers|cost-monitoring|governance|channels)/"
      }
    },
    {
      "name": "no-shared-package",
      "comment": "no shared/common/util/utils/misc/helpers/lib/core-utils package may exist; the only cross-cutting package is packages/kernel.",
      "severity": "error",
      "from": {},
      "to": {
        "path": "^(packages/(shared|common|utils|util|core-utils|misc|helpers|lib)/|node_modules/@platos/(shared|common|utils|util|core-utils|misc|helpers|lib)/)"
      }
    },
    {
      "name": "adapters-only-from-core",
      "comment": "only the composition root apps/core-api may import packages/adapters/*; an adapter may import its own modules.",
      "severity": "error",
      "from": {
        "pathNot": "^(apps/core-api/|packages/adapters/)"
      },
      "to": {
        "path": "^packages/adapters/"
      }
    },
    {
      "name": "adapter-is-self-contained",
      "comment": "an adapter may import only its own modules; adapters are composed in apps/core-api, never chained.",
      "severity": "error",
      "from": {
        "path": "^packages/adapters/([^/]+)/"
      },
      "to": {
        "path": "^packages/adapters/",
        "pathNot": "^packages/adapters/$1/"
      }
    },
    {
      "name": "webapp-no-prisma",
      "comment": "apps/webapp must reach data through core-api query ports, never Prisma directly (the M2.2 migration lock).",
      "severity": "error",
      "from": {
        "path": "^apps/webapp/"
      },
      "to": {
        "path": "^(node_modules/@prisma/|internal-packages/(database|tenancy-database)/)"
      }
    },
    {
      "name": "unknown-context-directory",
      "comment": "packages/contexts/<name>/ must be one of the 17 contexts named in ADR M0.3 §4; an adapter belongs under packages/adapters/.",
      "severity": "error",
      "from": {
        "path": "^packages/contexts/(?!(identity-access|tenancy|secrets|providers|agents|skills|tools|memory|channels|files|observability|cost-monitoring|governance|jobs|conversations|eventing|privacy)/)"
      },
      "to": {}
    },
    {
      "name": "mcp-sdk-only-in-tools",
      "comment": "node_modules/@modelcontextprotocol may be imported only from its single owning adapter.",
      "severity": "error",
      "from": {
        "pathNot": "^packages/contexts/tools/(adapters|transport)/"
      },
      "to": {
        "path": "node_modules/@modelcontextprotocol"
      }
    },
    {
      "name": "durable-runtime-sdk-only",
      "comment": "node_modules/@tri[g]ger\\.dev may be imported only from its single owning adapter.",
      "severity": "error",
      "from": {
        "pathNot": "^packages/adapters/durable-runtime/"
      },
      "to": {
        "path": "node_modules/@tri[g]ger\\.dev"
      }
    },
    {
      "name": "clickhouse-sdk-only",
      "comment": "node_modules/@clickhouse may be imported only from its single owning adapter.",
      "severity": "error",
      "from": {
        "pathNot": "^packages/adapters/clickhouse-observability/"
      },
      "to": {
        "path": "node_modules/@clickhouse"
      }
    },
    {
      "name": "objectstore-sdk-only",
      "comment": "node_modules/(minio|@aws-sdk) may be imported only from its single owning adapter.",
      "severity": "error",
      "from": {
        "pathNot": "^packages/adapters/objectstore-minio/"
      },
      "to": {
        "path": "node_modules/(minio|@aws-sdk)"
      }
    },
    {
      "name": "provider-sdk-only",
      "comment": "node_modules/(openai|@anthropic-ai) may be imported only from its single owning adapter.",
      "severity": "error",
      "from": {
        "pathNot": "^packages/adapters/model-router-providers/"
      },
      "to": {
        "path": "node_modules/(openai|@anthropic-ai)"
      }
    },
    {
      "name": "inference-sdk-only",
      "comment": "node_modules/(ai(?:/|$)|@ai-sdk/) may be imported only from its single owning adapter.",
      "severity": "error",
      "from": {
        "pathNot": "^packages/adapters/model-router-providers/"
      },
      "to": {
        "path": "node_modules/(ai(?:/|$)|@ai-sdk/)"
      }
    }
  ],
  "options": {
    "tsConfig": {
      "fileName": "tsconfig.json"
    },
    "doNotFollow": {
      "path": "node_modules"
    },
    "enhancedResolveOptions": {
      "exportsFields": [
        "exports"
      ],
      "conditionNames": [
        "import",
        "require",
        "node",
        "default"
      ]
    },
    "reporterOptions": {
      "text": {
        "highlightFocused": true
      }
    }
  }
};
