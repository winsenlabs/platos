// Use case: create an agent.
//
// Three rows in one transaction, in this order and no other: the `Agent`, its
// first `AgentVersion`, and the `AgentBinding` that makes it present in this
// environment. The binding points at the version, and the version belongs to the
// agent, so any other order writes a foreign key before its target.
//
// THE SLUG IS RESOLVED AGAINST THE WHOLE PROJECT, NOT THIS ENVIRONMENT.
// `@@unique([projectId, slug])` is a project constraint. Checking it against the
// agents bound HERE would let two environments in the same project both find a
// slug free and both write it, and the second would fail at the index with a
// message an operator cannot act on. See `listProjectSlugs` on the repository
// port.
//
// THE MODEL COMES FROM THE ROUTING TABLE WHEN THE REQUEST NAMES NONE. An
// operator who defined routes and no top-level model plainly meant the default
// route's model, and the source resolves it that way. What is NOT preserved is
// resolving it from `modelRoutes[0]` when no route is marked default and the
// caller supplied them in an arbitrary order — `defaultRoute` states that
// fallback in one place, so it is the same rule everywhere rather than three
// copies that drifted.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitAgent,
  admitNote,
  admitRoutes,
  admitSlug,
  agentAlreadyExists,
  asAgentsIdentifier,
  buildSnapshot,
  INITIAL_VERSION_NOTE,
  modelFromRoutes,
  nextVersionNumber,
  normalizeToolsBlockConfig,
  readPromptBlocks,
  resolveSlug,
  serializePromptBlocks,
  type ActorId,
  type AgentBinding,
  type AgentBindingId,
  type Agent,
  type AgentId,
  type AgentVersion,
  type AgentVersionId,
  type RouteIntake,
  type SkillAssignment,
  type ToolDefaultPolicy,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { AgentsDependencies } from "./dependencies.js";
import type { BoundAgent } from "./ports/index.js";
import { snapshotSourceFrom, type AgentConfigurationIntake } from "./configuration.js";

export interface CreateAgentCommand extends AgentConfigurationIntake {
  readonly authorization: unknown;
  readonly name: string;
  readonly slug?: string | null;
  readonly description?: string | null;
  readonly createdBy: string;
  readonly modelRoutes?: readonly RouteIntake[];
  /** The loadout the first version carries. Empty unless a caller names one. */
  readonly loadout?: readonly SkillAssignment[];
  readonly toolDefaultPolicy?: ToolDefaultPolicy;
}

/**
 * A new agent's first version is numbered from an EMPTY history, which is
 * `nextVersionNumber([])` and therefore 1. Stated through the same function the
 * update path uses rather than as a literal, so the two cannot disagree about
 * where numbering starts.
 */
export const FIRST_VERSION_NUMBER = nextVersionNumber([]);

export async function createAgent(
  dependencies: AgentsDependencies,
  command: CreateAgentCommand,
): Promise<Result<BoundAgent>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const admitted = admitAgent({ name: command.name, description: command.description });
  if (!admitted.ok) return err(admitted.error);
  const baseSlug = admitSlug(admitted.value.name, command.slug);
  if (!baseSlug.ok) return err(baseSlug.error);
  const note = admitNote(INITIAL_VERSION_NOTE);
  if (!note.ok) return err(note.error);

  const routes = command.modelRoutes === undefined ? null : admitRoutes(command.modelRoutes);
  if (routes !== null && !routes.ok) return err(routes.error);
  const routeTable = routes === null ? null : routes.value;

  const taken = await dependencies.repository.listProjectSlugs(scope.projectId);
  if (!taken.ok) return err(taken.error);

  const now = dependencies.clock.now();
  const slug = resolveSlug(baseSlug.value, taken.value, now);
  // The one-round rule in `resolveSlug` can still land on a taken slug when two
  // agents are created in the same millisecond. Refusing here, rather than
  // letting the index refuse, is what turns an opaque constraint violation into
  // a sentence an operator can act on.
  if (taken.value.includes(slug)) {
    return err(agentAlreadyExists(scope.projectId, slug));
  }

  const snapshot = buildSnapshot(
    snapshotSourceFrom(command, {
      model: command.model ?? (routeTable === null ? null : modelFromRoutes(routeTable)),
      modelRoutes: routeTable,
      systemPrompt: derivedSystemPrompt(command),
      toolsBlockConfig: normalizeToolsBlockConfig(command.toolsBlockConfig) ?? null,
    }),
    dependencies.policy.defaults,
  );

  const agent: Agent = {
    agentId: asAgentsIdentifier<AgentId>(dependencies.ids.uuid()),
    projectId: scope.projectId,
    name: admitted.value.name,
    slug,
    description: admitted.value.description,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  const version: AgentVersion = {
    agentVersionId: asAgentsIdentifier<AgentVersionId>(dependencies.ids.uuid()),
    agentId: agent.agentId,
    versionNumber: FIRST_VERSION_NUMBER,
    toolDefaultPolicy: command.toolDefaultPolicy ?? "ALL",
    note: note.value,
    createdBy: asAgentsIdentifier<ActorId>(command.createdBy),
    createdAt: now,
    snapshot,
  };
  const binding: AgentBinding = {
    agentBindingId: asAgentsIdentifier<AgentBindingId>(dependencies.ids.uuid()),
    environmentId: scope.environmentId,
    agentId: agent.agentId,
    activeVersionId: version.agentVersionId,
    canaryVersionId: null,
    clusterId: null,
    canaryPercent: 0,
    createdAt: now,
    updatedAt: now,
  };

  return dependencies.unitOfWork.run(async (transaction) => {
    const writtenAgent = await dependencies.repository.insertAgent(agent, transaction);
    if (!writtenAgent.ok) return err(writtenAgent.error);
    const writtenVersion = await dependencies.repository.insertVersion(version, transaction);
    if (!writtenVersion.ok) return err(writtenVersion.error);
    const loadout = await dependencies.repository.replaceLoadout(
      writtenVersion.value.agentVersionId,
      command.loadout ?? [],
      transaction,
    );
    if (!loadout.ok) return err(loadout.error);
    const writtenBinding = await dependencies.repository.insertBinding(binding, transaction);
    if (!writtenBinding.ok) return err(writtenBinding.error);
    return ok({
      agent: writtenAgent.value,
      binding: writtenBinding.value,
      activeVersion: writtenVersion.value,
      canaryVersion: null,
      cluster: null,
    });
  });
}

/**
 * The system prompt a create request lands with.
 *
 * An explicit prompt wins. Otherwise, blocks are serialized into one — which is
 * how an agent authored entirely in the block editor still has a system prompt
 * for every reader that has not learned about blocks. Neither present leaves it
 * null rather than an empty string, because an empty system prompt and no system
 * prompt render differently downstream.
 */
function derivedSystemPrompt(command: CreateAgentCommand): string | null {
  if (typeof command.systemPrompt === "string" && command.systemPrompt !== "") {
    return command.systemPrompt;
  }
  const blocks = readPromptBlocks(command.promptBlocks);
  if (blocks === null || blocks.length === 0) return null;
  const serialized = serializePromptBlocks(blocks);
  return serialized === "" ? null : serialized;
}
