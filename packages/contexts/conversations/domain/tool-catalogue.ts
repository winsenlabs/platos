// The tools a turn is offered, and where every one of them comes from.
//
// THE BIGGEST SINGLE DECISION IN THIS EXTRACTION IS RECORDED HERE. The source's
// `buildMetaTools` is a 2,675-line private method that DEFINES thirty-odd tools
// inline — their JSON Schemas, their handlers, their Prisma reads, their Redis
// gates, their durable dispatches — and hands the finished map to the model. It
// is the single largest reason the turn engine is 7,121 lines.
//
// NOT ONE OF THOSE DEFINITIONS BELONGS TO `conversations`. ADR M0.3 §1 row 16
// makes this context "the turn-execution engine", orchestrating "purely through
// downstream ports", and it makes other contexts the sole writers of every row
// those handlers touch. Re-declaring them here would mean this context reading
// `Memory`, writing `ToolCallAudit`, and dispatching `Job` — three rows it is
// not the writer of, from a context nobody is permitted to import.
//
// SO THE CATALOGUE IS ASSEMBLED, NOT AUTHORED, and this table is the map from
// each of the source's meta-tools to the context that owns it now. It is DATA so
// the claim can be read and checked rather than asserted in prose:

import { err, ok, type Result } from "@platos/kernel";

import { toolCatalogueExceeded, toolNotOffered } from "./errors.js";

export const TOOL_SOURCES = ["tools", "skills", "memory", "jobs", "agents", "files"] as const;

export type ToolSource = (typeof TOOL_SOURCES)[number];

/**
 * Where each of the source's meta-tools went.
 *
 * `find_tools` and `execute_tools` are the discovery pair and belong to the
 * registry and the four-tier gate (§1 row 12). `remember`, `recall`, `forget`,
 * `list_memories`, `relate`, `memory_extract`, `update_user_profile` and
 * `recall_user_profile` are all `Memory`, `MemoryEntity` and
 * `MemoryRelationship` operations (row 11). `spawn_job`, `agent_batch`,
 * `dispatch_job`, `spawn_batch`, `wait_for_runs`, `get_run_details`,
 * `cancel_run`, `create_schedule`, `schedule_job`, `replay_run`,
 * `cancel_schedule`, `list_schedules` and `list_jobs` are `Job` and the durable
 * seam (row 15); `request_approval` and `request_durable_approval` are
 * `AgentApproval`, the same row's suspension seam. `spawn_agent` and
 * `delegate_to_sub_agent` are the two that stay HERE, because delegating is
 * running another turn and that is this context's own work — `sub-agent.ts`
 * owns their ceilings.
 *
 * A NAME NOT IN THIS TABLE IS NOT A REFUSAL. The table records the extraction
 * decision for the source's own set; an installation may offer any tool at all,
 * and the catalogue this context builds is whatever its peers answer with.
 */
export const META_TOOL_OWNERS: Readonly<Record<string, ToolSource>> = Object.freeze({
  find_tools: "tools",
  execute_tools: "tools",
  remember: "memory",
  recall: "memory",
  forget: "memory",
  list_memories: "memory",
  relate: "memory",
  memory_extract: "memory",
  update_user_profile: "memory",
  recall_user_profile: "memory",
  spawn_job: "jobs",
  agent_batch: "jobs",
  dispatch_job: "jobs",
  spawn_batch: "jobs",
  wait_for_runs: "jobs",
  get_run_details: "jobs",
  cancel_run: "jobs",
  create_schedule: "jobs",
  schedule_job: "jobs",
  replay_run: "jobs",
  cancel_schedule: "jobs",
  list_schedules: "jobs",
  list_jobs: "jobs",
  request_approval: "jobs",
  request_durable_approval: "jobs",
  generate_artifact: "files",
  revise_artifact: "files",
});

/**
 * One tool as this turn will offer it.
 *
 * `source` is carried so a refusal can name who declined and so a caller can see
 * which peer a catalogue came from. It is NOT sent to the model.
 */
export interface OfferedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly source: ToolSource;
}

/**
 * The catalogue for one turn: the tools, indexed by name.
 *
 * A `Map` rather than an array because the one operation the turn loop performs
 * on it thousands of times is "was this name offered", and that check is the
 * authorization decision for every tool call the model makes.
 */
export interface ToolCatalogue {
  readonly tools: readonly OfferedTool[];
  readonly byName: ReadonlyMap<string, OfferedTool>;
}

export const EMPTY_TOOL_CATALOGUE: ToolCatalogue = Object.freeze({
  tools: Object.freeze([]),
  byName: new Map(),
});

/**
 * Assemble a turn's catalogue, or refuse it.
 *
 * TWO RULES, AND THE FIRST ONE IS SILENT ON PURPOSE. A name offered twice —
 * which happens the moment a skill and a registered tool agree on one — keeps
 * the FIRST offer and drops the second, exactly as the source does when it
 * "skips name collisions". Refusing instead would let one badly named skill
 * disable an agent's whole catalogue, and the model cannot be given two tools
 * with one name in any case. The second rule is a ceiling and is a refusal,
 * because every tool in a catalogue is prompt an installation pays for on every
 * step and an unbounded catalogue is an unbounded bill.
 */
export function buildToolCatalogue(
  offers: readonly OfferedTool[],
  maxTools: number,
): Result<ToolCatalogue> {
  const byName = new Map<string, OfferedTool>();
  for (const offer of offers) {
    if (!byName.has(offer.name)) byName.set(offer.name, offer);
  }
  if (byName.size > maxTools) return err(toolCatalogueExceeded(byName.size, maxTools));
  return ok(Object.freeze({ tools: Object.freeze([...byName.values()]), byName }));
}

/**
 * The authorization check for one tool call.
 *
 * THE CATALOGUE IS THE DECISION. A name in it has been through whatever gate its
 * owner applies — `tools`' four tiers, `skills`' enablement, this context's own
 * delegation ceilings — and a name that is not in it has been through none of
 * them. So a model asking for an unoffered tool is refused here rather than
 * dispatched and refused downstream, and the refusal is `forbidden` rather than
 * `not_found`: the tool may well exist, and this turn was not given it.
 */
export function requireOffered(catalogue: ToolCatalogue, toolName: string): Result<OfferedTool> {
  const offered = catalogue.byName.get(toolName);
  if (offered === undefined) return err(toolNotOffered(toolName));
  return ok(offered);
}
