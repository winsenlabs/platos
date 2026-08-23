/**
 * Regression: a wire entity's signing key is a Credential, not a variable.
 *
 * ToolExecutorService looks up the entity's ENTITY_SECRET row and passes its
 * `name` (the entity's externalId) to resolveCredentialReference, which only
 * consulted `scopedEnv.get()` — and that reads `EnvironmentVariable`. The two
 * live in different tables, so the lookup could never succeed and every signed
 * outbound tool call returned "signing credential is unavailable", while
 * tool-sync stayed connected because it authenticates by hash instead.
 */
import { describe, expect, it, vi } from "vitest";
import { McpCredentialService } from "./mcp-credential.service";

const SCOPE = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
} as any;

function makeService(options: {
  variables?: Record<string, string>;
  entitySecrets?: Record<string, string>;
}) {
  const get = vi.fn(async (_scope: unknown, name: string) => options.variables?.[name]);
  const getEntitySecret = vi.fn(
    async (_scope: unknown, name: string) => options.entitySecrets?.[name],
  );
  const service = new McpCredentialService({ get, getEntitySecret } as any);
  return { service, get, getEntitySecret };
}

describe("resolveCredentialReference", () => {
  it("resolves a wire entity's ENTITY_SECRET without consulting variables", async () => {
    const { service, get, getEntitySecret } = makeService({
      variables: { "walle-mcp-service": "poisoning-variable" },
      entitySecrets: { "walle-mcp-service": "bare-signing-secret" },
    });

    await expect(
      service.resolveEntitySigningCredential(SCOPE, "walle-mcp-service"),
    ).resolves.toBe("bare-signing-secret");

    expect(get).not.toHaveBeenCalled();
    expect(getEntitySecret).toHaveBeenCalledWith(SCOPE, "walle-mcp-service");
  });

  it("still resolves MCP header templates from Environment variables", async () => {
    const { service, getEntitySecret } = makeService({
      variables: { MY_MCP_TOKEN: "from-variable" },
      entitySecrets: { MY_MCP_TOKEN: "from-credential" },
    });

    await expect(
      service.resolveCredentialReference(SCOPE, "MY_MCP_TOKEN"),
    ).resolves.toBe("from-variable");
    expect(getEntitySecret).not.toHaveBeenCalled();
  });

  it("returns undefined when an MCP variable is absent", async () => {
    const { service } = makeService({});
    await expect(
      service.resolveCredentialReference(SCOPE, "nothing-here"),
    ).resolves.toBeUndefined();
  });
});
