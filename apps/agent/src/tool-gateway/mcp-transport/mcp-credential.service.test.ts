/**
 * Per-user isolation invariant for MCP consumption (design §3.2 / §3.3 / AC3+AC4).
 *
 * This is the NEW fail-CLOSED rule — deliberately NOT the fail-OPEN OIDC path.
 * It gets its own test (design Commit 2 / GAP-6):
 *
 *   - templated `{{endUserId}}` + no end user  ⇒ structured McpCredentialError,
 *     thrown BEFORE any secret is fetched and BEFORE any header/URL is emitted
 *     (nothing can be dispatched; the secret store is never touched);
 *   - templated + a real end user               ⇒ interpolated;
 *   - two DIFFERENT end users                    ⇒ two different resolved
 *     identities → two different `credentialHash`es → two different pool keys
 *     (users can never share a pooled session).
 *
 * CLAUDE.md §9.11: Vitest only, no mocks. `ScopedEnvService` is replaced with a
 * hand-built in-memory stub (a fake, not a mock framework) that records whether
 * the secret store was ever consulted.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  McpCredentialService,
  McpCredentialError,
  type CredentialServerSlice,
} from "./mcp-credential.service";
import type {
  ScopedEnvService,
  ScopeTuple,
} from "../../providers/scoped-env.service";

const SCOPE: ScopeTuple = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
};

/**
 * In-memory ScopedEnvService fake. Returns a fixed secret for any key and
 * records the number of lookups so a test can assert the store was NEVER
 * consulted when the fail-closed guard fires first.
 */
class FakeScopedEnv {
  public getCalls = 0;
  constructor(private readonly secret: string | undefined) {}
  async get(_scope: ScopeTuple, _name: string): Promise<string | undefined> {
    this.getCalls += 1;
    return this.secret;
  }
}

function makeService(secret: string | undefined = "sk-test-123"): {
  svc: McpCredentialService;
  env: FakeScopedEnv;
} {
  const env = new FakeScopedEnv(secret);
  const svc = new McpCredentialService(env as unknown as ScopedEnvService);
  return { svc, env };
}

describe("McpCredentialService.resolveHeaders — {{endUserId}} fail-closed guard", () => {
  let svc: McpCredentialService;
  let env: FakeScopedEnv;
  beforeEach(() => {
    ({ svc, env } = makeService());
  });

  it("throws a structured McpCredentialError when a header is templated but no end user is resolved", async () => {
    const server: CredentialServerSlice = {
      headersTemplate: { "X-User-Id": "{{endUserId}}" },
    };
    await expect(svc.resolveHeaders(server, SCOPE, null)).rejects.toBeInstanceOf(
      McpCredentialError,
    );
    await expect(svc.resolveHeaders(server, SCOPE, null)).rejects.toThrow(
      "tool requires a linked end user",
    );
  });

  it("treats an empty-string end user as unresolved (still fails closed)", async () => {
    const server: CredentialServerSlice = {
      headersTemplate: { "X-User-Id": "{{endUserId}}" },
    };
    await expect(svc.resolveHeaders(server, SCOPE, "")).rejects.toBeInstanceOf(
      McpCredentialError,
    );
  });

  it("NEVER touches the secret store when the end-user guard fires — even if the header also references {{secret}}", async () => {
    const server: CredentialServerSlice = {
      headersTemplate: { Authorization: "Bearer {{secret}}-{{endUserId}}" },
      credsSecretKey: "MY_KEY",
    };
    await expect(
      svc.resolveHeaders(server, SCOPE, null),
    ).rejects.toBeInstanceOf(McpCredentialError);
    // The guard is evaluated before any secret fetch — nothing dispatched,
    // nothing decrypted.
    expect(env.getCalls).toBe(0);
  });

  it("does NOT fire the guard for a static header set when no end user is present", async () => {
    const server: CredentialServerSlice = {
      headersTemplate: { "X-Api-Version": "2026-07-22" },
    };
    const resolved = await svc.resolveHeaders(server, SCOPE, null);
    expect(resolved).toEqual({ "X-Api-Version": "2026-07-22" });
  });

  it("interpolates {{endUserId}} into header values when the end user is resolved", async () => {
    const server: CredentialServerSlice = {
      headersTemplate: { "X-User-Id": "acct-{{endUserId}}" },
    };
    const resolved = await svc.resolveHeaders(server, SCOPE, "alice");
    expect(resolved).toEqual({ "X-User-Id": "acct-alice" });
  });

  it("interpolates BOTH {{secret}} and {{endUserId}} in the same value", async () => {
    const server: CredentialServerSlice = {
      headersTemplate: { Authorization: "Bearer {{secret}}::{{endUserId}}" },
      credsSecretKey: "MY_KEY",
    };
    const resolved = await svc.resolveHeaders(server, SCOPE, "bob");
    expect(resolved).toEqual({ Authorization: "Bearer sk-test-123::bob" });
    expect(env.getCalls).toBe(1);
  });
});

