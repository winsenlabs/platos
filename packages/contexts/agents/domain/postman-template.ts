// `PostmanTemplate` — a saved request against one agent.
//
// A template names the end user a request should be simulated as, and the
// session context it should carry. It is the second half of "saved-request
// scaffolding" in ADR M0.3 §1 row 5, and unlike a macro it is scoped to a single
// agent as well as to an environment.
//
// THE SINGLE-DEFAULT INVARIANT IS PER `[environment, agent]`, NOT PER
// ENVIRONMENT. The store has no partial unique index for it; the running system
// demotes the incumbents with an update before it promotes, and it filters that
// update by agent. Getting the filter wrong would clear the default template of
// every OTHER agent in the environment on each save — a mistake with no error
// message and no way for an operator to notice until the next time they opened a
// different agent. `defaultsToDemote` takes both ids for exactly that reason.
//
// PROMOTION IS ONE-WAY THROUGH `isDefault: true`. Setting `isDefault: false` on
// the current default simply clears it and leaves the agent with none, which is
// the source's behaviour; there is no automatic succession. That is stated here
// so nobody adds one by accident while "fixing" the asymmetry.

import { err, ok, type EnvironmentId, type Result } from "@platos/kernel";

import { templateInvalid } from "./errors.js";
import type { ActorId, AgentId, PostmanTemplateId } from "./identifiers.js";
import type { JsonObject } from "./snapshot.js";

/** Ceiling on an operator-supplied template name. */
export const MAX_TEMPLATE_NAME_LENGTH = 200;

/** Ceiling on the simulated end-user identifier. */
export const MAX_SIMULATED_USER_LENGTH = 200;

export interface PostmanTemplate {
  readonly templateId: PostmanTemplateId;
  readonly environmentId: EnvironmentId;
  readonly agentId: AgentId;
  readonly name: string;
  readonly simulateUserId: string;
  readonly sessionContext: JsonObject | null;
  readonly isDefault: boolean;
  readonly createdBy: ActorId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TemplateIntake {
  readonly agentId: AgentId;
  readonly name: string;
  readonly simulateUserId: string;
  readonly sessionContext?: JsonObject | null;
  readonly isDefault?: boolean;
}

export interface AdmittedTemplate {
  readonly agentId: AgentId;
  readonly name: string;
  readonly simulateUserId: string;
  readonly sessionContext: JsonObject | null;
  readonly isDefault: boolean;
}

function bounded(value: string, field: string, maximum: number): Result<string> {
  const trimmed = value.trim();
  if (trimmed === "") {
    return err(
      templateInvalid(`${field} is required`, [
        { field, code: "required", message: `${field} is required` },
      ]),
    );
  }
  if (trimmed.length > maximum) {
    return err(
      templateInvalid(`${field} must be at most ${maximum} characters`, [
        { field, code: "too_long", message: `${field} must be at most ${maximum} characters` },
      ]),
    );
  }
  return ok(trimmed);
}

export function admitTemplate(intake: TemplateIntake): Result<AdmittedTemplate> {
  const name = bounded(intake.name, "name", MAX_TEMPLATE_NAME_LENGTH);
  if (!name.ok) return err(name.error);
  const simulateUserId = bounded(intake.simulateUserId, "simulateUserId", MAX_SIMULATED_USER_LENGTH);
  if (!simulateUserId.ok) return err(simulateUserId.error);
  return ok({
    agentId: intake.agentId,
    name: name.value,
    simulateUserId: simulateUserId.value,
    sessionContext: intake.sessionContext ?? null,
    isDefault: intake.isDefault === true,
  });
}

/** What changed on a template, as an operator supplied it. */
export interface TemplatePatch {
  readonly name?: string;
  readonly simulateUserId?: string;
  /** Absent leaves it, `null` clears it, an object replaces it. */
  readonly sessionContext?: JsonObject | null;
  readonly isDefault?: boolean;
}

export function applyTemplatePatch(
  template: PostmanTemplate,
  patch: TemplatePatch,
  now: Date,
): PostmanTemplate {
  return {
    ...template,
    name: patch.name ?? template.name,
    simulateUserId: patch.simulateUserId ?? template.simulateUserId,
    sessionContext: patch.sessionContext === undefined ? template.sessionContext : patch.sessionContext,
    isDefault: patch.isDefault ?? template.isDefault,
    updatedAt: now,
  };
}

export function demote(template: PostmanTemplate, now: Date): PostmanTemplate {
  return { ...template, isDefault: false, updatedAt: now };
}

/**
 * The templates that must lose `isDefault` for `promoted` to become the default
 * for its agent.
 *
 * Both ids are compared. See the note at the top of this file.
 */
export function defaultsToDemote(
  templates: readonly PostmanTemplate[],
  environmentId: EnvironmentId,
  agentId: AgentId,
  excluding: PostmanTemplateId | null = null,
): readonly PostmanTemplate[] {
  return templates.filter(
    (template) =>
      template.isDefault &&
      template.environmentId === environmentId &&
      template.agentId === agentId &&
      template.templateId !== excluding,
  );
}

export function findDefault(
  templates: readonly PostmanTemplate[],
  environmentId: EnvironmentId,
  agentId: AgentId,
): PostmanTemplate | null {
  return (
    templates.find(
      (template) =>
        template.isDefault && template.environmentId === environmentId && template.agentId === agentId,
    ) ?? null
  );
}

/**
 * The listing order, transcribed exactly: defaults first, then most recently
 * updated, then by id descending.
 */
export function byTemplateOrder(left: PostmanTemplate, right: PostmanTemplate): number {
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
  const byRecency = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (byRecency !== 0) return byRecency;
  if (left.templateId === right.templateId) return 0;
  return left.templateId > right.templateId ? -1 : 1;
}
