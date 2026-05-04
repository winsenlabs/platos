/**
 * Individual `platools doctor` check implementations.
 *
 * Ported 1:1 from `platools/doctor/checks.py`. Every rule the
 * Python doctor enforces has an equivalent here so the two SDKs
 * stay in lockstep — PRD §5.1 treats `platools doctor` as the ship
 * gate and silent rule drift would break customers on mixed
 * stacks.
 *
 * Spec rules (PRD §5.1, PLATOS-18 task description):
 *
 *   1. Unreachable parameters
 *   2. Type mismatches
 *   3. Circular dependencies
 *   4. Orphan tools
 *   5. Missing descriptions
 *   6. No return schema
 *   7. Duplicate / ambiguous outputs
 *   8. Permission gaps
 *   9. Overly broad tools
 *  10. Missing destructive annotations
 *
 * Each check is a pure function from `ToolDef[]` (+ optional
 * context) to `Finding[]` — no I/O, no LLM calls, so the CLI can
 * run in CI without network or credentials.
 */

import type { JsonSchema, ToolDef } from "../types.js";
import type { Finding } from "./types.js";

const DESTRUCTIVE_NAME_TOKENS: readonly string[] = [
  "delete",
  "remove",
  "archive",
  "drop",
  "purge",
  "clear",
  "wipe",
  "destroy",
  "truncate",
];

const MIN_DESCRIPTION_CHARS = 10;
const MAX_PARAMS_BEFORE_BROAD = 10;

// ----- helpers -----

function inputProperties(tool: ToolDef): Record<string, JsonSchema> {
  const schema = tool.inputSchema ?? {};
  const props = schema.properties;
  if (props === undefined || props === null || typeof props !== "object") return {};
  const out: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== null && typeof v === "object") out[k] = v;
  }
  return out;
}

function requiredParamNames(tool: ToolDef): Set<string> {
  const schema = tool.inputSchema ?? {};
  const req = schema.required;
  if (!Array.isArray(req)) return new Set<string>();
  return new Set(req.map((x) => String(x)));
}

function outputProperties(tool: ToolDef): Record<string, JsonSchema> {
  const schema = tool.outputSchema;
  if (schema === null || schema === undefined) return {};
  const props = schema.properties;
  if (props === undefined || props === null || typeof props !== "object") return {};
  const out: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== null && typeof v === "object") out[k] = v;
  }
  return out;
}

function jsonType(prop: JsonSchema): string | null {
  const t = prop.type;
  if (typeof t === "string") return t;
  return null;
}

function isUserProvidable(prop: JsonSchema): boolean {
  return prop["x-user-providable"] === true;
}

// ----- 1. unreachable / 2. type mismatch / 7. ambiguous output -----

/**
 * Combined check for rules 1, 2, and 7 — they all walk the same
 * graph (required input param ↔ every other tool's outputs) so
 * rolling them into one pass avoids three O(N²) scans.
 */
export function checkParamSources(tools: readonly ToolDef[]): Finding[] {
  const findings: Finding[] = [];

  // Map output field → producing tools (name + JSON type).
  const outputIndex = new Map<string, Array<{ tool: string; type: string | null }>>();
  for (const tool of tools) {
    for (const [fieldName, propSchema] of Object.entries(outputProperties(tool))) {
      const list = outputIndex.get(fieldName) ?? [];
      list.push({ tool: tool.name, type: jsonType(propSchema) });
      outputIndex.set(fieldName, list);
    }
  }

  // Rule 7: ambiguous outputs.
  for (const [fieldName, producers] of outputIndex) {
    if (producers.length > 1) {
      const names = [...producers.map((p) => p.tool)].sort().join(", ");
      findings.push({
        severity: "info",
        code: "ambiguous_output",
        message: `field "${fieldName}" is returned by ${producers.length} tools: ${names}`,
      });
    }
  }

  for (const tool of tools) {
    const required = requiredParamNames(tool);
    const props = inputProperties(tool);
    for (const paramName of [...required].sort()) {
      const propSchema = props[paramName] ?? ({} as JsonSchema);
      const userProvidable = isUserProvidable(propSchema);
      const paramType = jsonType(propSchema);
      const sources = outputIndex.get(paramName) ?? [];
      const external = sources.filter((s) => s.tool !== tool.name);

      if (external.length === 0 && !userProvidable) {
        findings.push({
          severity: "error",
          code: "unreachable_param",
          message: `${tool.name}.${paramName} has no source — no other tool outputs this field and the param is not marked user-providable`,
          tool: tool.name,
          param: paramName,
        });
        continue;
      }

      if (paramType === null) continue;
      for (const producer of external) {
        if (producer.type !== null && producer.type !== paramType) {
          findings.push({
            severity: "warning",
            code: "type_mismatch",
            message: `${tool.name}.${paramName} expects "${paramType}" but ${producer.tool} returns "${producer.type}"`,
            tool: tool.name,
            param: paramName,
          });
        }
      }
    }
  }

  return findings;
}

