// The second half of the shared scenario: `ScaffoldingRepository`.
//
// Split from `agents-conformance.ts` because the ports are split, and for the
// reason the port itself gives: `Macro` and `PostmanTemplate` are the two rows a
// SURFACE writes on its own behalf rather than as part of an agent's version
// history, and neither participates in the version/binding invariant every
// method on the other port has to respect. Keeping the two scenarios apart is
// what stops a step from quietly acquiring it — and keeps both files inside the
// ADR M0.3 §6 budget.
//
// THE MACRO GATE IS EXERCISED FROM BOTH SIDES. A macro this caller wrote, a
// macro somebody else shared, and a macro somebody else did not share, listed
// with an actor and listed without one. That is the cheap half of the gate, the
// half the STORE is responsible for, and it is the half a SQL predicate and a
// JavaScript filter can most easily disagree about.

import type {
  ActorId,
  AgentId,
  EnvironmentScope,
  Macro,
  PostmanTemplate,
  Result,
  ScaffoldingRepository,
  UnitOfWork,
} from "@platos/context-agents/application/ports/index.js";
import type { Observation } from "./agents-conformance.js";

export interface ScaffoldingScenarioIds {
  readonly ownMacro: string;
  readonly sharedMacro: string;
  readonly privateMacro: string;
  readonly peerMacro: string;
  readonly clashingMacro: string;
  readonly defaultTemplate: string;
  readonly plainTemplate: string;
  readonly clashingTemplate: string;
}

export interface ScaffoldingScenarioStores {
  readonly scaffolding: ScaffoldingRepository;
  readonly unitOfWork: UnitOfWork;
  /** An agent that already exists in the home scope, for the templates. */
  readonly agentId: string;
}

const AT = new Date("2026-05-01T09:00:00.000Z");
const LATER = new Date("2026-05-02T09:00:00.000Z");
const OWNER = "operator-1";
const OTHER = "operator-2";

/**
 * Tag an already-provenanced string.
 *
 * `asAgentsIdentifier` is the domain's own assertion and takes a branded target;
 * every identifier below is one, but naming each brand at each call site would be
 * forty annotations for one decision. This narrows once, here, and is the only
 * unchecked cast in the module.
 */
function tag<Id extends string>(value: string): Id {
  return value as unknown as Id;
}

function outcome(result: Result<unknown>): unknown {
  if (result.ok) return { ok: true, value: result.value };
  return {
    ok: false,
    code: result.error.code,
    category: result.error.category,
    details: result.error.details,
  };
}

