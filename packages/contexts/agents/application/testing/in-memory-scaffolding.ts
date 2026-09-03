// In-memory `ScaffoldingRepository`, `AgentVersionLock` and `MacroRecorder`.
//
// EACH ENFORCES THE PART OF ITS CONTRACT THE USE CASES RELY ON.
//
//   The scaffolding store applies the CHEAP half of the macro gate — same
//   environment, own or shared — and nothing more, exactly as the port says. So
//   a use case that forgot the second half fails here, which is the whole reason
//   the two halves are split across a boundary.
//
//   The version lock is genuinely FIRST-WRITER-WINS. A second `hold` returns the
//   incumbent rather than overwriting it, so a test can produce the lost-race
//   case — the one where a caller must serve a version it did not pick — without
//   any concurrency at all.
//
//   The recorder is genuinely idempotent on `start` and genuinely refuses a
//   mismatched `recordingId` on `stop`.

import { ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  byMacroOrder,
  byTemplateOrder,
  macroAccessFor,
  type ActorId,
  type AgentId,
  type AgentVersionId,
  type Macro,
  type MacroId,
  type MacroStep,
  type PostmanTemplate,
  type PostmanTemplateId,
} from "../../domain/index.js";
import type {
  AgentVersionLock,
  MacroQuery,
  MacroRecorder,
  MacroRecording,
  RecorderKey,
  ScaffoldingRepository,
  TemplatePage,
  TemplateQuery,
  ThreadKey,
} from "../ports/index.js";

export class InMemoryScaffolding implements ScaffoldingRepository {
  readonly macros = new Map<string, Macro>();
  readonly templates = new Map<string, PostmanTemplate>();
  readonly writes: string[] = [];

  seedMacro(macro: Macro): Macro {
    this.macros.set(macro.macroId, macro);
    return macro;
  }

  seedTemplate(template: PostmanTemplate): PostmanTemplate {
    this.templates.set(template.templateId, template);
    return template;
  }

  async listMacros(scope: EnvironmentScope, query: MacroQuery): Promise<Result<readonly Macro[]>> {
    const visible = [...this.macros.values()]
      .filter((macro) => macroAccessFor(macro, scope.environmentId, query.actorId) !== null)
      .sort(byMacroOrder);
    return ok(visible.slice(0, query.limit));
  }

  async findMacro(scope: EnvironmentScope, macroId: MacroId): Promise<Result<Macro | null>> {
    const held = this.macros.get(macroId);
    // Ungated on purpose: the environment filter is the store's, the owner gate
    // is the use case's. See the port's own note.
    if (held === undefined || held.environmentId !== scope.environmentId) return ok(null);
    return ok(held);
  }

  async insertMacro(macro: Macro, transaction: TransactionScope): Promise<Result<Macro>> {
    this.writes.push(`insertMacro:${transaction.transactionId}`);
    this.macros.set(macro.macroId, macro);
    return ok(macro);
  }

  async updateMacro(macro: Macro, transaction: TransactionScope): Promise<Result<Macro>> {
    this.writes.push(`updateMacro:${transaction.transactionId}`);
    this.macros.set(macro.macroId, macro);
    return ok(macro);
  }

  async deleteMacro(
    scope: EnvironmentScope,
    macroId: MacroId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    this.writes.push(`deleteMacro:${transaction.transactionId}`);
    const held = this.macros.get(macroId);
    if (held === undefined || held.environmentId !== scope.environmentId) return ok(false);
    return ok(this.macros.delete(macroId));
  }

  async findTemplate(
    scope: EnvironmentScope,
    templateId: PostmanTemplateId,
  ): Promise<Result<PostmanTemplate | null>> {
    const held = this.templates.get(templateId);
    if (held === undefined || held.environmentId !== scope.environmentId) return ok(null);
    return ok(held);
  }

  async pageTemplates(scope: EnvironmentScope, query: TemplateQuery): Promise<Result<TemplatePage>> {
    const term = query.search === null ? null : query.search.toLowerCase();
    const matching = [...this.templates.values()]
      .filter((template) => {
        if (template.environmentId !== scope.environmentId) return false;
        if (query.agentId !== null && template.agentId !== query.agentId) return false;
        if (term === null) return true;
        return (
          template.name.toLowerCase().includes(term) ||
          template.simulateUserId.toLowerCase().includes(term)
        );
      })
      .sort(byTemplateOrder);
    return ok({
      items: matching.slice(query.offset, query.offset + query.limit),
      total: matching.length,
    });
  }

