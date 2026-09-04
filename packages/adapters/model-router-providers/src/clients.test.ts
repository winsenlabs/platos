import { describe, expect, it } from "vitest";

import { resolveModel } from "./clients.js";
import { credential, routePlan } from "./testing.js";

/** A transport that records what it was handed and answers nothing. */
const NEVER: typeof fetch = () => Promise.reject(new Error("the fixture never calls out"));

const SERVICE_ACCOUNT = JSON.stringify({
  project_id: "platos-prod",
  client_email: "signer@platos-prod.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n",
});

describe("binding a plan to a client", () => {
  it("builds an Anthropic model from the plan's model name", () => {
    const built = resolveModel(
      routePlan("anthropic:claude-sonnet-4-6", { dialect: "anthropic-native" }),
      credential("sk-ant"),
      NEVER,
    );

    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect(typeof built.value).not.toBe("string");
    expect((built.value as { modelId: string }).modelId).toBe("claude-sonnet-4-6");
  });

  it("uses the default OpenAI entry point when no root is configured", () => {
    const built = resolveModel(
      routePlan("openai:gpt-4.1", { dialect: "openai-native" }),
      credential("sk-oai"),
      NEVER,
    );

    if (!built.ok) throw new Error("unreachable");
    expect((built.value as { modelId: string }).modelId).toBe("gpt-4.1");
  });

  it("pins the chat surface for an OpenAI-compatible upstream", () => {
    // `createOpenAI(...)(model)` defaults to the newer responses surface, which
    // these third-party upstreams do not implement. Getting it wrong is a 404
    // from a provider that is configured perfectly.
    const built = resolveModel(
      routePlan("groq:llama-3.3", { dialect: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", chatCompletionsOnly: true }),
      credential("gsk"),
      NEVER,
    );

    if (!built.ok) throw new Error("unreachable");
    expect((built.value as { modelId: string }).modelId).toBe("llama-3.3");
  });

  it("refuses an openai-compatible plan with no root rather than calling somewhere wrong", () => {
    const built = resolveModel(
      routePlan("groq:llama-3.3", { dialect: "openai-compatible" }),
      credential("gsk"),
      NEVER,
    );

    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_CONFIGURATION_UNAVAILABLE");
  });

  it("refuses an azure plan with no per-resource root", () => {
    const built = resolveModel(
      routePlan("azure:my-deployment-name", { dialect: "azure-openai" }),
      credential("azkey"),
      NEVER,
    );

    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_CONFIGURATION_UNAVAILABLE");
  });

  it("builds a Google model", () => {
    const built = resolveModel(
      routePlan("google:gemini-2.5-pro", { dialect: "google-generative" }),
      credential("AIza"),
      NEVER,
    );

    if (!built.ok) throw new Error("unreachable");
    expect((built.value as { modelId: string }).modelId).toBe("gemini-2.5-pro");
  });

  it("parses a Vertex service-account document and unescapes its key", () => {
    const built = resolveModel(
      routePlan("google-vertex:gemini-2.5-pro", {
        dialect: "google-vertex",
        location: "europe-west4",
        credentialIsServiceAccount: true,
      }),
      credential(SERVICE_ACCOUNT),
      NEVER,
    );

    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect((built.value as { modelId: string }).modelId).toBe("gemini-2.5-pro");
  });
});

describe("the service-account guard", () => {
  const VERTEX = routePlan("google-vertex:gemini-2.5-pro", {
    dialect: "google-vertex",
    credentialIsServiceAccount: true,
  });

  it("refuses material that is not JSON", () => {
    const built = resolveModel(VERTEX, credential("sk-this-is-a-bearer-key"), NEVER);

    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_SERVICE_ACCOUNT_INVALID");
  });

  it("refuses JSON that is not an object", () => {
    const built = resolveModel(VERTEX, credential("[1,2,3]"), NEVER);

    expect(built.ok).toBe(false);
  });

  it("names WHICH field is missing, one field at a time", () => {
    for (const missing of ["project_id", "client_email", "private_key"]) {
      const document: Record<string, string> = {
        project_id: "p",
        client_email: "e",
        private_key: "k",
      };
      delete document[missing];

      const built = resolveModel(VERTEX, credential(JSON.stringify(document)), NEVER);

      expect(built.ok).toBe(false);
      if (built.ok) throw new Error("unreachable");
      expect(String(built.error.details.reason)).toContain(missing);
    }
  });

  it("refuses a blank field as firmly as a missing one", () => {
    const built = resolveModel(
      VERTEX,
      credential(JSON.stringify({ project_id: "   ", client_email: "e", private_key: "k" })),
      NEVER,
    );

    expect(built.ok).toBe(false);
  });

  it("says nothing about the material in the message a client would see", () => {
    const built = resolveModel(VERTEX, credential("super-secret-key-value"), NEVER);

    if (built.ok) throw new Error("unreachable");
    expect(built.error.message).not.toContain("super-secret");
    expect(JSON.stringify(built.error.details)).not.toContain("super-secret");
  });
});
