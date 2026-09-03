import { describe, expect, it } from "vitest";

import { DEFAULT_PROVIDER_CATALOGUE } from "./catalogue.js";
import {
  DEFAULT_PROVIDER,
  DEFAULT_VERTEX_LOCATION,
  NO_RUNTIME_SETTINGS,
  normaliseOpenAiRoot,
  parseModelReference,
  planModelRoute,
} from "./route.js";

const CATALOGUE = DEFAULT_PROVIDER_CATALOGUE;

function plan(modelString: string, settings = NO_RUNTIME_SETTINGS) {
  return planModelRoute(CATALOGUE, modelString, settings);
}

function planned(modelString: string, settings = NO_RUNTIME_SETTINGS) {
  const built = plan(modelString, settings);
  if (!built.ok) throw new Error(`unreachable: ${built.error.code}`);
  return built.value;
}

describe("splitting a model string", () => {
  it("splits on the FIRST colon so a model name may contain one", () => {
    const reference = parseModelReference("openai:gpt-4o:2024");
    if (!reference.ok) throw new Error("unreachable");
    expect(reference.value.provider).toBe("openai");
    expect(reference.value.modelName).toBe("gpt-4o:2024");
  });

  it("routes an unqualified model to the default provider", () => {
    const reference = parseModelReference("claude-sonnet-4-6");
    if (!reference.ok) throw new Error("unreachable");
    expect(reference.value.provider).toBe(DEFAULT_PROVIDER);
    expect(reference.value.modelName).toBe("claude-sonnet-4-6");
    expect(reference.value.qualified).toBe(false);
  });

  it("treats a leading colon as no provider at all, not as a provider named ''", () => {
    const reference = parseModelReference(":gpt-4o");
    if (!reference.ok) throw new Error("unreachable");
    expect(reference.value.provider).toBe(DEFAULT_PROVIDER);
    expect(reference.value.modelName).toBe(":gpt-4o");
  });

  it("refuses an empty string and a provider with no model", () => {
    expect(parseModelReference("   ").ok).toBe(false);
    expect(parseModelReference("openai:").ok).toBe(false);
  });
});

describe("dialects", () => {
  it("routes each catalogue provider to the dialect its manifest declares", () => {
    for (const manifest of CATALOGUE) {
      const settings =
        manifest.dialect === "azure-openai"
          ? { baseUrl: "https://example.invalid/openai", location: null }
          : NO_RUNTIME_SETTINGS;
      const built = plan(`${manifest.id}:${manifest.probeModel}`, settings);
      if (!built.ok) throw new Error(`unreachable for ${manifest.id}`);
      expect(built.value.dialect).toBe(manifest.dialect);
    }
  });

  it("gives every OpenAI-compatible provider the base url its manifest carries", () => {
    for (const manifest of CATALOGUE.filter((entry) => entry.dialect === "openai-compatible")) {
      const route = planned(`${manifest.id}:${manifest.probeModel}`);
      expect(route.baseUrl).toBe(manifest.baseUrl);
      expect(route.chatCompletionsOnly).toBe(true);
    }
  });

  it("leaves a native provider on its own default entry point", () => {
    const route = planned("anthropic:claude-haiku-4-5-20251001");
    expect(route.baseUrl).toBeNull();
    expect(route.chatCompletionsOnly).toBe(false);
  });
});

describe("the OpenAI override root", () => {
  it("stays on the provider's own entry point when nothing is configured", () => {
    const route = planned("openai:gpt-4o");
    expect(route.baseUrl).toBeNull();
    expect(route.chatCompletionsOnly).toBe(false);
  });

  it("normalises a configured root and pins the chat-completions surface", () => {
    const route = planned("openai:gpt-4o", { baseUrl: "https://gw.example.invalid/", location: null });
    expect(route.baseUrl).toBe("https://gw.example.invalid/v1");
    expect(route.chatCompletionsOnly).toBe(true);
  });

  it("normalises the three spellings of one root to one value", () => {
    expect(normaliseOpenAiRoot("https://gw.example.invalid")).toBe("https://gw.example.invalid/v1");
    expect(normaliseOpenAiRoot("https://gw.example.invalid/")).toBe("https://gw.example.invalid/v1");
    expect(normaliseOpenAiRoot("https://gw.example.invalid/v1")).toBe("https://gw.example.invalid/v1");
    expect(normaliseOpenAiRoot("https://gw.example.invalid/v1/")).toBe("https://gw.example.invalid/v1");
  });

  it("treats a blank configured root as no configuration", () => {
    const route = planned("openai:gpt-4o", { baseUrl: "   ", location: null });
    expect(route.baseUrl).toBeNull();
  });
});

describe("the per-resource dialect fails closed", () => {
  it("refuses to plan an azure route with no configured root", () => {
    const denied = plan("azure:gpt-4o");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_CONFIGURATION_UNAVAILABLE");
    expect(denied.error.message).toBe("Provider configuration is unavailable for this environment.");
  });

  it("keeps the configured root verbatim once it is present, minus a trailing slash", () => {
    const route = planned("azure:gpt-4o", {
      baseUrl: "https://example.invalid/openai/target/",
      location: null,
    });
    expect(route.baseUrl).toBe("https://example.invalid/openai/target");
  });
});

describe("vertex", () => {
  it("defaults the region and records that the credential is a document", () => {
    const route = planned("google-vertex:gemini-2.5-flash");
    expect(route.location).toBe(DEFAULT_VERTEX_LOCATION);
    expect(route.credentialIsServiceAccount).toBe(true);
  });

  it("honours a configured region", () => {
    const route = planned("google-vertex:gemini-2.5-flash", {
      baseUrl: null,
      location: "europe-west4",
    });
    expect(route.location).toBe("europe-west4");
  });
});

describe("an unknown provider fails closed with a content-free message", () => {
  it("refuses and names the reason only in details", () => {
    const denied = plan("not-a-provider:some-model");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_CONFIGURATION_UNAVAILABLE");
    expect(denied.error.message).not.toContain("not-a-provider");
    expect(denied.error.details.provider).toBe("not-a-provider");
  });
});
