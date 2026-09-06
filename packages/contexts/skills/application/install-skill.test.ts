import { asIdentifier, organizationScope, runResult } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { parseSkillSource, type CatalogueScope } from "../domain/index.js";
import { installSkill, uninstallSkill } from "./install-skill.js";
import { registerOfficialSkill, registerSkillFromSource } from "./register-skill.js";
import {
  buildSkillsTestContext,
  scopeFor,
  skillSource,
  type SkillsTestContext,
} from "./testing/index.js";

const ORG = organizationScope(asIdentifier("org-1"));

function parsed(source: string) {
  const result = parseSkillSource(source);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function registerCustom(
  context: SkillsTestContext,
  scope: CatalogueScope,
  id = "acme.thing",
): Promise<void> {
  const registered = await registerSkillFromSource(context.dependencies, {
    scope,
    source: skillSource({ id }),
  });
  if (!registered.ok) throw new Error(registered.error.code);
}

describe("installSkill", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("creates BOTH halves of the install, both enabled", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search" })),
    });
    const installed = await installSkill(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      reference: "platos.web_search",
    });
    if (!installed.ok) throw new Error(installed.error.code);
    expect(installed.value.project.enabled).toBe(true);
    expect(installed.value.environment.enabled).toBe(true);
    expect(installed.value.environment.projectSkillId).toBe(installed.value.project.projectSkillId);
  });

  it("gives a fresh binding the empty config, not null", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search" })),
    });
    const installed = await installSkill(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      reference: "platos.web_search",
    });
    if (!installed.ok) throw new Error(installed.error.code);
    expect(installed.value.environment.config).toEqual({});
  });

  it("is idempotent — installing twice leaves one pair", async () => {
    const scope = scopeFor("org-1", "proj-1", "env-1");
    await registerCustom(context, scope);
    await installSkill(context.dependencies, { scope, reference: "acme.thing" });
    await installSkill(context.dependencies, { scope, reference: "acme.thing" });
    expect(context.repository.allProjectInstallations()).toHaveLength(1);
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(1);
  });

  it("installs an OFFICIAL skill into two environments against ONE adoption", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search" })),
    });
    for (const environmentId of ["env-1", "env-2"]) {
      const installed = await installSkill(context.dependencies, {
        scope: scopeFor("org-1", "proj-1", environmentId),
        reference: "platos.web_search",
      });
      if (!installed.ok) throw new Error(installed.error.code);
    }
    // One project adoption, two environment bindings hanging off it — which is
    // what makes the environment row keyed by the project row rather than by
    // the skill.
    expect(context.repository.allProjectInstallations()).toHaveLength(1);
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(2);
  });

  it("CANNOT reach a custom skill from a sibling environment — visibility is circular", async () => {
    // A non-official row is visible only where it is installed, and installing
    // requires visibility. So a custom skill registered in env-1 is unreachable
    // from env-2 and must be re-registered there instead. This is the live
    // behaviour (every read path is gated on the same visibility rule), it is
    // preserved deliberately, and it is reported as a finding rather than fixed
    // here: widening it is a behaviour change, not a boundary extraction.
    await registerCustom(context, scopeFor("org-1", "proj-1", "env-1"));
    const installed = await installSkill(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-2"),
      reference: "acme.thing",
    });
    expect(installed.ok).toBe(false);
    if (installed.ok) throw new Error("unreachable");
    expect(installed.error.code).toBe("SKILLS_SKILL_NOT_FOUND");
  });

  it("REFUSES to install a skill this scope cannot see", async () => {
    await registerCustom(context, scopeFor("org-2", "proj-1", "env-1"), "theirs.thing");
    const installed = await installSkill(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      reference: "theirs.thing",
    });
    expect(installed.ok).toBe(false);
    if (installed.ok) throw new Error("unreachable");
    expect(installed.error.code).toBe("SKILLS_SKILL_NOT_FOUND");
  });
});

