/**
 * Theme K.14 — Orchestration composite MCP tools.
 *
 * Phase-3 Wave-D work. The earlier Wave-C batches (K.5–K.8) shipped ~46
 * REST wrappers so Claude Desktop could _read_ Platos. This file moves the
 * bar to _running_ Platos — every tool here fans out 3–5 backing service
 * calls server-side so the LLM issues one high-level intent and we return
 * a single aggregated result.
 *
 * Each handler:
 *   - Takes scope from the verified MCP token (never from LLM input).
 *   - Delegates to existing services — no new business logic introduced.
 *   - Fails open on optional / late-stage steps so a partial success still
 *     returns a useful result rather than an opaque 500.
 *
 * Tier-1 require_approval (wired in permission-gateway.service.ts):
 *   - agents.deploy_with_skills        (creates + installs skills)
 *   - entities.provision               (creates a new tool backend)
 *   - scopes.bootstrap_demo_data       (writes demo seeds)
 *
 * Auto-allow (safe by construction):
 *   - agents.clone_from                (reads a scoped source, writes a
 *                                        new agent in the same scope)
 *   - evals.regression_sweep           (read-only vs the judge model, no
 *                                        destructive writes to agent state)
 */

import type { AgentCrudService, CreateAgentDto } from "../../agent-runtime/agent-crud.service";
import type { AuthService } from "../../auth/auth.service";
import type { SkillRegistryService } from "../../skills/skill-registry.service";
import type { MemoryService } from "../../memory/memory.service";
import type { GoldenSetService } from "../../evals/golden-set.service";
import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

export interface OrchestrationDeps {
  agentCrud: AgentCrudService;
  auth: AuthService;
  skillRegistry: SkillRegistryService;
  memory: MemoryService;
  goldenSet: GoldenSetService;
  /**
   * Prisma client (already global via DatabaseModule). Needed for the
   * agent contextMapping update + the entities.provision tool-mapping
   * stubs, both of which have no dedicated service method.
   */
  prisma: any;
}

