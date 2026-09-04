import { asIdentifier, organizationScope } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { parseSkillSource } from "../domain/index.js";
import { bindSkill, findBinding } from "./bind-skill.js";
import { registerOfficialSkill, registerSkillFromSource } from "./register-skill.js";
import {
  buildSkillsTestContext,
  scopeFor,
  skillSource,
  type SkillsTestContext,
} from "./testing/index.js";

const ORG = organizationScope(asIdentifier("org-1"));
const SCOPE = scopeFor("org-1", "proj-1", "env-1");

function parsed(source: string) {
  const result = parseSkillSource(source);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("bindSkill", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("MATERIALISES the install for an official skill that had none", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search" })),
    });
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(0);

    const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: "platos.web_search" });
    if (!bound.ok) throw new Error(bound.error.code);
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(1);
    expect(bound.value.installation.environment.enabled).toBe(true);
  });

  it("reuses the existing binding for a skill already installed", async () => {
    const registered = await registerSkillFromSource(context.dependencies, {
      scope: SCOPE,
      source: skillSource({ id: "acme.thing" }),
    });
    if (!registered.ok) throw new Error(registered.error.code);
    const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: "acme.thing" });
    if (!bound.ok) throw new Error(bound.error.code);
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(1);
  });

  it("binds a skill that requires nothing without consulting the directory", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.rag" })),
    });
    const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: "platos.rag" });
    expect(bound.ok).toBe(true);
    expect(context.environmentKeys.queries).toHaveLength(0);
  });

  it("binds once every required key is set", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search", requiredEnv: ["TAVILY_API_KEY"] })),
    });
    context.environmentKeys.setKey("TAVILY_API_KEY");
    const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: "platos.web_search" });
    expect(bound.ok).toBe(true);
  });

  it("REFUSES a skill whose required key is unset, naming the missing key", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search", requiredEnv: ["TAVILY_API_KEY"] })),
    });
    const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: "platos.web_search" });
    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error("unreachable");
    expect(bound.error.code).toBe("SKILLS_ENVIRONMENT_KEYS_MISSING");
    expect(bound.error.details.missing).toEqual(["TAVILY_API_KEY"]);
  });

  it("names EVERY missing key, not merely the first", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "a.b", requiredEnv: ["ONE", "TWO", "THREE"] })),
    });
    context.environmentKeys.setKey("TWO");
    const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: "a.b" });
    if (bound.ok) throw new Error("unreachable");
    expect(bound.error.details.missing).toEqual(["ONE", "THREE"]);
  });

  it("does NOT leave a materialised install behind when it refuses", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search", requiredEnv: ["TAVILY_API_KEY"] })),
    });
    const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: "platos.web_search" });
    expect(bound.ok).toBe(false);
    // The gate runs before anything is written. A refusal that installed the
    // skill anyway would leave rows behind as a side effect of saying no.
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(0);
    expect(context.repository.allProjectInstallations()).toHaveLength(0);
  });

  it("ignores an OPTIONAL key that is unset", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "a.b", optionalEnv: ["NICE_TO_HAVE"] })),
    });
    const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: "a.b" });
    expect(bound.ok).toBe(true);
  });

  it("REFUSES a skill this scope cannot see", async () => {
    const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: "nobody.here" });
    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error("unreachable");
    expect(bound.error.code).toBe("SKILLS_SKILL_NOT_FOUND");
  });

  it("propagates a directory outage rather than treating it as unset keys", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "a.b", requiredEnv: ["K"] })),
    });
    context.environmentKeys.failNext("directory unreachable");
    const bound = await bindSkill(context.dependencies, { scope: SCOPE, reference: "a.b" });
    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error("unreachable");
    // Not SKILLS_ENVIRONMENT_KEYS_MISSING: an outage is not evidence that a key
    // is unset, and reporting it as one would send an operator hunting a
    // configuration problem that does not exist.
    expect(bound.error.code).not.toBe("SKILLS_ENVIRONMENT_KEYS_MISSING");
  });
});

describe("findBinding", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("does NOT materialise an install for an official skill", async () => {
    await registerOfficialSkill(context.dependencies, {
      organization: ORG,
      parsed: parsed(skillSource({ id: "platos.web_search" })),
    });
    const found = await findBinding(context.dependencies, { scope: SCOPE, reference: "platos.web_search" });
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value).toBeNull();
    // Unbinding something never installed must not install it first.
    expect(context.repository.allEnvironmentInstallations()).toHaveLength(0);
  });

  it("does NOT gate on readiness", async () => {
    await registerSkillFromSource(context.dependencies, {
      scope: SCOPE,
      source: skillSource({ id: "acme.thing", requiredEnv: ["NEVER_SET"] }),
    });
    const found = await findBinding(context.dependencies, { scope: SCOPE, reference: "acme.thing" });
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value).not.toBeNull();
  });

  it("reports null for a skill this scope cannot see, rather than failing", async () => {
    const found = await findBinding(context.dependencies, { scope: SCOPE, reference: "nobody.here" });
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value).toBeNull();
  });
});
