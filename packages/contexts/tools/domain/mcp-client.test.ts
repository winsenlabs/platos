import { describe, expect, it } from "vitest";

import {
  admitTransport,
  assertNoResidual,
  credentialFingerprintSource,
  END_USER_TOKEN,
  normalizeHeaderTemplate,
  residualToken,
  resolveTransport,
  SECRET_TOKEN,
  sessionPoolKey,
  templateRequirements,
} from "./mcp-client.js";
import { asToolsIdentifier, type ToolName } from "./identifiers.js";

const TOOL = asToolsIdentifier<ToolName>("composio.list_items");

describe("coercing the headers template column", () => {
  it("parses a template that was serialised into the Json column as a string", () => {
    expect(normalizeHeaderTemplate('{"X-Key":"{{secret}}"}', false)).toEqual({
      "X-Key": SECRET_TOKEN,
    });
  });

  it("yields nothing from an array, which typeof calls an object", () => {
    expect(normalizeHeaderTemplate([{ "X-Key": "v" }], false)).toEqual({});
  });

  it("SKIPS a non-string value rather than stringifying it into a header", () => {
    expect(normalizeHeaderTemplate({ "X-Key": 7, "X-Ok": "v" }, false)).toEqual({ "X-Ok": "v" });
  });

  it("survives an unparseable string without throwing on a read path", () => {
    expect(normalizeHeaderTemplate("{not json", false)).toEqual({});
  });

  it("defaults to a bearer header when a credential is set and no template is", () => {
    expect(normalizeHeaderTemplate(null, true)).toEqual({ Authorization: `Bearer ${SECRET_TOKEN}` });
    expect(normalizeHeaderTemplate(null, false)).toEqual({});
  });
});

describe("reading a template's demands without touching anything", () => {
  it("sees a secret in a header and an end user in a URL", () => {
    expect(
      templateRequirements({ Authorization: `Bearer ${SECRET_TOKEN}` }, "https://x.test/u"),
    ).toEqual({ needsSecret: true, needsEndUser: false });
    expect(templateRequirements({}, `https://x.test/${END_USER_TOKEN}`)).toEqual({
      needsSecret: false,
      needsEndUser: true,
    });
  });

  it("does NOT read a secret demand out of a URL, which is never given one", () => {
    // Counting it would make this context read a credential out of the vault
    // for a call the residual scan is about to refuse anyway.
    expect(templateRequirements({}, `https://x.test/${SECRET_TOKEN}`).needsSecret).toBe(false);
  });
});

describe("the fail-closed per-user invariant", () => {
  const template = { "X-User": END_USER_TOKEN };

  it("REFUSES when a template names an end user and none is resolved", () => {
    for (const endUserId of [null, ""]) {
      const resolved = resolveTransport({
        template,
        urlTemplate: null,
        secret: null,
        endUserId,
        toolName: TOOL,
      });
      expect(resolved.ok).toBe(false);
      expect(!resolved.ok && resolved.error.code).toBe("TOOLS_END_USER_REQUIRED");
    }
  });

  it("never substitutes a default, a placeholder, or anything else", () => {
    const resolved = resolveTransport({
      template,
      urlTemplate: null,
      secret: null,
      endUserId: null,
      toolName: TOOL,
    });
    expect(resolved.ok).toBe(false);
  });

  it("refuses the URL form too, so the pool is never keyed on a half-substituted URL", () => {
    const resolved = resolveTransport({
      template: {},
      urlTemplate: `https://x.test/users/${END_USER_TOKEN}/items`,
      secret: null,
      endUserId: null,
      toolName: TOOL,
    });
    expect(!resolved.ok && resolved.error.code).toBe("TOOLS_END_USER_REQUIRED");
  });

  it("lets an untemplated URL through whether or not an end user is present", () => {
    for (const endUserId of [null, "user-9"]) {
      const resolved = resolveTransport({
        template: {},
        urlTemplate: "https://x.test/items",
        secret: null,
        endUserId,
        toolName: TOOL,
      });
      expect(resolved.ok && resolved.value.url).toBe("https://x.test/items");
    }
  });
});

