// Use cases: macros.
//
// THE VISIBILITY GATE IS APPLIED TWICE AND THE TWO HALVES ARE DIFFERENT
// QUESTIONS. The store answers "is this row in this environment?", which is an
// index-backed predicate; the domain answers "may this caller see it, and may
// they change it?", which is not. Keeping the second out of the query is what
// lets a read distinguish "no such macro here" from "visible, but not yours" —
// and those are the two errors the running system's own handlers return.
//
// REPLAY RESOLVES, IT DOES NOT EXECUTE. Every step of a macro is re-dispatched
// through the same surface an individual call would take, so each one still goes
// through its permission gate and its audit record. This context owns the steps
// and the substitution; it does not own tool execution, and reaching for it here
// would be a `tools` edge the ADR M0.3 §1 DAG does not permit this context.
// `resolveMacro` therefore returns the resolved steps and stops.
//
// A RECORDING IS LOST ON RESTART AND THAT IS THE ADAPTER'S PROPERTY, NOT THIS
// FILE'S. See the note on the `MacroRecorder` port.

import { err, ok, runResult, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  admitMacro,
  applyMacroPatch,
  asAgentsIdentifier,
  byMacroOrder,
  macroAccessFor,
  macroIsEditableBy,
  macroNotEditable,
  macroNotFound,
  macroRecordingUnknown,
  resolveSteps,
  type ActorId,
  type JsonObject,
  type Macro,
  type MacroAccess,
  type MacroId,
  type MacroPatch,
  type MacroStep,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { AgentsDependencies } from "./dependencies.js";
import type { MacroRecording } from "./ports/index.js";

export interface MacroQueryBase {
  readonly authorization: unknown;
  /** Whose macros these are. Null is an unattributed caller: shared only. */
  readonly actorId: string | null;
}

export interface ListMacrosQuery extends MacroQueryBase {
  readonly limit?: number;
}

export interface DescribeMacroQuery extends MacroQueryBase {
  readonly macroId: MacroId;
}

export interface UpdateMacroCommand extends DescribeMacroQuery, MacroPatch {}

export interface ResolveMacroQuery extends DescribeMacroQuery {
  readonly params?: JsonObject;
}

export interface StartRecordingCommand extends MacroQueryBase {
  /** The caller's session identity, whatever the transport authenticated. */
  readonly sessionId: string;
}

export interface AppendRecordingCommand extends StartRecordingCommand {
  readonly step: MacroStep;
}

export interface StopRecordingCommand extends StartRecordingCommand {
  readonly recordingId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly paramSchema?: JsonObject | null;
}

/** A macro together with the basis on which this caller may see it. */
export interface VisibleMacro {
  readonly macro: Macro;
  readonly access: MacroAccess;
}

function actorOf(actorId: string | null): ActorId | null {
  return actorId === null || actorId === "" ? null : asAgentsIdentifier<ActorId>(actorId);
}

export async function listMacros(
  dependencies: AgentsDependencies,
  query: ListMacrosQuery,
): Promise<Result<readonly VisibleMacro[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;
  const actorId = actorOf(query.actorId);

  const listed = await dependencies.scaffolding.listMacros(scope, {
    limit: Math.min(
      Math.max(Math.trunc(query.limit ?? dependencies.policy.macros.defaultPageSize), 1),
      dependencies.policy.macros.maxPageSize,
    ),
    actorId,
  });
  if (!listed.ok) return err(listed.error);

  const visible: VisibleMacro[] = [];
  for (const macro of [...listed.value].sort(byMacroOrder)) {
    // The gate runs again on every returned row. A store that widened its
    // predicate — or an adapter that forgot the shared clause — cannot leak a
    // macro past this loop, which is the property a listing needs and a query
    // alone cannot give.
    const access = macroAccessFor(macro, scope.environmentId, actorId);
    if (access !== null) visible.push({ macro, access });
  }
  return ok(visible);
}

export async function describeMacro(
  dependencies: AgentsDependencies,
  query: DescribeMacroQuery,
): Promise<Result<VisibleMacro>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  return requireVisible(dependencies, granted.value.scope, query.macroId, actorOf(query.actorId));
}

