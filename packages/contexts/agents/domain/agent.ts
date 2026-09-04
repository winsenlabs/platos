// `Agent` — the definition, and the one thing about it that is not versioned.
//
// An Agent row carries almost nothing: a project, a name, a slug, and whether it
// is active. Everything an operator edits — the model, the prompt, the tool
// configuration, the routing table — lives on an immutable `AgentVersion`, and
// which version is live in a given environment lives on an `AgentBinding`. That
// three-row split is the whole reason a canary can exist, and it is why this
// file is short.
//
// THE ROW HANGS OFF PROJECT, NOT ENVIRONMENT. `Agent.projectId` is the column,
// and `@@unique([projectId, slug])` is the constraint. One Agent is therefore
// visible to every environment in its project and is PRESENT in an environment
// only where a binding exists. Deleting an agent from an environment removes
// that binding; the Agent row survives, because another environment may still be
// serving it. It is deactivated only when the last binding is gone — the source's
// exact behaviour, and the reason `delete` here returns a two-part outcome
// rather than a boolean.

import { err, ok, type Result } from "@platos/kernel";

import { agentMetadataInvalid } from "./errors.js";
import type { ActorId, AgentId, Slug } from "./identifiers.js";
import type { ProjectId } from "@platos/kernel";

/** Ceiling on an operator-supplied agent name. */
export const MAX_AGENT_NAME_LENGTH = 200;

/** Ceiling on an operator-supplied description. */
export const MAX_AGENT_DESCRIPTION_LENGTH = 2_000;

export interface Agent {
  readonly agentId: AgentId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly slug: Slug;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What an operator supplies to name a new agent. */
export interface AgentIntake {
  readonly name: string;
  readonly description?: string | null;
}

export interface AdmittedAgent {
  readonly name: string;
  readonly description: string | null;
}

function bounded(value: string, field: string, maximum: number): Result<string> {
  const trimmed = value.trim();
  if (trimmed === "") {
    return err(
      agentMetadataInvalid(`${field} is required`, [
        { field, code: "required", message: `${field} is required` },
      ]),
    );
  }
  if (trimmed.length > maximum) {
    return err(
      agentMetadataInvalid(`${field} must be at most ${maximum} characters`, [
        { field, code: "too_long", message: `${field} must be at most ${maximum} characters` },
      ]),
    );
  }
  return ok(trimmed);
}

/**
 * Admit an intake.
 *
 * Every field is trimmed before it is judged, because the control surface trims
 * before it validates and an untrimmed name would otherwise derive a different
 * slug from its own trimmed twin.
 */
export function admitAgent(intake: AgentIntake): Result<AdmittedAgent> {
  const name = bounded(intake.name, "name", MAX_AGENT_NAME_LENGTH);
  if (!name.ok) return err(name.error);
  const supplied = intake.description;
  if (supplied === undefined || supplied === null || supplied.trim() === "") {
    return ok({ name: name.value, description: null });
  }
  const description = bounded(supplied, "description", MAX_AGENT_DESCRIPTION_LENGTH);
  if (!description.ok) return err(description.error);
  return ok({ name: name.value, description: description.value });
}

/** What changed on an agent's own row, as an operator supplied it. */
export interface AgentPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly isActive?: boolean;
}

export interface AdmittedAgentPatch {
  readonly name: string | null;
  readonly description: string | null | undefined;
  readonly isActive: boolean | null;
}

/**
 * Admit a patch.
 *
 * `description` carries three states and they are all different: absent leaves
 * the column alone, `null` clears it, and a string replaces it. Collapsing the
 * first two — the mistake a `?? null` makes — would erase a description on every
 * partial rename.
 */
export function admitAgentPatch(patch: AgentPatch): Result<AdmittedAgentPatch> {
  let name: string | null = null;
  if (patch.name !== undefined) {
    const admitted = bounded(patch.name, "name", MAX_AGENT_NAME_LENGTH);
    if (!admitted.ok) return err(admitted.error);
    name = admitted.value;
  }
  let description: string | null | undefined;
  if (patch.description === null) {
    description = null;
  } else if (patch.description !== undefined) {
    const admitted = bounded(patch.description, "description", MAX_AGENT_DESCRIPTION_LENGTH);
    if (!admitted.ok) return err(admitted.error);
    description = admitted.value;
  }
  return ok({ name, description, isActive: patch.isActive ?? null });
}

/** True when a patch changes nothing on the Agent row itself. */
export function touchesAgentRow(patch: AdmittedAgentPatch): boolean {
  return patch.name !== null || patch.description !== undefined || patch.isActive !== null;
}

export function applyAgentPatch(agent: Agent, patch: AdmittedAgentPatch, now: Date): Agent {
  return {
    ...agent,
    name: patch.name ?? agent.name,
    description: patch.description === undefined ? agent.description : patch.description,
    isActive: patch.isActive ?? agent.isActive,
    updatedAt: now,
  };
}

export function deactivate(agent: Agent, now: Date): Agent {
  return { ...agent, isActive: false, updatedAt: now };
}

/** Authorship, recorded on the versions an agent accumulates. */
export interface Authorship {
  readonly createdBy: ActorId;
}

/**
 * The listing order, transcribed exactly: newest first, then by id.
 *
 * The final id comparison is what makes the order TOTAL. Two agents created in
 * the same millisecond would otherwise come back in whatever order the store
 * felt like, and a paged listing whose order is not total silently drops and
 * repeats rows across pages. The source spells this `[{ createdAt: "desc" },
 * { id: "desc" }]` and the descending id tie-break is preserved here.
 */
export function byListingOrder(left: Agent, right: Agent): number {
  const byAge = right.createdAt.getTime() - left.createdAt.getTime();
  if (byAge !== 0) return byAge;
  if (left.agentId === right.agentId) return 0;
  return left.agentId > right.agentId ? -1 : 1;
}