export function buildOrchestrationToolHandlers(deps: OrchestrationDeps): McpToolHandler[] {
  const { agentCrud, auth, skillRegistry, memory, goldenSet, prisma } = deps;

  return [
    // ── agents.deploy_with_skills ───────────────────────────────────
    {
      name: "agents.deploy_with_skills",
      description:
        "Composite — create a new agent + enable a list of scope-resident skills on it + " +
        "(optionally) set its contextMapping. Returns the fully-configured agent. " +
        "Destructive — defaults to require_approval at platform tier.",
      inputSchema: {
        type: "object",
        required: ["name", "model", "skillSlugs"],
        properties: {
          name: { type: "string" },
          model: { type: "string" },
          systemPrompt: { type: "string" },
          skillSlugs: {
            type: "array",
            items: { type: "string" },
            description: "Skill `skillId` slugs (e.g. `web-research`). Resolved against the scope's skill registry.",
          },
          contextMapping: {
            type: ["object", "null"],
            description:
              "Optional PlatosAgent.contextMapping JSON (promptVars, toolArgInjection, envelopeKeys, entityIdsKey).",
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const name = String(params["name"]);
        const model = String(params["model"]);
        const systemPrompt = params["systemPrompt"] as string | undefined;
        const skillSlugs = (params["skillSlugs"] as string[]) ?? [];
        const contextMapping = params["contextMapping"] as Record<string, unknown> | null | undefined;

        // Step 1 — create the agent. Hard fail — nothing to return otherwise.
        const dto: CreateAgentDto = {
          name,
          model,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        };
        const agent = await agentCrud.create(scope, dto);

        // Step 2 — resolve every slug against the scope's skill registry and
        // enable each one. Partial success is the expected common case: a
        // missing slug shouldn't wipe out the created agent.
        const allSkills = await skillRegistry.list(tuple(scope));
        const bySlug = new Map(allSkills.map((s) => [s.skillId, s]));

        const skillWarnings: Array<{ slug: string; error: string }> = [];
        const enabledSkills: Array<{ slug: string; id: string }> = [];
        for (const slug of skillSlugs) {
          const skillRow = bySlug.get(slug);
          if (!skillRow) {
            skillWarnings.push({ slug, error: `skill "${slug}" not registered in scope` });
            continue;
          }
          try {
            await skillRegistry.enableForAgent(tuple(scope), agent.id, skillRow.id);
            enabledSkills.push({ slug, id: skillRow.id });
          } catch (err: any) {
            skillWarnings.push({
              slug,
              error: err?.message || String(err),
            });
          }
        }

        // Step 3 — optional contextMapping. Fail-open: surface in warnings,
        // keep the agent.
        let contextMappingApplied = false;
        let contextMappingWarning: string | null = null;
        if (contextMapping !== undefined && contextMapping !== null) {
          try {
            await prisma.platosAgent.update({
              where: { id: agent.id },
              data: { contextMapping: contextMapping as any },
            });
            contextMappingApplied = true;
          } catch (err: any) {
            contextMappingWarning = err?.message || String(err);
          }
        }

        // Step 4 — re-fetch so the returned record reflects the contextMapping
        // + versioning side-effects from skill enablement.
        const fresh = await agentCrud.findById(agent.id, scope);

        return {
          agent: fresh ?? agent,
          enabledSkills,
          contextMappingApplied,
          warnings: {
            skills: skillWarnings,
            ...(contextMappingWarning ? { contextMapping: contextMappingWarning } : {}),
          },
        };
      },
    },

    // ── entities.provision ──────────────────────────────────────────
    {
      name: "entities.provision",
      description:
        "Composite — register a new connected entity AND seed optional tool-mapping " +
        "stubs for it (each row is a placeholder that the real tool-sync handshake " +
        "overwrites on first connect). Destructive — defaults to require_approval at " +
        "platform tier. `plaintextSecret` is returned exactly once.",
      inputSchema: {
        type: "object",
        required: ["entityId", "displayName"],
        properties: {
          entityId: { type: "string" },
          displayName: { type: "string" },
          initialTools: {
            type: "array",
            items: { type: "string" },
            description: "Tool names to pre-register as stubs; real sync will overwrite them.",
          },
          mcpUrls: {
            type: "array",
            items: { type: "string" },
            description:
              "MCP endpoints for the entity's backend. If omitted, defaults to a single `/mcp` placeholder — real URLs can be set later via entities.regenerate_secret / config.",
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityId = String(params["entityId"]);
        const displayName = String(params["displayName"]);
        const initialTools = (params["initialTools"] as string[]) ?? [];
        const mcpUrls = ((params["mcpUrls"] as string[]) ?? []).filter((u) => typeof u === "string" && u.length > 0);
        const effectiveMcpUrls = mcpUrls.length > 0 ? mcpUrls : ["/mcp"];

        // Step 1 — register the entity. Hard fail — nothing else works
        // without the FK target.
        const entity = await auth.registerEntity({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          entityId,
          displayName,
          mcpUrls: effectiveMcpUrls,
          serviceSecret: "auto",
        });

        // Step 2 — for each `initialTools` name, upsert a minimal
        // PlatosToolDefinition (real schema gets overwritten by the first
        // tool-sync handshake) and upsert the PlatosEntityToolMapping row
        // pointing it at this env.
        const toolWarnings: Array<{ tool: string; error: string }> = [];
        let createdMappings = 0;
        const callbackUrl = effectiveMcpUrls[0] ?? "/mcp";
        for (const toolName of initialTools) {
          try {
            // Upsert the central tool definition first. SECURITY (audit H15) —
            // scope by (org, project, name): PlatosToolDefinition is now
            // per-tenant (was globally unique by name). An unscoped lookup here
            // would attach this provision's mapping to whatever tenant already
            // owns that name, and post-migration `findUnique({name})` throws
            // (name is no longer a unique key) — silently swallowed into
            // toolWarnings, so stubs would stop being created.
            const existing = await prisma.platosToolDefinition.findFirst({
              where: {
                name: toolName,
                organizationId: scope.organizationId,
                projectId: scope.projectId,
              },
            });
            const toolDef = existing
              ? existing
              : await prisma.platosToolDefinition.create({
                  data: {
                    name: toolName,
                    organizationId: scope.organizationId,
                    projectId: scope.projectId,
                    description: `[stub] ${toolName} — schema pending tool-sync handshake.`,
                    paramSchema: { type: "object", additionalProperties: true } as any,
                    schemaHash: "stub",
                    bm25Tokens: [toolName],
                    category: null,
                  },
                });
            // Then upsert the per-(tool, entity, env) mapping stub.
            await prisma.platosEntityToolMapping.upsert({
              where: {
                toolId_entityId_environmentId: {
                  toolId: toolDef.id,
                  entityId: entity.id,
                  environmentId: scope.environmentId,
                },
              },
              update: { enabled: false, callbackUrl },
              // Stub rows default to `enabled: false` so they don't surface in
              // find_tools until the real handshake re-registers them with a
              // proper schema.
              create: {
                toolId: toolDef.id,
                entityId: entity.id,
                environmentId: scope.environmentId,
                enabled: false,
                callbackUrl,
              },
            });
            createdMappings += 1;
          } catch (err: any) {
            toolWarnings.push({ tool: toolName, error: err?.message || String(err) });
          }
        }

        return {
          entity,
          plaintextSecret: entity.plaintextSecret,
          createdMappings,
          warnings: toolWarnings,
        };
      },
    },

    // ── evals.regression_sweep ──────────────────────────────────────
    {
      name: "evals.regression_sweep",
      description:
        "Composite — find every golden set for an agent and run each through " +
        "the judge pipeline. Returns per-run pass/fail + regression verdict + a " +
        "trace pointer for each eval row.",
      inputSchema: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string" },
          baselineVersionId: {
            type: ["string", "null"],
            description: "Optional — compare candidate scores against this baseline version.",
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const agentId = String(params["agentId"]);
        const baselineVersionId = (params["baselineVersionId"] as string | null | undefined) ?? null;

        const sets = await goldenSet.list(tuple(scope), { agentId });
        if (sets.length === 0) {
          return {
            agentId,
            total: 0,
            passed: 0,
            failed: 0,
            results: [],
            warning: "no golden sets found for agent",
          };
        }

        type SweepResult = {
          goldenSetId: string;
          runId: string;
          pairCount: number;
          completed: number;
          failed: number;
          regressed: boolean;
          traceUrl: string | null;
          error?: string;
        };

        const results: SweepResult[] = [];
        let total = 0;
        let passed = 0;
        let failed = 0;
        for (const set of sets) {
          try {
            const run = await goldenSet.run(scope, set.id, {
              baselineVersionId: baselineVersionId ?? undefined,
            });
            total += run.pairCount;
            passed += run.completed;
            failed += run.failed;
            results.push({
              goldenSetId: set.id,
              runId: run.runId,
              pairCount: run.pairCount,
              completed: run.completed,
              failed: run.failed,
              regressed: run.regression.regressed,
              // Trace URL: canonical evals dashboard filter pattern used in
              // the webapp. The client can deep-link to per-run trace view.
              traceUrl: `/evals/runs/${run.runId}`,
            });
          } catch (err: any) {
            failed += 1;
            results.push({
              goldenSetId: set.id,
              runId: "",
              pairCount: 0,
              completed: 0,
              failed: 0,
              regressed: false,
              traceUrl: null,
              error: err?.message || String(err),
            });
          }
        }

        return {
          agentId,
          total,
          passed,
          failed,
          results,
        };
      },
    },

    // ── agents.clone_from ───────────────────────────────────────────
    {
      name: "agents.clone_from",
      description:
        "Composite — snapshot an existing agent's config and create a fresh copy in the " +
        "SAME scope with a new name + slug. Copies promptBlocks, dynamicBlocks, tool + " +
        "meta-tool config, memory/extraction policy, output schema, and contextMapping. " +
        "Does NOT copy threads, versions, or canary pointers — the clone starts clean.",
      inputSchema: {
        type: "object",
        required: ["sourceAgentId", "newName"],
        properties: {
          sourceAgentId: { type: "string" },
          newName: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const sourceAgentId = String(params["sourceAgentId"]);
        const newName = String(params["newName"]);

        const src = await agentCrud.findById(sourceAgentId, scope);
        if (!src) throw new Error(`source agent ${sourceAgentId} not found in scope`);

        // Build the create DTO — `agentCrud.create` derives the slug from
        // the name (auto-handles collisions with a `-<ts>` suffix). We
        // copy every behaviour-shaping field but explicitly drop identity/
        // lifecycle fields (id, slug, createdAt, versions, canary...).
        const createDto: CreateAgentDto = {
          name: newName,
          model: src.model,
          ...(src.systemPrompt ? { systemPrompt: src.systemPrompt } : {}),
          ...(src.promptBlocks ? { promptBlocks: src.promptBlocks } : {}),
          ...(src.dynamicBlocks ? { dynamicBlocks: src.dynamicBlocks } : {}),
          maxSteps: src.maxSteps,
          contextLimit: src.contextLimit,
          historyMode: (src.historyMode as "rolling" | "compact") ?? "rolling",
          compactThreshold: src.compactThreshold,
          enableUserProfiling: src.enableUserProfiling,
          toolMode: src.toolMode,
          ...(src.toolsBlockConfig ? { toolsBlockConfig: src.toolsBlockConfig } : {}),
          ...(src.subAgentConfig ? { subAgentConfig: src.subAgentConfig } : {}),
          ...(src.memoryConfig ? { memoryConfig: src.memoryConfig } : {}),
          ...(src.metaTools ? { metaTools: src.metaTools } : {}),
          ...(src.outputSchema !== undefined
            ? { outputSchema: src.outputSchema ?? null }
            : {}),
          ...(src.extractionPolicy !== undefined
            ? { extractionPolicy: (src.extractionPolicy as any) ?? null }
            : {}),
        };
        const cloned = await agentCrud.create(scope, createDto);

        // Step 2 — copy contextMapping via direct Prisma update. The CRUD
        // service's create/update DTOs don't expose this field today; the
        // schema does (CTX.1). Fail-open: if the copy errors, the clone
        // still exists, we just note it in warnings.
        let contextMappingCopied = false;
        let contextMappingWarning: string | null = null;
        try {
          const srcRow = await prisma.platosAgent.findFirst({
            where: {
              id: sourceAgentId,
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            select: { contextMapping: true },
          });
          if (srcRow?.contextMapping != null) {
            await prisma.platosAgent.update({
              where: { id: cloned.id },
              data: { contextMapping: srcRow.contextMapping as any },
            });
            contextMappingCopied = true;
          }
        } catch (err: any) {
          contextMappingWarning = err?.message || String(err);
        }

        const fresh = await agentCrud.findById(cloned.id, scope);
        return {
          agent: fresh ?? cloned,
          sourceAgentId,
          contextMappingCopied,
          ...(contextMappingWarning ? { warning: contextMappingWarning } : {}),
        };
      },
    },

    // ── scopes.bootstrap_demo_data ─────────────────────────────────
    {
      name: "scopes.bootstrap_demo_data",
      description:
        "Composite — seed a small demo payload in the token's scope (1 demo agent + " +
        "2 demo memories). Destructive — defaults to require_approval at platform " +
        "tier. Scope is always taken from the token; any LLM-supplied scope is ignored.",
      inputSchema: {
        // Intentionally empty — scope comes from the MCP token, NEVER from
        // LLM input. Documented here so the caller doesn't try to pass one.
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_params, scope) {
        // Step 1 — demo agent.
        const agent = await agentCrud.create(scope, {
          name: "Demo Agent",
          model: "gpt-4o-mini",
          systemPrompt:
            "You are a demo agent inside Platos. Be concise, cite tool output when you use it, and feel free to ask for clarification on ambiguous requests.",
        });

        // Step 2 — seed 2 demo memories under the acting userId (the token's
        // mintedByUserId — i.e. scope.userId). Fail-open: if the embedding
        // provider isn't configured, skip and report in warnings rather
        // than failing the bootstrap.
        let memoriesCreated = 0;
        const memWarnings: string[] = [];
        const demoMemories = [
          {
            content: "User prefers concise, bullet-point answers.",
            kind: "preference" as const,
          },
          {
            content: "User is exploring Platos for the first time.",
            kind: "fact" as const,
          },
        ];
        for (const m of demoMemories) {
          try {
            await memory.add(tuple(scope), {
              userId: scope.userId,
              content: m.content,
              kind: m.kind,
              source: "manual",
            });
            memoriesCreated += 1;
          } catch (err: any) {
            memWarnings.push(err?.message || String(err));
          }
        }

        return {
          agentId: agent.id,
          memoriesCreated,
          ...(memWarnings.length > 0 ? { warnings: { memories: memWarnings } } : {}),
        };
      },
    },
  ];
}
