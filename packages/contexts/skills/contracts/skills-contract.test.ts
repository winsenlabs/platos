// The published surface, exercised through `createSkillsContract` alone.
//
// Every other suite reaches for a use case directly. This one goes only through
// the contract, because that is what `agents`, `conversations` and the
// composition root will hold — and a view that is assembled wrongly is invisible
// to a test that never asks for one.

import { asIdentifier, organizationScope } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { createSkillsContract } from "../application/index.js";
import {
  buildSkillsTestContext,
  scopeFor,
  skillSource,
  type SkillsTestContext,
} from "../application/testing/index.js";
import type { SkillSlug } from "../domain/index.js";
import type { SkillsContract } from "./index.js";

const ORG = organizationScope(asIdentifier("org-1"));
const SCOPE = scopeFor("org-1", "proj-1", "env-1");

interface Harness {
  readonly context: SkillsTestContext;
  readonly contract: SkillsContract;
}

function harness(): Harness {
  const context = buildSkillsTestContext();
  return { context, contract: createSkillsContract(context.dependencies) };
}

async function seed(harnessed: Harness, id: string, requiredEnv: readonly string[] = []): Promise<void> {
  const seeded = await harnessed.contract.seedOfficial({
    organization: ORG,
    sources: [
      {
        declaredId: asIdentifier<SkillSlug>(id),
        source: skillSource({ id, ...(requiredEnv.length === 0 ? {} : { requiredEnv }) }),
      },
    ],
  });
  if (!seeded.ok) throw new Error(seeded.error.code);
}