describe("McpCredentialService.resolveUrl — {{endUserId}} fail-closed guard", () => {
  let svc: McpCredentialService;
  beforeEach(() => {
    ({ svc } = makeService());
  });

  it("passes a non-templated URL through unchanged even with no end user", () => {
    const url = "https://api.example.com/mcp";
    expect(svc.resolveUrl(url, null)).toBe(url);
    expect(svc.resolveUrl(url, "alice")).toBe(url);
  });

  it("throws when the URL is templated but no end user is resolved", () => {
    expect(() =>
      svc.resolveUrl("https://api.example.com/u/{{endUserId}}/mcp", null),
    ).toThrow(McpCredentialError);
    expect(() =>
      svc.resolveUrl("https://api.example.com/u/{{endUserId}}/mcp", ""),
    ).toThrow("tool requires a linked end user");
  });

  it("interpolates {{endUserId}} into the URL when resolved", () => {
    expect(
      svc.resolveUrl("https://api.example.com/u/{{endUserId}}/mcp", "alice"),
    ).toBe("https://api.example.com/u/alice/mcp");
  });
});

describe("Per-user isolation invariant — two end users never share an identity or pool key (AC3)", () => {
  it("two different end users → different resolved headers, different credentialHash, different pool key", async () => {
    const { svc } = makeService();
    const entityId = "entity_xyz";
    const server: CredentialServerSlice = {
      headersTemplate: { "X-User-Id": "{{endUserId}}" },
    };
    const urlTemplate = "https://composio.example.com/u/{{endUserId}}/mcp";

    const aliceHeaders = await svc.resolveHeaders(server, SCOPE, "alice");
    const bobHeaders = await svc.resolveHeaders(server, SCOPE, "bob");
    expect(aliceHeaders).toEqual({ "X-User-Id": "alice" });
    expect(bobHeaders).toEqual({ "X-User-Id": "bob" });

    const aliceUrl = svc.resolveUrl(urlTemplate, "alice");
    const bobUrl = svc.resolveUrl(urlTemplate, "bob");
    expect(aliceUrl).not.toBe(bobUrl);

    const aliceHash = svc.credentialHash(aliceHeaders);
    const bobHash = svc.credentialHash(bobHeaders);
    expect(aliceHash).not.toBe(bobHash);

    // The pool key is `${entity.id}:${resolvedUrl}:${credentialHash}` (design
    // §3.3). Because BOTH the resolved URL and the header hash carry the
    // substituted id, the two users key to different pooled sessions — they can
    // never reuse each other's connection.
    const aliceKey = `${entityId}:${aliceUrl}:${aliceHash}`;
    const bobKey = `${entityId}:${bobUrl}:${bobHash}`;
    expect(aliceKey).not.toBe(bobKey);
  });

  it("the SAME end user resolves to a stable hash (same pooled session reused)", async () => {
    const { svc } = makeService();
    const server: CredentialServerSlice = {
      headersTemplate: { "X-User-Id": "{{endUserId}}" },
    };
    const h1 = await svc.resolveHeaders(server, SCOPE, "alice");
    const h2 = await svc.resolveHeaders(server, SCOPE, "alice");
    expect(svc.credentialHash(h1)).toBe(svc.credentialHash(h2));
  });
});
