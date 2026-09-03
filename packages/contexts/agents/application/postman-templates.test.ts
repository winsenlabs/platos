import { describe, expect, it } from "vitest";

import {
  asAgentsIdentifier,
  type AgentBindingId,
  type AgentId,
  type AgentVersionId,
  type PostmanTemplateId,
  type Slug,
} from "../domain/index.js";
import {
  createTemplate,
  describeTemplate,
  listTemplatesForAgent,
  pageTemplates,
  removeTemplate,
  updateTemplate,
} from "./postman-templates.js";
import {
  buildAgentsTestContext,
  seedBoundAgent,
  testEnvironmentScope,
  testTemplate,
} from "./testing/fixtures.js";

function newContext() {
  const context = buildAgentsTestContext();
  const authorization = context.tenancy.grant();
  const seeded = seedBoundAgent(context);
  return { context, authorization, seeded };
}

describe("creating a template", () => {
  it("writes it against an agent bound here", async () => {
    const { context, authorization, seeded } = newContext();
    const created = await createTemplate(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      name: "  Smoke  ",
      simulateUserId: " u1 ",
      createdBy: "operator-1",
    });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.name).toBe("Smoke");
    expect(created.value.simulateUserId).toBe("u1");
    expect(created.value.isDefault).toBe(false);
  });

  it("REFUSES an agent this environment does not serve", async () => {
    const { context, authorization } = newContext();
    const created = await createTemplate(context.dependencies, {
      authorization,
      agentId: asAgentsIdentifier<AgentId>("agent-nope"),
      name: "Smoke",
      simulateUserId: "u1",
      createdBy: "operator-1",
    });
    if (created.ok) throw new Error("unreachable");
    expect(created.error.code).toBe("AGENTS_AGENT_NOT_BOUND");
  });

  it("refuses a blank name before it touches the store", async () => {
    const { context, authorization, seeded } = newContext();
    const created = await createTemplate(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      name: "  ",
      simulateUserId: "u1",
      createdBy: "operator-1",
    });
    if (created.ok) throw new Error("unreachable");
    expect(created.error.code).toBe("AGENTS_TEMPLATE_INVALID");
    expect(context.scaffolding.writes).toEqual([]);
  });
});

describe("the single-default invariant", () => {
  it("demotes THIS AGENT'S incumbent when a new default is created", async () => {
    const { context, authorization, seeded } = newContext();
    const incumbent = context.scaffolding.seedTemplate(
      testTemplate(context.scope, seeded.agent.agentId, { isDefault: true }),
    );
    const created = await createTemplate(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      name: "New default",
      simulateUserId: "u1",
      isDefault: true,
      createdBy: "operator-1",
    });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.isDefault).toBe(true);
    expect(context.scaffolding.templates.get(incumbent.templateId)?.isDefault).toBe(false);
  });

  it("DOES NOT TOUCH ANOTHER AGENT'S DEFAULT in the same environment", async () => {
    // One missing clause here clears the default template of every other agent
    // in the environment, with no error and nothing an operator would notice.
    const { context, authorization, seeded } = newContext();
    const sibling = seedBoundAgent(context, {
      agent: { agentId: asAgentsIdentifier<AgentId>("agent-2"), slug: asAgentsIdentifier<Slug>("second") },
      version: { agentVersionId: asAgentsIdentifier<AgentVersionId>("version-2") },
      binding: { agentBindingId: asAgentsIdentifier<AgentBindingId>("binding-2") },
    });
    const siblingDefault = context.scaffolding.seedTemplate(
      testTemplate(context.scope, sibling.agent.agentId, {
        templateId: asAgentsIdentifier<PostmanTemplateId>("template-sibling"),
        isDefault: true,
      }),
    );
    await createTemplate(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      name: "New default",
      simulateUserId: "u1",
      isDefault: true,
      createdBy: "operator-1",
    });
    expect(context.scaffolding.templates.get(siblingDefault.templateId)?.isDefault).toBe(true);
  });

  it("does not touch a default in ANOTHER environment", async () => {
    const { context, authorization, seeded } = newContext();
    const elsewhere = context.scaffolding.seedTemplate(
      testTemplate(testEnvironmentScope("env-9"), seeded.agent.agentId, {
        templateId: asAgentsIdentifier<PostmanTemplateId>("template-elsewhere"),
        isDefault: true,
      }),
    );
    await createTemplate(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      name: "New default",
      simulateUserId: "u1",
      isDefault: true,
      createdBy: "operator-1",
    });
    expect(context.scaffolding.templates.get(elsewhere.templateId)?.isDefault).toBe(true);
  });

  it("demotes the incumbent on a PROMOTING patch too", async () => {
    const { context, authorization, seeded } = newContext();
    const incumbent = context.scaffolding.seedTemplate(
      testTemplate(context.scope, seeded.agent.agentId, { isDefault: true }),
    );
    const challenger = context.scaffolding.seedTemplate(
      testTemplate(context.scope, seeded.agent.agentId, {
        templateId: asAgentsIdentifier<PostmanTemplateId>("template-2"),
      }),
    );
    const patched = await updateTemplate(context.dependencies, {
      authorization,
      templateId: challenger.templateId,
      isDefault: true,
    });
    if (!patched.ok) throw new Error("unreachable");
    expect(patched.value.isDefault).toBe(true);
    expect(context.scaffolding.templates.get(incumbent.templateId)?.isDefault).toBe(false);
  });

  it("does not demote the template being promoted, so re-promoting is a no-op", async () => {
    const { context, authorization, seeded } = newContext();
    const incumbent = context.scaffolding.seedTemplate(
      testTemplate(context.scope, seeded.agent.agentId, { isDefault: true }),
    );
    const patched = await updateTemplate(context.dependencies, {
      authorization,
      templateId: incumbent.templateId,
      isDefault: true,
    });
    if (!patched.ok) throw new Error("unreachable");
    expect(patched.value.isDefault).toBe(true);
  });

  it("demotes nothing when the patch does not promote", async () => {
    const { context, authorization, seeded } = newContext();
    const incumbent = context.scaffolding.seedTemplate(
      testTemplate(context.scope, seeded.agent.agentId, { isDefault: true }),
    );
    await updateTemplate(context.dependencies, {
      authorization,
      templateId: incumbent.templateId,
      name: "Renamed",
    });
    expect(context.scaffolding.templates.get(incumbent.templateId)?.isDefault).toBe(true);
  });
});