describe("SkillsContract", () => {
  let harnessed: Harness;

  beforeEach(() => {
    harnessed = harness();
  });

  it("names itself, so a composition root can assert what it wired", () => {
    expect(harnessed.contract.name).toBe("skills");
  });

  it("registers and describes a skill through the published surface", async () => {
    const registered = await harnessed.contract.register({
      scope: SCOPE,
      source: skillSource({ id: "acme.thing", name: "Thing", tools: [{ name: "go" }] }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    expect(registered.value.name).toBe("Thing");
    expect(registered.value.slug).toBe("acme.thing");

    const described = await harnessed.contract.describe({ scope: SCOPE, reference: "acme.thing" });
    if (!described.ok) throw new Error(described.error.code);
    expect(described.value.skillId).toBe(registered.value.skillId);
  });

  it("namespaces tools on the published view", async () => {
    const registered = await harnessed.contract.register({
      scope: SCOPE,
      source: skillSource({ id: "platos.web_search", tools: [{ name: "search" }] }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    expect(registered.value.providesTools[0]?.name).toBe("platos_web_search__search");
    expect(registered.value.providesTools[0]?.slug).toBe("platos.web_search");
  });

  it("derives a category onto the view rather than storing one", async () => {
    const registered = await harnessed.contract.register({
      scope: SCOPE,
      source: skillSource({ id: "platos.web_search" }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    expect(registered.value.category).toBe("web");
  });

  it("reports envReady TRUE and the per-key presence when the keys are set", async () => {
    harnessed.context.environmentKeys.setKey("TAVILY_API_KEY");
    const registered = await harnessed.contract.register({
      scope: SCOPE,
      source: skillSource({ id: "a.b", requiredEnv: ["TAVILY_API_KEY"] }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    expect(registered.value.envReady).toBe(true);
    expect(registered.value.environmentKeyPresence).toEqual({ TAVILY_API_KEY: true });
  });

  it("reports envReady FALSE and names the unset key", async () => {
    const registered = await harnessed.contract.register({
      scope: SCOPE,
      source: skillSource({ id: "a.b", requiredEnv: ["TAVILY_API_KEY"] }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    expect(registered.value.envReady).toBe(false);
    expect(registered.value.environmentKeyPresence).toEqual({ TAVILY_API_KEY: false });
  });

  it("reports envReady NULL on a seeded row, which had no environment to check", async () => {
    const seeded = await harnessed.contract.seedOfficial({
      organization: ORG,
      sources: [
        {
          declaredId: asIdentifier<SkillSlug>("a.b"),
          source: skillSource({ id: "a.b", requiredEnv: ["K"] }),
        },
      ],
    });
    if (!seeded.ok) throw new Error(seeded.error.code);
    // Not false. Seeding has no environment, so readiness was not evaluated,
    // and saying so is different from saying it failed.
    expect(seeded.value.seeded[0]?.envReady).toBeNull();
  });

  it("pages, and reports the unwindowed total", async () => {
    for (const id of ["a.one", "b.two", "c.three"]) await seed(harnessed, id);
    const paged = await harnessed.contract.page({ scope: SCOPE, limit: 2, offset: 0 });
    if (!paged.ok) throw new Error(paged.error.code);
    expect(paged.value.items).toHaveLength(2);
    expect(paged.value.total).toBe(3);
  });

  it("installs, then reports the binding as enabled with an empty config", async () => {
    await seed(harnessed, "platos.web_search");
    const installed = await harnessed.contract.install({ scope: SCOPE, reference: "platos.web_search" });
    if (!installed.ok) throw new Error(installed.error.code);
    expect(installed.value.enabled).toBe(true);
    expect(installed.value.config).toEqual({});
    expect(installed.value.skill.slug).toBe("platos.web_search");
  });

  it("binds and hands back a binding id for agents to record", async () => {
    await seed(harnessed, "platos.web_search");
    const bound = await harnessed.contract.bind({ scope: SCOPE, reference: "platos.web_search" });
    if (!bound.ok) throw new Error(bound.error.code);
    expect(typeof bound.value.environmentSkillId).toBe("string");
  });

  it("REFUSES to bind a skill whose keys are unset", async () => {
    await seed(harnessed, "a.b", ["MISSING_KEY"]);
    const bound = await harnessed.contract.bind({ scope: SCOPE, reference: "a.b" });
    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error("unreachable");
    expect(bound.error.code).toBe("SKILLS_ENVIRONMENT_KEYS_MISSING");
  });

  it("composes a runtime payload from binding ids alone", async () => {
    await seed(harnessed, "platos.web_search");
    const bound = await harnessed.contract.bind({ scope: SCOPE, reference: "platos.web_search" });
    if (!bound.ok) throw new Error(bound.error.code);

    const composed = await harnessed.contract.composeRuntime({
      scope: SCOPE,
      environmentSkillIds: [bound.value.environmentSkillId],
      basePrompt: "Base.",
    });
    if (!composed.ok) throw new Error(composed.error.code);
    expect(composed.value.admitted).toEqual(["platos.web_search"]);
    expect(composed.value.systemPrompt.startsWith("Base.\n\n---\n\n")).toBe(true);
    expect(composed.value.truncated).toBe(false);
  });

  it("patches presentation without moving identity", async () => {
    const registered = await harnessed.contract.register({
      scope: SCOPE,
      source: skillSource({ id: "acme.thing", name: "Before" }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    const patched = await harnessed.contract.patch({
      scope: SCOPE,
      reference: "acme.thing",
      name: "After",
      tags: ["x"],
    });
    if (!patched.ok) throw new Error(patched.error.code);
    expect(patched.value.name).toBe("After");
    expect(patched.value.tags).toEqual(["x"]);
    expect(patched.value.slug).toBe(registered.value.slug);
    expect(patched.value.version).toBe(registered.value.version);
  });

  it("treats an empty patch as a read, leaving updatedAt alone", async () => {
    const registered = await harnessed.contract.register({
      scope: SCOPE,
      source: skillSource({ id: "acme.thing" }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    harnessed.context.clock.advanceSeconds(60);
    const patched = await harnessed.contract.patch({ scope: SCOPE, reference: "acme.thing" });
    if (!patched.ok) throw new Error(patched.error.code);
    expect(patched.value.updatedAt).toEqual(registered.value.updatedAt);
  });

  it("uninstalls, and refuses an official row with a reason", async () => {
    await seed(harnessed, "platos.web_search");
    const refused = await harnessed.contract.uninstall({ scope: SCOPE, reference: "platos.web_search" });
    if (!refused.ok) throw new Error(refused.error.code);
    expect(refused.value).toEqual({
      uninstalled: false,
      refusedBecause: "SKILLS_OFFICIAL_SKILL_IMMUTABLE",
    });
  });

  it("runs a tool through the published surface", async () => {
    const registered = await harnessed.contract.register({
      scope: SCOPE,
      source: skillSource({ id: "a.b", tools: [{ name: "go", handler: "h" }] }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    harnessed.context.sandbox.put("h", { done: true });

    const outcome = await harnessed.contract.runTool({
      scope: SCOPE,
      reference: "a.b",
      toolName: registered.value.providesTools[0]!.name,
      input: {},
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(outcome.value.result).toEqual({ done: true });
    expect(outcome.value.usage.costCents).toBeNull();
  });

  it("exposes an erasure target naming this context", () => {
    expect(harnessed.contract.erasureTarget().targetName).toBe("skills");
  });

  it("returns the SAME erasure target every time, so a root wires one", () => {
    expect(harnessed.contract.erasureTarget()).toBe(harnessed.contract.erasureTarget());
  });

  it("reports a skill outside the scope as absent through every read", async () => {
    const described = await harnessed.contract.describe({ scope: SCOPE, reference: "nobody.here" });
    expect(described.ok).toBe(false);
    if (described.ok) throw new Error("unreachable");
    expect(described.error.category).toBe("not_found");
  });

  it("carries a domain failure out as a Result, never as a thrown error", async () => {
    const registered = await harnessed.contract.register({ scope: SCOPE, source: "not a skill" });
    expect(registered.ok).toBe(false);
    if (registered.ok) throw new Error("unreachable");
    expect(registered.error.code).toBe("SKILLS_MANIFEST_FRONTMATTER_MISSING");
  });
});
