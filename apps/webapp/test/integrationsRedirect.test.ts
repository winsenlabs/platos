import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUserId } = vi.hoisted(() => ({ requireUserId: vi.fn() }));

vi.mock("~/services/session.server", () => ({ requireUserId }));

import { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations/route";

const params = {
  organizationSlug: "acme",
  projectParam: "assistant",
  envParam: "prod",
};

describe("project integrations route", () => {
  beforeEach(() => {
    requireUserId.mockResolvedValue("user_1");
  });

  it("redirects the parent route to retained MCP management and preserves search", async () => {
    const response = await loader({
      request: new Request(
        "https://platos.example/orgs/acme/projects/assistant/env/prod/settings/integrations?from=nav"
      ),
      params,
      context: {},
    });

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(302);
    expect(response?.headers.get("Location")).toBe(
      "/orgs/acme/projects/assistant/env/prod/settings/integrations/mcp?from=nav"
    );
  });

  it("allows the nested MCP route to render", async () => {
    const result = await loader({
      request: new Request(
        "https://platos.example/orgs/acme/projects/assistant/env/prod/settings/integrations/mcp"
      ),
      params,
      context: {},
    });

    expect(result).toBeNull();
  });
});