export async function updateMacro(
  dependencies: AgentsDependencies,
  command: UpdateMacroCommand,
): Promise<Result<Macro>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;
  const actorId = actorOf(command.actorId);

  const held = await dependencies.scaffolding.findMacro(scope, command.macroId);
  if (!held.ok) return err(held.error);
  if (held.value === null) return err(macroNotFound(command.macroId));
  // Visible-but-not-yours is a DIFFERENT answer from invisible. See the note at
  // the top; collapsing them would either leak or mislead.
  if (macroAccessFor(held.value, scope.environmentId, actorId) === null) {
    return err(macroNotFound(command.macroId));
  }
  if (!macroIsEditableBy(held.value, scope.environmentId, actorId)) {
    return err(macroNotEditable(command.macroId));
  }

  const patched = applyMacroPatch(held.value, command, dependencies.clock.now());
  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.scaffolding.updateMacro(patched, transaction),
  );
}

export async function removeMacro(
  dependencies: AgentsDependencies,
  query: DescribeMacroQuery,
): Promise<Result<boolean>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;
  const actorId = actorOf(query.actorId);

  const held = await dependencies.scaffolding.findMacro(scope, query.macroId);
  if (!held.ok) return err(held.error);
  // A delete of a macro this caller cannot see answers `false` rather than
  // refusing, exactly as the source does: an idempotent delete must not become
  // an existence oracle.
  if (held.value === null) return ok(false);
  if (macroAccessFor(held.value, scope.environmentId, actorId) === null) return ok(false);
  if (!macroIsEditableBy(held.value, scope.environmentId, actorId)) {
    return err(macroNotEditable(query.macroId));
  }
  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.scaffolding.deleteMacro(scope, query.macroId, transaction),
  );
}

/** The steps a replay would dispatch, with `${var.path}` already substituted. */
export async function resolveMacro(
  dependencies: AgentsDependencies,
  query: ResolveMacroQuery,
): Promise<Result<readonly MacroStep[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const visible = await requireVisible(
    dependencies,
    granted.value.scope,
    query.macroId,
    actorOf(query.actorId),
  );
  if (!visible.ok) return err(visible.error);
  return ok(resolveSteps(visible.value.macro, query.params ?? {}));
}

export async function startRecording(
  dependencies: AgentsDependencies,
  command: StartRecordingCommand,
): Promise<Result<MacroRecording>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const actorId = actorOf(command.actorId);
  if (actorId === null) {
    return err(macroRecordingUnknown("an unattributed caller cannot own a recording"));
  }
  return dependencies.recorder.start(
    { scope: granted.value.scope, sessionId: command.sessionId },
    dependencies.ids.ulid(),
    actorId,
    dependencies.clock.now(),
  );
}

export async function appendRecordingStep(
  dependencies: AgentsDependencies,
  command: AppendRecordingCommand,
): Promise<Result<void>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  return dependencies.recorder.append(
    { scope: granted.value.scope, sessionId: command.sessionId },
    command.step,
  );
}

export async function stopRecording(
  dependencies: AgentsDependencies,
  command: StopRecordingCommand,
): Promise<Result<Macro>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const finalized = await dependencies.recorder.stop(
    { scope, sessionId: command.sessionId },
    command.recordingId,
  );
  if (!finalized.ok) return err(finalized.error);
  if (finalized.value === null) return err(macroRecordingUnknown(command.recordingId));

  const admitted = admitMacro(
    {
      name: command.name,
      description: command.description,
      steps: finalized.value.steps,
      paramSchema: command.paramSchema,
    },
    dependencies.policy.macros,
  );
  if (!admitted.ok) return err(admitted.error);

  const now = dependencies.clock.now();
  const macro: Macro = {
    macroId: asAgentsIdentifier<MacroId>(dependencies.ids.uuid()),
    environmentId: scope.environmentId,
    name: admitted.value.name,
    description: admitted.value.description,
    steps: admitted.value.steps,
    paramSchema: admitted.value.paramSchema,
    sharedWithOrganization: false,
    // The AUTHOR of the recording, not whoever stopped it. They are the same
    // caller in every current transport, and pinning the recording's own author
    // is what keeps them the same if one day they are not.
    createdBy: finalized.value.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.scaffolding.insertMacro(macro, transaction),
  );
}

async function requireVisible(
  dependencies: AgentsDependencies,
  scope: EnvironmentScope,
  macroId: MacroId,
  actorId: ActorId | null,
): Promise<Result<VisibleMacro>> {
  const held = await dependencies.scaffolding.findMacro(scope, macroId);
  if (!held.ok) return err(held.error);
  if (held.value === null) return err(macroNotFound(macroId));
  const access = macroAccessFor(held.value, scope.environmentId, actorId);
  if (access === null) return err(macroNotFound(macroId));
  return ok({ macro: held.value, access });
}