export async function runScaffoldingScenario(
  stores: ScaffoldingScenarioStores,
  ids: ScaffoldingScenarioIds,
  scopes: { readonly home: EnvironmentScope; readonly peer: EnvironmentScope },
): Promise<readonly Observation[]> {
  const seen: Observation[] = [];
  const record = (step: string, value: unknown): void => {
    seen.push({ step, value });
  };
  const { scaffolding, unitOfWork } = stores;

  const macro = (id: string, name: string, createdBy: string, shared: boolean, scope: EnvironmentScope, updatedAt: Date): Macro => ({
    macroId: tag(id),
    environmentId: scope.environmentId,
    name,
    description: null,
    steps: [{ tool: "send", params: { to: "${user.email}" } }],
    paramSchema: null,
    sharedWithOrganization: shared,
    createdBy: tag(createdBy),
    createdAt: AT,
    updatedAt,
  });

  const own = macro(ids.ownMacro, "own", OWNER, false, scopes.home, AT);
  const shared = macro(ids.sharedMacro, "shared", OTHER, true, scopes.home, LATER);
  const hidden = macro(ids.privateMacro, "hidden", OTHER, false, scopes.home, LATER);
  const elsewhere = macro(ids.peerMacro, "elsewhere", OWNER, true, scopes.peer, LATER);

  await unitOfWork.run(async (transaction) => {
    for (const row of [own, shared, hidden, elsewhere]) {
      record(`insertMacro ${row.name}`, outcome(await scaffolding.insertMacro(row, transaction)));
    }
  });
  record(
    "listMacros for the owner",
    outcome(await scaffolding.listMacros(scopes.home, { limit: 10, actorId: tag<ActorId>(OWNER) })),
  );
  record(
    "listMacros unattributed",
    outcome(await scaffolding.listMacros(scopes.home, { limit: 10, actorId: null })),
  );
  record(
    "listMacros for somebody else",
    outcome(await scaffolding.listMacros(scopes.home, { limit: 10, actorId: tag<ActorId>(OTHER) })),
  );
  record(
    "listMacros honours the limit",
    outcome(await scaffolding.listMacros(scopes.home, { limit: 1, actorId: tag<ActorId>(OWNER) })),
  );
  // Ungated on purpose: the store answers with a macro this caller may not read,
  // so the use case can tell "not visible" from "visible but not yours".
  record("findMacro somebody else's", outcome(await scaffolding.findMacro(scopes.home, hidden.macroId)));
  record("findMacro in another environment", outcome(await scaffolding.findMacro(scopes.home, elsewhere.macroId)));

  await unitOfWork.run(async (transaction) => {
    record(
      "updateMacro",
      outcome(
        await scaffolding.updateMacro({ ...own, description: "changed", updatedAt: LATER }, transaction),
      ),
    );
    record(
      "deleteMacro from the wrong environment",
      outcome(await scaffolding.deleteMacro(scopes.peer, own.macroId, transaction)),
    );
    record("deleteMacro", outcome(await scaffolding.deleteMacro(scopes.home, own.macroId, transaction)));
    record(
      "deleteMacro again",
      outcome(await scaffolding.deleteMacro(scopes.home, own.macroId, transaction)),
    );
  });

  const agentId = tag<AgentId>(stores.agentId);
  const template = (id: string, name: string, isDefault: boolean, updatedAt: Date): PostmanTemplate => ({
    templateId: tag(id),
    environmentId: scopes.home.environmentId,
    agentId,
    name,
    simulateUserId: "simulated-1",
    sessionContext: null,
    isDefault,
    createdBy: tag(OWNER),
    createdAt: AT,
    updatedAt,
  });

  const plain = template(ids.plainTemplate, "plain", false, LATER);
  const preferred = template(ids.defaultTemplate, "preferred", true, AT);
  await unitOfWork.run(async (transaction) => {
    record("insertTemplate plain", outcome(await scaffolding.insertTemplate(plain, transaction)));
    record("insertTemplate default", outcome(await scaffolding.insertTemplate(preferred, transaction)));
  });
  // Defaults first, THEN recency — `preferred` is older than `plain` and still
  // leads, which is the whole of `byTemplateOrder`'s first clause.
  record(
    "pageTemplates order",
    outcome(
      await scaffolding.pageTemplates(scopes.home, { limit: 10, offset: 0, agentId: null, search: null }),
    ),
  );
  record(
    "pageTemplates second page",
    outcome(
      await scaffolding.pageTemplates(scopes.home, { limit: 1, offset: 1, agentId: null, search: null }),
    ),
  );
  record(
    "pageTemplates by search",
    outcome(
      await scaffolding.pageTemplates(scopes.home, {
        limit: 10,
        offset: 0,
        agentId: null,
        search: "PLAI",
      }),
    ),
  );
  record(
    "pageTemplates for one agent",
    outcome(
      await scaffolding.pageTemplates(scopes.home, { limit: 10, offset: 0, agentId, search: null }),
    ),
  );
  record("listTemplatesFor", outcome(await scaffolding.listTemplatesFor(scopes.home, agentId)));
  record("findTemplate", outcome(await scaffolding.findTemplate(scopes.home, plain.templateId)));
  record(
    "findTemplate in another environment",
    outcome(await scaffolding.findTemplate(scopes.peer, plain.templateId)),
  );

  await unitOfWork.run(async (transaction) => {
    record(
      "updateTemplate demoting the default",
      outcome(
        await scaffolding.updateTemplate({ ...preferred, isDefault: false, updatedAt: LATER }, transaction),
      ),
    );
    record(
      "deleteTemplate from the wrong environment",
      outcome(await scaffolding.deleteTemplate(scopes.peer, plain.templateId, transaction)),
    );
    record(
      "deleteTemplate",
      outcome(await scaffolding.deleteTemplate(scopes.home, plain.templateId, transaction)),
    );
  });
  record(
    "pageTemplates after the delete",
    outcome(
      await scaffolding.pageTemplates(scopes.home, { limit: 10, offset: 0, agentId: null, search: null }),
    ),
  );

  // THE TWO KNOWN DIVERGENCES ARE LAST, AND THAT IS NOT TIDINESS. The double
  // carries no unique index, so it ACCEPTS both of these writes and PostgreSQL
  // refuses them — after which the two stores hold different rows and every
  // later step would diverge for a reason that is not its own. They are pinned
  // from both sides in `agents-conformance.integration.test.ts`; they run here
  // where nothing observes the state they leave behind.
  await unitOfWork.run(async (transaction) => {
    record(
      "insertMacro with a name already taken in this environment",
      outcome(
        await scaffolding.insertMacro(
          { ...shared, macroId: tag(ids.clashingMacro), createdBy: tag<ActorId>(OWNER) },
          transaction,
        ),
      ),
    );
    record(
      "insertTemplate with a name already taken for this agent",
      outcome(
        await scaffolding.insertTemplate(
          { ...preferred, templateId: tag(ids.clashingTemplate) },
          transaction,
        ),
      ),
    );
  });

  return seen;
}
