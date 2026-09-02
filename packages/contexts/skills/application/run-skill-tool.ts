// Use case: run one skill-provided tool in the sandbox.
//
// The runtime hands back NAMESPACED tool names, so what arrives here is
// `platos_web_search__search` and what the sandbox needs is the skill and the
// bare tool name. Resolving one into the other is this use case's first job, and
// it is done by looking the tool up in the skill's own manifest rather than by
// splitting the string: the separator is unambiguous, but a name that does not
// correspond to a tool the skill actually declares must not reach a sandbox
// merely because it is well formed.
//
// EVERY PRECONDITION IS CHECKED BEFORE THE SANDBOX IS TOUCHED — visibility, the
// install and both its enabled flags, environment readiness, and the tool's
// existence in the manifest. A confined runtime is the most expensive thing this
// context can reach and the only one with a side effect outside the database, so
// nothing gets there on a request that was going to be refused anyway.
//
// A TOOL WITH NO HANDLER IS REFUSED, NOT GUESSED. `handler` is optional in the
// manifest, and a tool that declares none has no executor to resolve. Inventing
// one from the name would dispatch to whatever happened to answer.
//
// USAGE IS REPORTED, NOT RECORDED. Metering and budgets belong to
// `cost-monitoring` (ADR M0.3 §1, context 13), which is not on this context's
// allow-list. What comes back carries the units, the cost the sandbox could
// establish, and the latency; the caller that owns the turn is the one holding
// the ledger.

import { err, ok, type EnvironmentScope, type JsonValue, type Result } from "@platos/kernel";

import {
  isEnvironmentReady,
  isInstallationEnabled,
  isToolOfSkill,
  missingKeys,
  environmentKeysMissing,
  namespaceTool,
  sandboxRefused,
  skillNotInstalled,
  type CatalogueEntry,
  type CatalogueScope,
  type Installation,
  type NamespacedToolName,
  type SkillProvidedTool,
} from "../domain/index.js";
import { findBinding } from "./bind-skill.js";
import type { SkillsDependencies } from "./dependencies.js";
import type { SkillSandboxUsage } from "./ports/index.js";

export interface RunSkillToolCommand {
  readonly scope: CatalogueScope;
  /** A row id or a slug, naming the skill that owns the tool. */
  readonly reference: string;
  /** The namespaced name the runtime dispatched. */
  readonly toolName: NamespacedToolName;
  readonly input: Readonly<Record<string, JsonValue>>;
}

export interface SkillToolOutcome {
  readonly result: JsonValue;
  readonly usage: SkillSandboxUsage;
}

/**
 * Find the manifest tool whose namespaced form is the name that was dispatched.
 *
 * Compared after namespacing rather than by stripping a prefix, so the one
 * definition of the naming scheme (`domain/tool-namespace.ts`) is the only thing
 * that has to be right — a separate un-namespacing routine would be a second
 * definition free to drift from the first.
 */
export function resolveDispatchedTool(
  entry: CatalogueEntry,
  toolName: NamespacedToolName,
): SkillProvidedTool | null {
  if (!isToolOfSkill(toolName, entry.identity.slug)) return null;
  for (const tool of entry.providesTools) {
    if (namespaceTool(entry.identity.slug, tool.name) === toolName) return tool;
  }
  return null;
}

async function requireReady(
  dependencies: SkillsDependencies,
  environment: EnvironmentScope,
  entry: CatalogueEntry,
): Promise<Result<null>> {
  const required = entry.requiredEnvironmentKeys;
  if (required.length === 0) return ok(null);
  const presence = await dependencies.environmentKeys.presenceOf(environment, required);
  if (!presence.ok) return err(presence.error);
  if (isEnvironmentReady(required, presence.value)) return ok(null);
  return err(environmentKeysMissing(entry.identity.slug, missingKeys(required, presence.value)));
}

function requireUsableBinding(
  reference: string,
  bound: { readonly entry: CatalogueEntry; readonly installation: Installation } | null,
): Result<{ readonly entry: CatalogueEntry; readonly installation: Installation }> {
  if (bound === null) return err(skillNotInstalled(reference));
  if (!isInstallationEnabled(bound.installation)) return err(skillNotInstalled(reference));
  return ok(bound);
}

export async function runSkillTool(
  dependencies: SkillsDependencies,
  command: RunSkillToolCommand,
): Promise<Result<SkillToolOutcome>> {
  const found = await findBinding(dependencies, { scope: command.scope, reference: command.reference });
  if (!found.ok) return err(found.error);
  const bound = requireUsableBinding(command.reference, found.value);
  if (!bound.ok) return err(bound.error);

  const tool = resolveDispatchedTool(bound.value.entry, command.toolName);
  if (tool === null) return err(sandboxRefused(command.toolName, "tool is not declared by this skill"));
  if (tool.handler === null) {
    return err(sandboxRefused(command.toolName, "tool declares no handler to dispatch to"));
  }

  const ready = await requireReady(dependencies, command.scope.environment, bound.value.entry);
  if (!ready.ok) return err(ready.error);

  const outcome = await dependencies.sandbox.run({
    scope: command.scope.environment,
    slug: bound.value.entry.identity.slug,
    toolName: tool.name,
    handler: tool.handler,
    input: command.input,
    // NAMES ONLY. The adapter resolves values against the secrets boundary; a
    // value passing through this package would put a credential in a context
    // that has no business holding one.
    environmentKeys: bound.value.entry.requiredEnvironmentKeys,
    config: bound.value.installation.environment.config,
  });
  if (!outcome.ok) return err(outcome.error);
  return ok({ result: outcome.value.result, usage: outcome.value.usage });
}
