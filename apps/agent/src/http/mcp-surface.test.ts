/**
 * WIN-268 (M4.2) P1 — the MCP version expression, and the two doors that used to
 * disagree.
 *
 * `scripts/arch/mcp-surface.mjs` proves nothing in the tree spells either axis
 * twice, and `mcp-platform/control-plane-contract.test.ts` proves the platform
 * server's handshake matches the generated manifest. What neither can see is the
 * DOCS server, whose catalog is not in the manifest and whose defect was of a
 * different kind: it advertised its version through TWO handlers — the JSON-RPC
 * `initialize` result and the `GET /mcp/docs` capability probe — each with its
 * own `"0.1.0"` literal. Editing one and not the other was a one-character
 * mistake that no test in this repository could have caught, because nothing
 * compared them.
 *
 * So this file drives BOTH handlers of the real controller and requires them to
 * agree, and it takes the value from neither: the expected version is the
 * constant, and the constant is joined to the generated manifest by the lint.
 *
 * THE SERVICE IS A STUB AND THE CONTROLLER IS REAL. The subject is the two
 * handlers' agreement about the version, and `DocsMcpService` owns document
 * search and a Redis rate limiter — neither of which is on the path being
 * measured. `docs-mcp.test.ts` covers the service against the real content tree.
 */
import { describe, expect, it } from "vitest";

import { DocsMcpController } from "../mcp-docs/docs-mcp.controller";
import type { DocsMcpService } from "../mcp-docs/docs-mcp.service";
import {
  DOCS_MCP_SERVER_NAME,
  ENTITY_MCP_SCOPES,
  MCP_PROTOCOL_VERSION,
  PLATFORM_MCP_SCOPES,
  PLATOS_MCP_CONTRACT_MAJOR,
  PLATOS_MCP_CONTRACT_META_KEY,
  PLATOS_MCP_CONTRACT_VERSION,
  canonicalJson,
  entityMcpServerName,
  mcpCatalogDigest,
  mcpScopeSetDigest,
  mcpServerInfo,
  toolSchemaHash,
} from "./mcp-surface";

/** Only what the two handlers under test touch. */
function fakeResponse(): {
  readonly captured: { status: number; body: unknown };
  status(code: number): unknown;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
} {
  const captured = { status: 0, body: undefined as unknown };
  const response = {
    captured,
    status(code: number) {
      captured.status = code;
      return response;
    },
    json(body: unknown) {
      captured.body = body;
      return response;
    },
    setHeader() {
      return response;
    },
  };
  return response;
}

const fakeRequest = { headers: {}, socket: { remoteAddress: "203.0.113.7" } } as never;

function controller(): DocsMcpController {
  const service = {
    async checkRateLimit() {
      return { ok: true, retryAfter: 0 };
    },
  } as unknown as DocsMcpService;
  return new DocsMcpController(service);
}

