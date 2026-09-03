// Use cases: saved requests against an agent.
//
// THE PROMOTION AND THE DEMOTION ARE ONE TRANSACTION, FILTERED BY BOTH IDS. A
// template promoted to default must demote the incumbent, and the incumbent is
// the default OF THE SAME AGENT in the same environment. Demoting by environment
// alone — one missing clause — silently clears the default template of every
// other agent there, with no error and nothing an operator would notice until
// the next time they opened a different agent. `defaultsToDemote` takes both
// ids, and this file passes both.
//
// A TEMPLATE NAMES AN AGENT THAT MUST BE BOUND HERE. Checked before the write,
// not left to the foreign key: `PostmanTemplate.agentId` points at an `Agent`,
// which is project-scoped, so the key alone would accept an agent that this
// environment does not serve and produce a saved request that can never run.

import { err, ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  admitTemplate,
  applyTemplatePatch,
  asAgentsIdentifier,
  byTemplateOrder,
  demote,
  defaultsToDemote,
  templateNotFound,
  type ActorId,
  type AgentId,
  type JsonObject,
  type PostmanTemplate,
  type PostmanTemplateId,
  type TemplatePatch,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { AgentsDependencies } from "./dependencies.js";
import type { TemplatePage } from "./ports/index.js";
import { requireBound } from "./read-agents.js";

export interface TemplateQueryBase {
  readonly authorization: unknown;
}

export interface PageTemplatesQuery extends TemplateQueryBase {
  readonly limit: number;
  readonly offset: number;
  readonly agentId?: AgentId | null;
  readonly search?: string | null;
}

export interface DescribeTemplateQuery extends TemplateQueryBase {
  readonly templateId: PostmanTemplateId;
}

export interface CreateTemplateCommand extends TemplateQueryBase {
  readonly agentId: AgentId;
  readonly name: string;
  readonly simulateUserId: string;
  readonly sessionContext?: JsonObject | null;
  readonly isDefault?: boolean;
  readonly createdBy: string;
}

export interface UpdateTemplateCommand extends DescribeTemplateQuery, TemplatePatch {}

export async function pageTemplates(
  dependencies: AgentsDependencies,
  query: PageTemplatesQuery,
): Promise<Result<TemplatePage>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const search = query.search?.trim();
  return dependencies.scaffolding.pageTemplates(granted.value.scope, {
    limit: Math.min(Math.max(Math.trunc(query.limit), 1), dependencies.policy.maxPageSize),
    offset: Math.max(Math.trunc(query.offset), 0),
    agentId: query.agentId ?? null,
    search: search === undefined || search === "" ? null : search,
  });
}

export async function describeTemplate(
  dependencies: AgentsDependencies,
  query: DescribeTemplateQuery,
): Promise<Result<PostmanTemplate>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const held = await dependencies.scaffolding.findTemplate(granted.value.scope, query.templateId);
  if (!held.ok) return err(held.error);
  if (held.value === null) return err(templateNotFound(query.templateId));
  return ok(held.value);
}

export async function createTemplate(
  dependencies: AgentsDependencies,
  command: CreateTemplateCommand,
): Promise<Result<PostmanTemplate>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const admitted = admitTemplate(command);
  if (!admitted.ok) return err(admitted.error);
  const bound = await requireBound(dependencies, scope, command.agentId);
  if (!bound.ok) return err(bound.error);

  const now = dependencies.clock.now();
  const template: PostmanTemplate = {
    templateId: asAgentsIdentifier<PostmanTemplateId>(dependencies.ids.uuid()),
    environmentId: scope.environmentId,
    agentId: command.agentId,
    name: admitted.value.name,
    simulateUserId: admitted.value.simulateUserId,
    sessionContext: admitted.value.sessionContext,
    isDefault: admitted.value.isDefault,
    createdBy: asAgentsIdentifier<ActorId>(command.createdBy),
    createdAt: now,
    updatedAt: now,
  };

  return dependencies.unitOfWork.run(async (transaction) => {
    if (template.isDefault) {
      const demoted = await demoteIncumbents(dependencies, scope, command.agentId, null, now, transaction);
      if (!demoted.ok) return err(demoted.error);
    }
    return dependencies.scaffolding.insertTemplate(template, transaction);
  });
}

export async function updateTemplate(
  dependencies: AgentsDependencies,
  command: UpdateTemplateCommand,
): Promise<Result<PostmanTemplate>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const found = await dependencies.scaffolding.findTemplate(scope, command.templateId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(templateNotFound(command.templateId));
  const held = found.value;

  const now = dependencies.clock.now();
  const patched = applyTemplatePatch(held, command, now);
  return dependencies.unitOfWork.run(async (transaction) => {
    if (command.isDefault === true) {
      const demoted = await demoteIncumbents(
        dependencies,
        scope,
        held.agentId,
        held.templateId,
        now,
        transaction,
      );
      if (!demoted.ok) return err(demoted.error);
    }
    return dependencies.scaffolding.updateTemplate(patched, transaction);
  });
}

export async function removeTemplate(
  dependencies: AgentsDependencies,
  query: DescribeTemplateQuery,
): Promise<Result<boolean>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;
  return dependencies.unitOfWork.run((transaction) =>
    dependencies.scaffolding.deleteTemplate(scope, query.templateId, transaction),
  );
}

/** The default template for one agent, or null when it has none. */
export async function listTemplatesForAgent(
  dependencies: AgentsDependencies,
  query: TemplateQueryBase & { readonly agentId: AgentId },
): Promise<Result<readonly PostmanTemplate[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const listed = await dependencies.scaffolding.listTemplatesFor(granted.value.scope, query.agentId);
  if (!listed.ok) return err(listed.error);
  return ok([...listed.value].sort(byTemplateOrder));
}

async function demoteIncumbents(
  dependencies: AgentsDependencies,
  scope: EnvironmentScope,
  agentId: AgentId,
  excluding: PostmanTemplateId | null,
  now: Date,
  transaction: TransactionScope,
): Promise<Result<number>> {
  const held = await dependencies.scaffolding.listTemplatesFor(scope, agentId);
  if (!held.ok) return err(held.error);
  const incumbents = defaultsToDemote(held.value, scope.environmentId, agentId, excluding);
  for (const incumbent of incumbents) {
    const written = await dependencies.scaffolding.updateTemplate(demote(incumbent, now), transaction);
    if (!written.ok) return err(written.error);
  }
  return ok(incumbents.length);
}
