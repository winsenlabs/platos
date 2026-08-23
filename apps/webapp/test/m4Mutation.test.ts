import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireEnvironmentScope } = vi.hoisted(() => ({
  requireEnvironmentScope: vi.fn(),
}));

vi.mock("../app/services/auth.server", () => ({ requireEnvironmentScope }));

import { m4Mutation } from "../app/services/m4Mutation.server";

function args(): ActionFunctionArgs {
  return {
    request: new Request("https://dashboard.example/mutation", {
      method: "POST",
      body: new URLSearchParams({ intent: "save" }),
    }),
    params: {
      organizationSlug: "org",
      projectParam: "project",
      envParam: "env",
    },
    context: {},
  };
}

describe("m4Mutation response semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireEnvironmentScope.mockResolvedValue({ scope: { environmentId: "env-1" } });
  });

  it("preserves thrown Remix redirects", async () => {
    const response = redirect("/login", 302);

    await expect(m4Mutation(args(), "Save", async () => {
      throw response;
    })).rejects.toBe(response);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("preserves thrown route responses from scope resolution", async () => {
    const response = new Response("Not found", { status: 404 });
    requireEnvironmentScope.mockRejectedValue(response);

    await expect(m4Mutation(args(), "Save", async () => ({ ok: true }))).rejects.toBe(response);
  });

  it("still serializes ordinary validation errors as mutation JSON", async () => {
    const response = await m4Mutation(args(), "Save", async () => {
      throw new Error("Name is required");
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Name is required" },
    });
  });
});