describe("WIN-268 P1 — the MCP contract is spelled once", () => {
  it("reports the same version from the handshake and from the capability probe", async () => {
    const docs = controller();

    const handshake = fakeResponse();
    await docs.jsonRpc(fakeRequest, handshake as never, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    } as never);
    const result = (handshake.captured.body as { result: Record<string, unknown> }).result;
    const serverInfo = result["serverInfo"] as { name: string; version: string };

    const probe = fakeResponse();
    await docs.getInfo(fakeRequest, probe as never);
    const advertised = probe.captured.body as Record<string, unknown>;

    // THE DEFECT THIS CASE EXISTS FOR: two literals, one edited, nothing red.
    expect(serverInfo.version).toBe(advertised["version"]);
    expect(serverInfo.name).toBe(advertised["service"]);
    expect(result["protocolVersion"]).toBe(advertised["protocolVersion"]);

    // And neither is a value this file chose: both are the one constant.
    expect(serverInfo.version).toBe(PLATOS_MCP_CONTRACT_VERSION);
    expect(serverInfo.name).toBe(DOCS_MCP_SERVER_NAME);
    expect(result["protocolVersion"]).toBe(MCP_PROTOCOL_VERSION);
  });

  it("carries the contract block, and a catalog digest over the tools it actually lists", async () => {
    const docs = controller();

    const handshake = fakeResponse();
    await docs.jsonRpc(fakeRequest, handshake as never, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    } as never);
    const serverInfo = (
      (handshake.captured.body as { result: Record<string, unknown> }).result[
        "serverInfo"
      ] as { _meta: Record<string, Record<string, unknown>> }
    )._meta[PLATOS_MCP_CONTRACT_META_KEY];

    const listed = fakeResponse();
    await docs.jsonRpc(fakeRequest, listed as never, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    } as never);
    const tools = (
      (listed.captured.body as { result: { tools: Array<{ name: string; inputSchema: unknown }> } })
        .result
    ).tools;

    // NOT VACUOUS: the digest of an empty catalog is a fixed value, and a server
    // that had stopped listing anything would still "agree" with itself.
    expect(tools.length).toBeGreaterThan(0);
    expect(serverInfo?.["major"]).toBe(PLATOS_MCP_CONTRACT_MAJOR);
    expect(serverInfo?.["catalogDigest"]).toBe(mcpCatalogDigest(tools));
    // No scope set: this surface is unauthenticated. The field is an explicit
    // null rather than a digest of the empty set, which would be
    // indistinguishable from a real one-scope answer.
    expect(serverInfo?.["scopeSetDigest"]).toBeNull();
    expect(serverInfo?.["rateTableVersion"]).toBeNull();
  });

  it("names the entity server per entity and every other server once", () => {
    // ONE deployable serves MANY entity servers, so the name is the only part of
    // the handshake that varies — and the PREFIX is the part that is a surface
    // decision. A client connected to two entities must be able to tell them
    // apart in a log.
    expect(entityMcpServerName("acme-crm")).toBe("platos-entity-mcp:acme-crm");
    expect(entityMcpServerName("acme-crm")).not.toBe(entityMcpServerName("acme-erp"));
    // Every server reports the SAME contract major — ADR M0.4 §5's "assert
    // serverInfo.version MAJOR === const MAJOR across all 3".
    for (const name of ["platos-platform-mcp", DOCS_MCP_SERVER_NAME, entityMcpServerName("x")]) {
      expect(mcpServerInfo(name).version).toBe(PLATOS_MCP_CONTRACT_VERSION);
      expect(mcpServerInfo(name)._meta[PLATOS_MCP_CONTRACT_META_KEY]?.major).toBe(
        PLATOS_MCP_CONTRACT_MAJOR,
      );
    }
  });

  it("canonicalises object keys but not array order", () => {
    // A REFORMAT IS NOT A BREAKING CHANGE (ADR M0.4 §5 item 5). Two schemas that
    // differ only in property order must hash the same, or every tidy-up would
    // report a contract break.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(toolSchemaHash({ type: "object", required: ["a"] })).toBe(
      toolSchemaHash({ required: ["a"], type: "object" }),
    );
    // ARRAY ORDER IS SEMANTIC in JSON Schema (`required`, `enum`, `oneOf`), so
    // it must NOT be normalised away.
    expect(toolSchemaHash({ enum: ["a", "b"] })).not.toBe(toolSchemaHash({ enum: ["b", "a"] }));
  });

  it("moves the schema hash when a required input is added or an enum narrowed", () => {
    // The two changes ADR M0.4 §2 calls breaking. If the hash did not move for
    // them, `catalogDigest` would be a value that could not detect the thing it
    // exists to detect.
    const base = { type: "object", properties: { a: { type: "string" } }, required: [] };
    expect(toolSchemaHash(base)).not.toBe(toolSchemaHash({ ...base, required: ["a"] }));
    const wide = { type: "object", properties: { a: { enum: ["x", "y"] } } };
    const narrow = { type: "object", properties: { a: { enum: ["x"] } } };
    expect(toolSchemaHash(wide)).not.toBe(toolSchemaHash(narrow));
  });

  it("moves the catalog digest when a tool flips to admin-only", () => {
    // The invisible one: an admin-only tool disappears from every scope-tier
    // client's `tools/list` while its name, description and schema are
    // unchanged. A digest over schemas alone would not notice.
    const tools = [{ name: "a.b", inputSchema: { type: "object" } }];
    expect(mcpCatalogDigest(tools)).not.toBe(
      mcpCatalogDigest([{ ...tools[0]!, requiresAdminTier: true }]),
    );
    // And it does NOT move for a re-ordering of the same catalog: two processes
    // that registered the same tools in a different order must agree.
    const two = [
      { name: "a.b", inputSchema: { type: "object" } },
      { name: "a.c", inputSchema: { type: "object" } },
    ];
    expect(mcpCatalogDigest(two)).toBe(mcpCatalogDigest([...two].reverse()));
  });

  it("moves the scope-set digest when a grant is removed — the change no client can see", () => {
    // ADR M0.4 §4: narrowing a scope is invisible to a client whose token still
    // validates. This digest is the only place it is observable at all.
    expect(mcpScopeSetDigest([PLATFORM_MCP_SCOPES])).not.toBe(
      mcpScopeSetDigest([["mcp:read"]]),
    );
    expect(mcpScopeSetDigest([PLATFORM_MCP_SCOPES])).not.toBe(
      mcpScopeSetDigest([ENTITY_MCP_SCOPES]),
    );
    // Order-insensitive and duplicate-insensitive: the SET is what is versioned.
    expect(mcpScopeSetDigest([["mcp:write", "mcp:read"]])).toBe(
      mcpScopeSetDigest([PLATFORM_MCP_SCOPES]),
    );
  });
});
