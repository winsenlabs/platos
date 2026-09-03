// The composition of this context's use cases into its published contract.
//
// Thin on purpose. Every rule lives in `domain/`, every orchestration in a named
// use-case module, and this file is the adapter between the command shapes the
// contract publishes and the ones the use cases take. It holds no rule of its
// own, which is what keeps it from becoming the god-service ADR M0.3 §6 exists
// to prevent.
//
// One thing here is not merely mechanical and is worth naming: several methods
// resolve environment-key PRESENCE a second time in order to build their view.
// That is deliberate. The alternative is for every use case to return its
// presence map alongside its result so this layer can reuse it, which would put
// a presentation concern into the signature of every use case. Presence is a
// batched lookup keyed by name, and the reads that matter for throughput — the
// catalogue list and page — already resolve it once and pass it through.

import { err, ok, type ErasureTarget, type Result } from "@platos/kernel";

import type {
  RequestOfficialSeeding,
  RequestSkill,
  RequestSkillCatalogue,
  RequestSkillImport,
  RequestSkillPage,
  RequestSkillPatch,
  RequestSkillRegistration,
  RequestSkillRuntime,
  RequestSkillToolRun,
  SkillBindingView,
  SkillPageView,
  SkillRuntimeView,
  SkillSeedView,
  SkillToolResultView,
  SkillUninstallView,
  SkillView,
  SkillsContract,
} from "../contracts/index.js";
import type { CatalogueEntry, CatalogueScope, EnvironmentKeyPresence } from "../domain/index.js";
import { bindSkill, findBinding } from "./bind-skill.js";
import { composeRuntimeSkills } from "./compose-runtime.js";
import type { SkillsDependencies } from "./dependencies.js";
import { importSkillFromUrl } from "./import-skill.js";
import { installSkill, uninstallSkill } from "./install-skill.js";
import { patchSkill } from "./patch-skill.js";
import { findVisibleSkill, listCatalogue, pageCatalogue, presenceFor } from "./read-catalogue.js";
import { registerSkillFromSource } from "./register-skill.js";
import { seedOfficialSkills, seedOfficialSkillsIfAbsent } from "./seed-official-skills.js";
import { createSkillsErasureTarget } from "./skills-erasure-target.js";
import { runSkillTool } from "./run-skill-tool.js";
import { toBindingView, toComposedToolView, toSkillView, toSkillViews } from "./views.js";

/** Presence for one entry, so a single-row view reports readiness like a list does. */
async function presenceForOne(
  dependencies: SkillsDependencies,
  scope: CatalogueScope,
  entry: CatalogueEntry,
): Promise<Result<EnvironmentKeyPresence>> {
  return presenceFor(dependencies, scope, [entry]);
}

async function describe(
  dependencies: SkillsDependencies,
  request: RequestSkill,
): Promise<Result<SkillView>> {
  const entry = await findVisibleSkill(dependencies, request.scope, request.reference);
  if (!entry.ok) return err(entry.error);
  const presence = await presenceForOne(dependencies, request.scope, entry.value);
  if (!presence.ok) return err(presence.error);
  return ok(toSkillView(entry.value, presence.value));
}

async function list(
  dependencies: SkillsDependencies,
  request: RequestSkillCatalogue,
): Promise<Result<readonly SkillView[]>> {
  const listed = await listCatalogue(dependencies, request.scope);
  if (!listed.ok) return err(listed.error);
  return ok(toSkillViews(listed.value.entries, listed.value.presence));
}

async function page(
  dependencies: SkillsDependencies,
  request: RequestSkillPage,
): Promise<Result<SkillPageView>> {
  const paged = await pageCatalogue(dependencies, request.scope, {
    limit: request.limit,
    offset: request.offset,
    search: request.search ?? null,
  });
  if (!paged.ok) return err(paged.error);
  return ok({ items: toSkillViews(paged.value.entries, paged.value.presence), total: paged.value.total });
}

async function register(
  dependencies: SkillsDependencies,
  request: RequestSkillRegistration,
): Promise<Result<SkillView>> {
  const registered = await registerSkillFromSource(dependencies, {
    scope: request.scope,
    source: request.source,
    importedFrom: request.importedFrom ?? null,
    ...(request.origin === undefined ? {} : { origin: request.origin }),
  });
  if (!registered.ok) return err(registered.error);
  const presence = await presenceForOne(dependencies, request.scope, registered.value.entry);
  if (!presence.ok) return err(presence.error);
  return ok(toSkillView(registered.value.entry, presence.value));
}

async function importFromUrl(
  dependencies: SkillsDependencies,
  request: RequestSkillImport,
): Promise<Result<SkillView>> {
  const imported = await importSkillFromUrl(dependencies, request);
  if (!imported.ok) return err(imported.error);
  const presence = await presenceForOne(dependencies, request.scope, imported.value.entry);
  if (!presence.ok) return err(presence.error);
  return ok(toSkillView(imported.value.entry, presence.value));
}