describe("substitution", () => {
  it("replaces EVERY occurrence, not the first", () => {
    const resolved = resolveTransport({
      template: { "X-User": `${END_USER_TOKEN}/${END_USER_TOKEN}` },
      urlTemplate: null,
      secret: null,
      endUserId: "user-9",
      toolName: TOOL,
    });
    expect(resolved.ok && resolved.value.headers["X-User"]).toBe("user-9/user-9");
  });

  it("puts the secret in a header and NEVER in the URL", () => {
    const resolved = resolveTransport({
      template: { Authorization: `Bearer ${SECRET_TOKEN}` },
      urlTemplate: `https://x.test/${SECRET_TOKEN}`,
      secret: "sk-live-abc",
      endUserId: null,
      toolName: TOOL,
    });
    expect(resolved.ok && resolved.value.headers["Authorization"]).toBe("Bearer sk-live-abc");
    expect(resolved.ok && resolved.value.url).toBe(`https://x.test/${SECRET_TOKEN}`);
  });

  it("leaves a secret written into a URL for the residual scan to refuse", () => {
    // The source would send the literal `{{secret}}` to the backend — a broken
    // call. Refusing is what the second half of the invariant buys.
    const resolved = resolveTransport({
      template: {},
      urlTemplate: `https://x.test/${SECRET_TOKEN}`,
      secret: "sk-live-abc",
      endUserId: null,
      toolName: TOOL,
    });
    expect(resolved.ok).toBe(true);
    const scanned = resolved.ok ? assertNoResidual(resolved.value) : resolved;
    expect(!scanned.ok && scanned.error.code).toBe("TOOLS_RESIDUAL_TEMPLATE");
  });

  it("refuses when a secret is demanded and none was supplied", () => {
    const resolved = resolveTransport({
      template: { Authorization: `Bearer ${SECRET_TOKEN}` },
      urlTemplate: null,
      secret: null,
      endUserId: null,
      toolName: TOOL,
    });
    expect(!resolved.ok && resolved.error.code).toBe("TOOLS_CREDENTIAL_UNAVAILABLE");
  });
});

describe("the residual scan", () => {
  it("catches a surviving end-user token", () => {
    expect(residualToken({ url: null, headers: { "X-User": END_USER_TOKEN } })).toBe(END_USER_TOKEN);
  });

  it("catches a surviving secret token, which is a failed call rather than a leak", () => {
    expect(residualToken({ url: `https://x.test/${SECRET_TOKEN}`, headers: {} })).toBe(SECRET_TOKEN);
  });

  it("reports the end-user token first when both survive, the graver of the two", () => {
    expect(
      residualToken({ url: `https://x.test/${SECRET_TOKEN}`, headers: { "X-U": END_USER_TOKEN } }),
    ).toBe(END_USER_TOKEN);
  });

  it("passes a fully substituted resolution", () => {
    expect(residualToken({ url: "https://x.test/u", headers: { "X-U": "user-9" } })).toBeNull();
    const asserted = assertNoResidual({ url: "https://x.test/u", headers: {} });
    expect(asserted.ok).toBe(true);
  });

  it("turns a survivor into an INTERNAL error — nothing the caller supplied can fix it", () => {
    const asserted = assertNoResidual({ url: null, headers: { "X-U": END_USER_TOKEN } });
    expect(!asserted.ok && asserted.error.code).toBe("TOOLS_RESIDUAL_TEMPLATE");
    expect(!asserted.ok && asserted.error.category).toBe("internal");
  });
});

describe("the pooled-session key", () => {
  it("is blind to header order, so one credential means one session", () => {
    expect(credentialFingerprintSource({ a: "1", b: "2" })).toBe(
      credentialFingerprintSource({ b: "2", a: "1" }),
    );
  });

  it("separates two credentials, so a rotation abandons the old session", () => {
    expect(credentialFingerprintSource({ Authorization: "Bearer one" })).not.toBe(
      credentialFingerprintSource({ Authorization: "Bearer two" }),
    );
  });

  it("separates two end users of one templated server", () => {
    expect(credentialFingerprintSource({ "X-User": "user-1" })).not.toBe(
      credentialFingerprintSource({ "X-User": "user-2" }),
    );
  });

  it("does not collide across URLs", () => {
    expect(sessionPoolKey("https://a.test", "f")).not.toBe(sessionPoolKey("https://b.test", "f"));
    expect(sessionPoolKey(null, "f")).toContain("stdio");
  });
});

describe("admitting a transport", () => {
  it("needs a URL for everything except stdio", () => {
    expect(admitTransport("http", "https://x.test").ok).toBe(true);
    expect(admitTransport("sse", null).ok).toBe(false);
    expect(admitTransport("http", "   ").ok).toBe(false);
    expect(admitTransport("stdio", null).ok).toBe(true);
  });

  it("refuses a transport it does not implement", () => {
    const admitted = admitTransport("carrier-pigeon", "https://x.test");
    expect(!admitted.ok && admitted.error.code).toBe("TOOLS_MCP_TRANSPORT_INVALID");
  });
});
