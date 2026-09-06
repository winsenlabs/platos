// The PostgreSQL `ScaffoldingRepository` — `Macro` and `PostmanTemplate`.
//
// THE MACRO GATE IS SPLIT AND THIS STORE HOLDS THE CHEAP HALF, exactly as the
// port says: same environment, and either this caller's own or shared. Both
// halves are index-backed predicates, so they belong in the WHERE clause. The
// expensive half — `macroAccessFor`, which decides on the row that came back —
// is the use case's, and a store that pre-filtered on it would collapse "not
// visible" and "visible but not yours" into one answer and lose the distinction
// the error catalogue keeps.
//
// `findMacro` IS UNGATED ON PURPOSE, and that is not the same as unscoped. The
// environment filter is still there; the owner/shared filter is not, because the
// use case needs the row in order to tell those two answers apart.
//
// TWO UNIQUE INDEXES HERE ARE INVISIBLE TO THE IN-MEMORY DOUBLE.
// `@@unique([environmentId, name])` on `Macro` and
// `@@unique([environmentId, agentId, name])` on `PostmanTemplate` are both real
// and neither is enforced by `InMemoryScaffolding`, so a use case that writes a
// second macro under a name already taken passes every suite in the tree and is
// refused here. Both refusals carry their own reason.
//
// AND ONE RULE IS INVISIBLE TO IT TOO. `PostmanTemplate_ancestry` requires the
// template's agent to belong to the environment's PROJECT, so a template written
// against an agent from a neighbouring project is refused by the database and
// accepted by the double.

import type {
  AgentId,
  EnvironmentScope,
  Macro,
  MacroId,
  MacroQuery,
  PostmanTemplate,
  PostmanTemplateId,
  Result,
  ScaffoldingRepository,
  TemplatePage,
  TemplateQuery,
  TransactionScope,
} from "@platos/context-agents/application/ports/index.js";
import { err, ok } from "@platos/context-agents/application/ports/index.js";

import {
  CHECK_VIOLATION,
  checkRefusal,
  MACRO_NAME_TAKEN,
  namesConstraint,
  refusable,
  refused,
  sqlstateOf,
  TEMPLATE_NAME_TAKEN,
  UNIQUE_VIOLATION,
} from "./agents-guards.js";
import { nullableJson } from "./client.js";
import type { MacroRow, PostmanTemplateRow } from "./agents-rows.js";
import { MACRO_COLUMNS, TEMPLATE_COLUMNS, toMacro, toTemplate } from "./agents-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** `byMacroOrder`: most recently updated first, then by id descending. */
const MACRO_ORDER = [{ updatedAt: "desc" }, { id: "desc" }] as const;

/** `byTemplateOrder`: defaults first, then recency, then id descending. */
const TEMPLATE_ORDER = [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }] as const;

/** The macro row this store refuses to overwrite, and why. */
export const MACRO_MISSING = "macro_missing";
export const TEMPLATE_MISSING = "template_missing";

function named(reason: string, constraint: string) {
  return (error: unknown) => {
    if (sqlstateOf(error) === UNIQUE_VIOLATION && namesConstraint(error, constraint)) {
      return refused(reason);
    }
    if (sqlstateOf(error) === CHECK_VIOLATION) {
      const check = checkRefusal(error);
      return check === null ? null : refused(check);
    }
    return null;
  };
}

const macroRefusal = named(MACRO_NAME_TAKEN, "environmentId,name");
const templateRefusal = named(TEMPLATE_NAME_TAKEN, "environmentId,agentId,name");