async function patch(
  dependencies: SkillsDependencies,
  request: RequestSkillPatch,
): Promise<Result<SkillView>> {
  const patched = await patchSkill(dependencies, {
    scope: request.scope,
    reference: request.reference,
    patch: {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.tags === undefined ? {} : { tags: request.tags }),
    },
  });
  if (!patched.ok) return err(patched.error);
  const presence = await presenceForOne(dependencies, request.scope, patched.value);
  if (!presence.ok) return err(presence.error);
  return ok(toSkillView(patched.value, presence.value));
}

async function bindingView(
  dependencies: SkillsDependencies,
  scope: CatalogueScope,
  bound: { readonly entry: CatalogueEntry; readonly installation: Parameters<typeof toBindingView>[1] },
): Promise<Result<SkillBindingView>> {
  const presence = await presenceForOne(dependencies, scope, bound.entry);
  if (!presence.ok) return err(presence.error);
  return ok(toBindingView(bound.entry, bound.installation, presence.value));
}

async function install(
  dependencies: SkillsDependencies,
  request: RequestSkill,
): Promise<Result<SkillBindingView>> {
  const entry = await findVisibleSkill(dependencies, request.scope, request.reference);
  if (!entry.ok) return err(entry.error);
  const installation = await installSkill(dependencies, request);
  if (!installation.ok) return err(installation.error);
  return bindingView(dependencies, request.scope, { entry: entry.value, installation: installation.value });
}

async function uninstall(
  dependencies: SkillsDependencies,
  request: RequestSkill,
): Promise<Result<SkillUninstallView>> {
  return uninstallSkill(dependencies, request);
}

async function bind(
  dependencies: SkillsDependencies,
  request: RequestSkill,
): Promise<Result<SkillBindingView>> {
  const bound = await bindSkill(dependencies, request);
  if (!bound.ok) return err(bound.error);
  return bindingView(dependencies, request.scope, bound.value);
}

async function readBinding(
  dependencies: SkillsDependencies,
  request: RequestSkill,
): Promise<Result<SkillBindingView | null>> {
  const bound = await findBinding(dependencies, request);
  if (!bound.ok) return err(bound.error);
  if (bound.value === null) return ok(null);
  return bindingView(dependencies, request.scope, bound.value);
}

async function composeRuntime(
  dependencies: SkillsDependencies,
  request: RequestSkillRuntime,
): Promise<Result<SkillRuntimeView>> {
  const composed = await composeRuntimeSkills(dependencies, {
    scope: request.scope,
    environmentSkillIds: request.environmentSkillIds,
    basePrompt: request.basePrompt ?? null,
  });
  if (!composed.ok) return err(composed.error);
  return ok({
    promptBlock: composed.value.promptBlock,
    systemPrompt: composed.value.systemPrompt,
    tools: composed.value.tools.map(toComposedToolView),
    admitted: composed.value.admitted.map((skill) => skill.slug),
    omitted: composed.value.omitted.map((skill) => skill.slug),
    truncated: composed.value.truncated,
    skipped: composed.value.skipped,
  });
}

async function runTool(
  dependencies: SkillsDependencies,
  request: RequestSkillToolRun,
): Promise<Result<SkillToolResultView>> {
  return runSkillTool(dependencies, request);
}

async function seedOfficial(
  dependencies: SkillsDependencies,
  request: RequestOfficialSeeding,
): Promise<Result<SkillSeedView>> {
  const command = { organization: request.organization, sources: request.sources };
  const report = request.onlyIfAbsent === true
    ? await seedOfficialSkillsIfAbsent(dependencies, command)
    : await seedOfficialSkills(dependencies, command);
  if (!report.ok) return err(report.error);
  // A skipped lazy seed reports nothing seeded and nothing failed, which is
  // exactly true: the catalogue was already there.
  if (report.value === null) return ok({ seeded: [], failed: [] });
  return ok({
    // Seeding has no environment, so readiness was not evaluated and `envReady`
    // is null on every row here. That is the honest answer, not a degraded one.
    seeded: report.value.seeded.map((seed) => toSkillView(seed.entry, null)),
    failed: report.value.failed,
  });
}

/** Build the context. The composition root calls this once, at boot. */
export function createSkillsContract(dependencies: SkillsDependencies): SkillsContract {
  const erasure: ErasureTarget = createSkillsErasureTarget(dependencies);
  return {
    name: "skills",
    list: (request) => list(dependencies, request),
    page: (request) => page(dependencies, request),
    describe: (request) => describe(dependencies, request),
    register: (request) => register(dependencies, request),
    importFromUrl: (request) => importFromUrl(dependencies, request),
    patch: (request) => patch(dependencies, request),
    install: (request) => install(dependencies, request),
    uninstall: (request) => uninstall(dependencies, request),
    bind: (request) => bind(dependencies, request),
    findBinding: (request) => readBinding(dependencies, request),
    composeRuntime: (request) => composeRuntime(dependencies, request),
    runTool: (request) => runTool(dependencies, request),
    seedOfficial: (request) => seedOfficial(dependencies, request),
    erasureTarget: () => erasure,
  };
}