// ----- 3. circular dependencies -----

/**
 * DFS cycle detection on the tool dependency graph.
 *
 * Edges: tool A → tool B if B's output schema produces a field
 * that matches one of A's required input parameter names. A cycle
 * in that graph means the LLM can't pick a starting point — flagged
 * as ERROR.
 *
 * Emits one finding per participating tool so the reporter's
 * "healthy count" header subtracts every tool in the cycle, not
 * just the one we happened to walk into — this matches the Python
 * SDK's behavior (reviewer-caught regression in PLATOS-18).
 */
export function checkCircularDependencies(tools: readonly ToolDef[]): Finding[] {
  const outputProducers = new Map<string, Set<string>>();
  for (const tool of tools) {
    for (const fieldName of Object.keys(outputProperties(tool))) {
      const set = outputProducers.get(fieldName) ?? new Set<string>();
      set.add(tool.name);
      outputProducers.set(fieldName, set);
    }
  }

  const deps = new Map<string, Set<string>>();
  for (const tool of tools) deps.set(tool.name, new Set<string>());
  for (const tool of tools) {
    for (const paramName of requiredParamNames(tool)) {
      const producers = outputProducers.get(paramName);
      if (producers === undefined) continue;
      for (const producer of producers) {
        if (producer !== tool.name) deps.get(tool.name)!.add(producer);
      }
    }
  }

  const findings: Finding[] = [];
  const seenCycles = new Set<string>();

  const UNVISITED = 0;
  const IN_STACK = 1;
  const DONE = 2;
  const color = new Map<string, number>();
  for (const name of deps.keys()) color.set(name, UNVISITED);
  const stack: string[] = [];

  const visit = (node: string): void => {
    color.set(node, IN_STACK);
    stack.push(node);
    const neighbors = Array.from(deps.get(node) ?? []).sort();
    for (const neighbor of neighbors) {
      const state = color.get(neighbor) ?? UNVISITED;
      if (state === IN_STACK) {
        const idx = stack.indexOf(neighbor);
        const cycle = stack.slice(idx);
        const canonical = [...cycle].sort().join("|");
        if (!seenCycles.has(canonical)) {
          seenCycles.add(canonical);
          const rendered = [...cycle, neighbor].join(" → ");
          for (const member of cycle) {
            findings.push({
              severity: "error",
              code: "circular_dependency",
              message: `circular dependency: ${rendered}`,
              tool: member,
            });
          }
        }
      } else if (state === UNVISITED) {
        visit(neighbor);
      }
    }
    stack.pop();
    color.set(node, DONE);
  };

  for (const name of Array.from(deps.keys()).sort()) {
    if (color.get(name) === UNVISITED) visit(name);
  }
  return findings;
}

// ----- 4. orphan tools -----

export function checkOrphanTools(
  tools: readonly ToolDef[],
  options: { agentToolNames?: ReadonlySet<string> } = {},
): Finding[] {
  const { agentToolNames } = options;
  if (agentToolNames === undefined) return [];
  const findings: Finding[] = [];
  for (const tool of tools) {
    if (!agentToolNames.has(tool.name)) {
      findings.push({
        severity: "info",
        code: "orphan_tool",
        message: `${tool.name} is not assigned to any agent`,
        tool: tool.name,
      });
    }
  }
  return findings;
}