export function createScaffoldingRepository(
  transactions: TenancyTransactions,
): ScaffoldingRepository {
  const macroData = (macro: Macro) => ({
    environmentId: macro.environmentId,
    name: macro.name,
    description: macro.description,
    steps: macro.steps as never,
    paramSchema: nullableJson(macro.paramSchema) as never,
    sharedWithOrganization: macro.sharedWithOrganization,
    createdBy: macro.createdBy,
    updatedAt: macro.updatedAt,
  });

  const templateData = (template: PostmanTemplate) => ({
    environmentId: template.environmentId,
    agentId: template.agentId,
    name: template.name,
    simulateUserId: template.simulateUserId,
    sessionContext: nullableJson(template.sessionContext) as never,
    isDefault: template.isDefault,
    createdBy: template.createdBy,
    updatedAt: template.updatedAt,
  });

  return {
    async listMacros(
      scope: EnvironmentScope,
      query: MacroQuery,
    ): Promise<Result<readonly Macro[]>> {
      const visible =
        query.actorId === null
          ? { sharedWithOrganization: true }
          : { OR: [{ createdBy: query.actorId as string }, { sharedWithOrganization: true }] };
      const rows = (await transactions.reader().macro.findMany({
        where: { environmentId: scope.environmentId, ...visible },
        orderBy: [...MACRO_ORDER],
        select: MACRO_COLUMNS,
        take: query.limit,
      })) as MacroRow[];
      return ok(rows.map(toMacro));
    },

    async findMacro(scope: EnvironmentScope, macroId: MacroId): Promise<Result<Macro | null>> {
      const row = (await transactions
        .reader()
        .macro.findFirst({
          where: { id: macroId, environmentId: scope.environmentId },
          select: MACRO_COLUMNS,
        })) as MacroRow | null;
      return ok(row === null ? null : toMacro(row));
    },

    async insertMacro(macro: Macro, transaction: TransactionScope): Promise<Result<Macro>> {
      const client = transactions.writer(transaction);
      const written = await refusable(
        client,
        () => client.macro.create({ data: { id: macro.macroId, createdAt: macro.createdAt, ...macroData(macro) } }),
        macroRefusal,
      );
      return written.ok ? ok(toMacro(written.value as MacroRow)) : err(written.error);
    },

    async updateMacro(macro: Macro, transaction: TransactionScope): Promise<Result<Macro>> {
      const client = transactions.writer(transaction);
      const written = await refusable(
        client,
        () => client.macro.updateManyAndReturn({ where: { id: macro.macroId }, data: macroData(macro) }),
        macroRefusal,
      );
      if (!written.ok) return err(written.error);
      const row = (written.value as MacroRow[])[0];
      return row === undefined ? err(refused(MACRO_MISSING)) : ok(toMacro(row));
    },

    async deleteMacro(
      scope: EnvironmentScope,
      macroId: MacroId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      const removed = await transactions
        .writer(transaction)
        .macro.deleteMany({ where: { id: macroId, environmentId: scope.environmentId } });
      return ok(removed.count > 0);
    },

    async findTemplate(
      scope: EnvironmentScope,
      templateId: PostmanTemplateId,
    ): Promise<Result<PostmanTemplate | null>> {
      const row = (await transactions.reader().postmanTemplate.findFirst({
        where: { id: templateId, environmentId: scope.environmentId },
        select: TEMPLATE_COLUMNS,
      })) as PostmanTemplateRow | null;
      return ok(row === null ? null : toTemplate(row));
    },

    async pageTemplates(
      scope: EnvironmentScope,
      query: TemplateQuery,
    ): Promise<Result<TemplatePage>> {
      const term = query.search;
      const where = {
        environmentId: scope.environmentId,
        ...(query.agentId === null ? {} : { agentId: query.agentId }),
        ...(term === null
          ? {}
          : {
              OR: [
                { name: { contains: term, mode: "insensitive" as const } },
                { simulateUserId: { contains: term, mode: "insensitive" as const } },
              ],
            }),
      };
      const [rows, total] = await Promise.all([
        transactions.reader().postmanTemplate.findMany({
          where,
          orderBy: [...TEMPLATE_ORDER],
          select: TEMPLATE_COLUMNS,
          skip: query.offset,
          take: query.limit,
        }) as Promise<PostmanTemplateRow[]>,
        transactions.reader().postmanTemplate.count({ where }),
      ]);
      return ok({ items: rows.map(toTemplate), total });
    },

    async listTemplatesFor(
      scope: EnvironmentScope,
      agentId: AgentId,
    ): Promise<Result<readonly PostmanTemplate[]>> {
      const rows = (await transactions.reader().postmanTemplate.findMany({
        where: { environmentId: scope.environmentId, agentId },
        orderBy: [...TEMPLATE_ORDER],
        select: TEMPLATE_COLUMNS,
      })) as PostmanTemplateRow[];
      return ok(rows.map(toTemplate));
    },

    async insertTemplate(
      template: PostmanTemplate,
      transaction: TransactionScope,
    ): Promise<Result<PostmanTemplate>> {
      const client = transactions.writer(transaction);
      const written = await refusable(
        client,
        () =>
          client.postmanTemplate.create({
            data: { id: template.templateId, createdAt: template.createdAt, ...templateData(template) },
          }),
        templateRefusal,
      );
      return written.ok ? ok(toTemplate(written.value as PostmanTemplateRow)) : err(written.error);
    },

    async updateTemplate(
      template: PostmanTemplate,
      transaction: TransactionScope,
    ): Promise<Result<PostmanTemplate>> {
      const client = transactions.writer(transaction);
      const written = await refusable(
        client,
        () =>
          client.postmanTemplate.updateManyAndReturn({
            where: { id: template.templateId },
            data: templateData(template),
          }),
        templateRefusal,
      );
      if (!written.ok) return err(written.error);
      const row = (written.value as PostmanTemplateRow[])[0];
      return row === undefined ? err(refused(TEMPLATE_MISSING)) : ok(toTemplate(row));
    },

    async deleteTemplate(
      scope: EnvironmentScope,
      templateId: PostmanTemplateId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      const removed = await transactions.writer(transaction).postmanTemplate.deleteMany({
        where: { id: templateId, environmentId: scope.environmentId },
      });
      return ok(removed.count > 0);
    },
  };
}