describe("uninstallSkill", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("removes this environment's binding and keeps the project adoption", async () => {
    const scope = scopeFor("org-1", "proj-1", "env-1");
    await registerCustom(context, scope);
    const removed = await uninstallSkill(context.dependencies, { scope, reference: "acme.thing" });
    if (!removed.ok) throw new Error(removed.error.code);
    expect(removed.value).toEqual({ uninstalled: true, refusedBecause: null });
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(0);
    // The adoption survives: a sibling environment's binding hangs off it.
    expect(context.repository.allProjectInstallations()).toHaveLength(1);
  });

  it("keeps the catalogue row, which is organization-owned", async () => {
    const scope = scopeFor("org-1", "proj-1", "env-1");
    await registerCustom(context, scope);
    await uninstallSkill(context.dependencies, { scope, reference: "acme.thing" });
    expect(context.repository.allSkills()).toHaveLength(1);
  });

  it("does NOT uninstall from a sibling environment", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search" })),
    });
    const staging = scopeFor("org-1", "proj-1", "env-1");
    const production = scopeFor("org-1", "proj-1", "env-2");
    await installSkill(context.dependencies, { scope: staging, reference: "platos.web_search" });
    await installSkill(context.dependencies, { scope: production, reference: "platos.web_search" });

    // An official row cannot be uninstalled, so reach past the refusal and
    // delete the binding directly: the property under test is that removing one
    // environment's binding leaves the sibling's alone.
    const removed = await runResult(context.dependencies.unitOfWork, (transaction) =>
      context.repository.deleteEnvironmentInstallation(
        staging,
        context.repository.allSkills()[0]!.skillId,
        transaction,
      ),
    );
    if (!removed.ok) throw new Error(removed.error.code);

    const remaining = context.repository.allEnvironmentInstallations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.scope.environmentId).toBe("env-2");
    expect(context.repository.allProjectInstallations()).toHaveLength(1);
  });

  it("REFUSES to uninstall an official skill, and SAYS it refused", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search" })),
    });
    const removed = await uninstallSkill(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      reference: "platos.web_search",
    });
    if (!removed.ok) throw new Error(removed.error.code);
    // The live surface answers `{ removed: true }` here, which is a claim it has
    // not checked. This reports what actually happened.
    expect(removed.value.uninstalled).toBe(false);
    expect(removed.value.refusedBecause).toBe("SKILLS_OFFICIAL_SKILL_IMMUTABLE");
  });

  it("reports a skill it cannot see as refused, not as an error", async () => {
    const removed = await uninstallSkill(context.dependencies, {
      scope: scopeFor("org-1", "proj-1", "env-1"),
      reference: "nobody.here",
    });
    if (!removed.ok) throw new Error(removed.error.code);
    expect(removed.value).toEqual({ uninstalled: false, refusedBecause: "SKILLS_SKILL_NOT_FOUND" });
  });

  it("is idempotent — uninstalling twice reports the second as a no-op", async () => {
    const scope = scopeFor("org-1", "proj-1", "env-1");
    await registerCustom(context, scope);
    const first = await uninstallSkill(context.dependencies, { scope, reference: "acme.thing" });
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value.uninstalled).toBe(true);

    // The row is now invisible here, so the second pass refuses rather than
    // failing — an operator clicking twice must not see an error.
    const second = await uninstallSkill(context.dependencies, { scope, reference: "acme.thing" });
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.uninstalled).toBe(false);
  });

  it("propagates a store outage rather than reporting a clean refusal", async () => {
    const scope = scopeFor("org-1", "proj-1", "env-1");
    await registerCustom(context, scope);
    context.repository.failNext("connection reset");
    const removed = await uninstallSkill(context.dependencies, { scope, reference: "acme.thing" });
    expect(removed.ok).toBe(false);
    if (removed.ok) throw new Error("unreachable");
    expect(removed.error.code).toBe("SKILLS_REPOSITORY_UNAVAILABLE");
  });
});