describe("reading templates", () => {
  it("orders defaults first", async () => {
    const { context, authorization, seeded } = newContext();
    context.scaffolding.seedTemplate(
      testTemplate(context.scope, seeded.agent.agentId, {
        templateId: asAgentsIdentifier<PostmanTemplateId>("template-plain"),
      }),
    );
    context.scaffolding.seedTemplate(
      testTemplate(context.scope, seeded.agent.agentId, {
        templateId: asAgentsIdentifier<PostmanTemplateId>("template-default"),
        isDefault: true,
      }),
    );
    const listed = await listTemplatesForAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value[0]?.templateId).toBe("template-default");
  });

  it("narrows a page by agent and clamps its size", async () => {
    const { context, authorization, seeded } = newContext();
    context.scaffolding.seedTemplate(testTemplate(context.scope, seeded.agent.agentId));
    context.scaffolding.seedTemplate(
      testTemplate(context.scope, asAgentsIdentifier<AgentId>("agent-2"), {
        templateId: asAgentsIdentifier<PostmanTemplateId>("template-2"),
      }),
    );
    const paged = await pageTemplates(context.dependencies, {
      authorization,
      limit: 10_000,
      offset: -1,
      agentId: seeded.agent.agentId,
    });
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.value.total).toBe(1);
  });

  it("treats a blank search as no search", async () => {
    const { context, authorization, seeded } = newContext();
    context.scaffolding.seedTemplate(testTemplate(context.scope, seeded.agent.agentId));
    const paged = await pageTemplates(context.dependencies, {
      authorization,
      limit: 10,
      offset: 0,
      search: "   ",
    });
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.value.total).toBe(1);
  });

  it("describes one, and refuses one from another environment", async () => {
    const { context, authorization, seeded } = newContext();
    const held = context.scaffolding.seedTemplate(testTemplate(context.scope, seeded.agent.agentId));
    const described = await describeTemplate(context.dependencies, {
      authorization,
      templateId: held.templateId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.templateId).toBe(held.templateId);

    context.scaffolding.seedTemplate(
      testTemplate(testEnvironmentScope("env-9"), seeded.agent.agentId, {
        templateId: asAgentsIdentifier<PostmanTemplateId>("template-elsewhere"),
      }),
    );
    const foreign = await describeTemplate(context.dependencies, {
      authorization,
      templateId: asAgentsIdentifier<PostmanTemplateId>("template-elsewhere"),
    });
    if (foreign.ok) throw new Error("unreachable");
    expect(foreign.error.code).toBe("AGENTS_TEMPLATE_NOT_FOUND");
  });
});

describe("deleting a template", () => {
  it("removes one in this environment", async () => {
    const { context, authorization, seeded } = newContext();
    const held = context.scaffolding.seedTemplate(testTemplate(context.scope, seeded.agent.agentId));
    const removed = await removeTemplate(context.dependencies, {
      authorization,
      templateId: held.templateId,
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value).toBe(true);
  });

  it("answers false for one it cannot see, rather than confirming it exists", async () => {
    const { context, authorization, seeded } = newContext();
    context.scaffolding.seedTemplate(
      testTemplate(testEnvironmentScope("env-9"), seeded.agent.agentId, {
        templateId: asAgentsIdentifier<PostmanTemplateId>("template-elsewhere"),
      }),
    );
    const removed = await removeTemplate(context.dependencies, {
      authorization,
      templateId: asAgentsIdentifier<PostmanTemplateId>("template-elsewhere"),
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value).toBe(false);
  });
});