  async listTemplatesFor(
    scope: EnvironmentScope,
    agentId: AgentId,
  ): Promise<Result<readonly PostmanTemplate[]>> {
    return ok(
      [...this.templates.values()]
        .filter(
          (template) =>
            template.environmentId === scope.environmentId && template.agentId === agentId,
        )
        .sort(byTemplateOrder),
    );
  }

  async insertTemplate(
    template: PostmanTemplate,
    transaction: TransactionScope,
  ): Promise<Result<PostmanTemplate>> {
    this.writes.push(`insertTemplate:${transaction.transactionId}`);
    this.templates.set(template.templateId, template);
    return ok(template);
  }

  async updateTemplate(
    template: PostmanTemplate,
    transaction: TransactionScope,
  ): Promise<Result<PostmanTemplate>> {
    this.writes.push(`updateTemplate:${transaction.transactionId}`);
    this.templates.set(template.templateId, template);
    return ok(template);
  }

  async deleteTemplate(
    scope: EnvironmentScope,
    templateId: PostmanTemplateId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    this.writes.push(`deleteTemplate:${transaction.transactionId}`);
    const held = this.templates.get(templateId);
    if (held === undefined || held.environmentId !== scope.environmentId) return ok(false);
    return ok(this.templates.delete(templateId));
  }
}

function threadKeyOf(key: ThreadKey): string {
  return `${key.scope.organizationId}/${key.scope.projectId}/${key.scope.environmentId}/${key.agentId}/${key.threadId}`;
}

export class InMemoryVersionLock implements AgentVersionLock {
  private readonly held = new Map<string, AgentVersionId>();
  readonly releases: string[] = [];

  async read(key: ThreadKey): Promise<Result<AgentVersionId | null>> {
    return ok(this.held.get(threadKeyOf(key)) ?? null);
  }

  /** First writer wins. A later claim reads the incumbent back, never replaces it. */
  async hold(key: ThreadKey, versionId: AgentVersionId): Promise<Result<AgentVersionId>> {
    const id = threadKeyOf(key);
    const incumbent = this.held.get(id);
    if (incumbent !== undefined) return ok(incumbent);
    this.held.set(id, versionId);
    return ok(versionId);
  }

  async releaseAll(scope: EnvironmentScope, agentId: AgentId): Promise<Result<void>> {
    const prefix = `${scope.organizationId}/${scope.projectId}/${scope.environmentId}/${agentId}/`;
    for (const id of [...this.held.keys()]) {
      if (id.startsWith(prefix)) this.held.delete(id);
    }
    this.releases.push(`${scope.environmentId}/${agentId}`);
    return ok(undefined);
  }

  /** Pre-seed a hold, for the tests that need a thread already pinned. */
  seed(key: ThreadKey, versionId: AgentVersionId): void {
    this.held.set(threadKeyOf(key), versionId);
  }
}

function recorderKeyOf(key: RecorderKey): string {
  return `${key.scope.environmentId}/${key.sessionId}`;
}

export class InMemoryMacroRecorder implements MacroRecorder {
  private readonly live = new Map<string, MacroRecording>();

  async start(
    key: RecorderKey,
    recordingId: string,
    createdBy: ActorId,
    at: Date,
  ): Promise<Result<MacroRecording>> {
    const id = recorderKeyOf(key);
    const existing = this.live.get(id);
    // Idempotent: a caller that lost its recording id gets the live recording
    // back rather than a second, empty one.
    if (existing !== undefined) return ok(existing);
    const recording: MacroRecording = {
      recordingId,
      scope: key.scope,
      createdBy,
      steps: [],
      startedAt: at,
    };
    this.live.set(id, recording);
    return ok(recording);
  }

  async append(key: RecorderKey, step: MacroStep): Promise<Result<void>> {
    const id = recorderKeyOf(key);
    const existing = this.live.get(id);
    if (existing === undefined) return ok(undefined);
    this.live.set(id, { ...existing, steps: [...existing.steps, step] });
    return ok(undefined);
  }

  async read(key: RecorderKey): Promise<Result<MacroRecording | null>> {
    return ok(this.live.get(recorderKeyOf(key)) ?? null);
  }

  async stop(key: RecorderKey, recordingId: string): Promise<Result<MacroRecording | null>> {
    const id = recorderKeyOf(key);
    const existing = this.live.get(id);
    if (existing === undefined) return ok(null);
    // A mismatched id is a stale surface finalising a recording it did not
    // start. The live recording is left alone.
    if (existing.recordingId !== recordingId) return ok(null);
    this.live.delete(id);
    return ok(existing);
  }
}