// ----- 5. missing descriptions -----

export function checkDescriptions(tools: readonly ToolDef[]): Finding[] {
  const findings: Finding[] = [];
  for (const tool of tools) {
    const desc = (tool.description ?? "").trim();
    if (desc.length < MIN_DESCRIPTION_CHARS) {
      findings.push({
        severity: "warning",
        code: "short_tool_description",
        message: `${tool.name} description is too short (${desc.length} chars, need ≥ ${MIN_DESCRIPTION_CHARS})`,
        tool: tool.name,
      });
    }
    for (const [paramName, propSchema] of Object.entries(inputProperties(tool))) {
      const paramDesc = String(propSchema.description ?? "").trim();
      if (paramDesc.length < MIN_DESCRIPTION_CHARS) {
        findings.push({
          severity: "warning",
          code: "short_param_description",
          message: `${tool.name}.${paramName} description is too short (${paramDesc.length} chars)`,
          tool: tool.name,
          param: paramName,
        });
      }
    }
  }
  return findings;
}

// ----- 6. no return schema -----

export function checkReturnSchema(tools: readonly ToolDef[]): Finding[] {
  const findings: Finding[] = [];
  for (const tool of tools) {
    if (tool.outputSchema === null) {
      findings.push({
        severity: "warning",
        code: "no_return_schema",
        message: `${tool.name} has no typed return value — downstream tools can't depend on it`,
        tool: tool.name,
      });
    }
  }
  return findings;
}

// ----- 8. permission gaps -----

export function checkPermissionGaps(
  tools: readonly ToolDef[],
  options: { rolesInUse?: ReadonlySet<string> } = {},
): Finding[] {
  const { rolesInUse } = options;
  if (rolesInUse === undefined) return [];
  const findings: Finding[] = [];
  for (const tool of tools) {
    for (const role of tool.roles) {
      if (!rolesInUse.has(role)) {
        findings.push({
          severity: "warning",
          code: "permission_gap",
          message: `${tool.name} requires role "${role}", no agent has this role`,
          tool: tool.name,
        });
      }
    }
  }
  return findings;
}

// ----- 9. overly broad tools -----

export function checkOverlyBroad(tools: readonly ToolDef[]): Finding[] {
  const findings: Finding[] = [];
  for (const tool of tools) {
    const paramCount = Object.keys(inputProperties(tool)).length;
    if (paramCount > MAX_PARAMS_BEFORE_BROAD) {
      findings.push({
        severity: "info",
        code: "overly_broad_tool",
        message: `${tool.name} has ${paramCount} parameters (consider splitting — > ${MAX_PARAMS_BEFORE_BROAD} may confuse the LLM)`,
        tool: tool.name,
      });
    }
  }
  return findings;
}

// ----- 10. missing destructive annotations -----

export function checkDestructiveAnnotations(tools: readonly ToolDef[]): Finding[] {
  const findings: Finding[] = [];
  for (const tool of tools) {
    const nameLower = tool.name.toLowerCase();
    const looksDestructive = DESTRUCTIVE_NAME_TOKENS.some((tok) => nameLower.includes(tok));
    if (!looksDestructive) continue;
    if (tool.annotations["destructiveHint"] !== true) {
      findings.push({
        severity: "warning",
        code: "missing_destructive_hint",
        message: `${tool.name} looks destructive but is missing annotations.destructiveHint=true`,
        tool: tool.name,
      });
    }
  }
  return findings;
}

export function allCheckNames(): readonly string[] {
  return [
    "checkParamSources",
    "checkCircularDependencies",
    "checkOrphanTools",
    "checkDescriptions",
    "checkReturnSchema",
    "checkPermissionGaps",
    "checkOverlyBroad",
    "checkDestructiveAnnotations",
  ];
}
