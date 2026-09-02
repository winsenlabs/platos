import { describe, expect, it } from "vitest";

import {
  buildProvidersTestContext,
  testProviderKey,
  type ProvidersTestContext,
} from "../application/testing/index.js";
import type { RateCardCatalogue } from "../domain/index.js";
import {
  DEFAULT_PROVIDER_CATALOGUE,
  DEFAULT_PROVIDERS_POLICY,
  HEALTH_STATUSES,
  PROVIDERS_ERROR_CODES,
  PROVIDERS_EVENT_NAMES,
  providersContract,
  RATE_NAMES,
  RATE_SOURCES,
} from "./index.js";

function build(context: ProvidersTestContext) {
  return providersContract(context.dependencies);
}

function configureOpenAi(context: ProvidersTestContext) {
  const credential = context.secrets.seed({
    name: "OPENAI_API_KEY",
    provider: "openai",
    plaintext: "sk-live",
  });
  return context.repository.seedProviderKey(
    testProviderKey(context.scope, { credentialId: credential.id }),
  );
}

describe("the contract is the whole surface", () => {
  it("names itself and is frozen", () => {
    const contract = build(buildProvidersTestContext());
    expect(contract.name).toBe("providers");
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it("publishes the catalogue, the policy and the closed vocabularies as data", () => {
    expect(DEFAULT_PROVIDER_CATALOGUE.length).toBeGreaterThan(0);
    expect(DEFAULT_PROVIDERS_POLICY.health.healthySeconds).toBe(300);
    expect([...RATE_SOURCES]).toEqual(["LITELLM", "VERIFIED_PROVIDER", "UNAVAILABLE"]);
    expect([...RATE_NAMES]).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
    expect([...HEALTH_STATUSES]).toEqual(["healthy", "invalid_key", "error", "not_configured"]);
    expect(PROVIDERS_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it("names every integration event under this context's own prefix", () => {
    for (const name of PROVIDERS_EVENT_NAMES) {
      expect(name.startsWith("providers.")).toBe(true);
      expect(name).toMatch(/^[a-z]+(?:\.[a-z_]+)+$/u);
    }
    expect(new Set(PROVIDERS_EVENT_NAMES).size).toBe(PROVIDERS_EVENT_NAMES.length);
  });
});

describe("views withhold what the boundary must not carry", () => {
  it("never puts a credential id in a provider key view", async () => {
    const context = buildProvidersTestContext();
    const key = configureOpenAi(context);
    const contract = build(context);

    const described = await contract.describeProviderKey({
      authorization: context.tenancy.grant("metadata"),
      providerKeyId: key.providerKeyId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(Object.keys(described.value)).not.toContain("credentialId");
    expect(JSON.stringify(described.value)).not.toContain(key.credentialId);
    expect(described.value.credentialName).toBe("OPENAI_API_KEY");
  });

  it("never puts secret material anywhere in an answer", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    const contract = build(context);

    const answers = await Promise.all([
      contract.listProviderKeys({ authorization: context.tenancy.grant("metadata") }),
      contract.describeProviders({ authorization: context.tenancy.grant("metadata") }),
      contract.checkProviderHealth({
        authorization: context.secrets.runtimeGrant(),
        scope: context.scope,
        provider: "openai",
      }),
    ]);
    for (const answer of answers) {
      expect(JSON.stringify(answer)).not.toContain("sk-live");
    }
  });

  it("renders a rate and a cost as canonical decimal STRINGS, never as numbers", async () => {
    const context = buildProvidersTestContext();
    const contract = build(context);
    const catalogue: RateCardCatalogue = {
      "openai/gpt-4o": {
        input_cost_per_token: 2.5e-6,
        output_cost_per_token: 1e-5,
        cache_read_input_token_cost: 1.25e-6,
        cache_creation_input_token_cost: 3.125e-6,
        litellm_provider: "openai",
      },
    };
    const ingested = await contract.ingestRateCard({
      catalogue,
      readAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    if (!ingested.ok) throw new Error("unreachable");

    const priced = await contract.priceModelUsage({
      model: "openai:gpt-4o",
      at: new Date("2026-09-01T00:00:00.000Z"),
      usage: { inputTokens: 1_000, outputTokens: 200 },
    });
    if (!priced.ok) throw new Error(`unreachable: ${priced.error.code}`);
    expect(priced.value.costCents).toBe("0.450000");
    expect(typeof priced.value.costCents).toBe("string");
    for (const rate of priced.value.price.rates) {
      expect(typeof rate.usdPerToken).toBe("string");
      expect(rate.usdPerToken).toMatch(/^\d+\.\d{12}$/u);
    }
    expect(priced.value.price.rates.map((rate) => rate.rate)).toEqual([...RATE_NAMES]);
  });
});

describe("every method returns a Result rather than throwing", () => {
  it("reports a refusal as a value on each surface", async () => {
    const context = buildProvidersTestContext();
    const contract = build(context);
    const forged = { access: "secret:mutate" };

    const refusals = await Promise.all([
      contract.listProviderKeys({ authorization: forged }),
      contract.pageProviderKeys({ authorization: forged, limit: 10, offset: 0 }),
      contract.describeProviderKey({ authorization: forged, providerKeyId: "x" as never }),
      contract.linkProviderKey({
        authorization: forged,
        intake: { provider: "openai", label: "l", credentialName: "N", isDefault: false },
      }),
      contract.registerProviderKey({
        authorization: forged,
        intake: { provider: "openai", label: "l", credentialName: "N", isDefault: false },
        plaintext: "sk",
      }),
      contract.rotateProviderKeySecret({
        authorization: forged,
        providerKeyId: "x" as never,
        plaintext: "sk",
      }),
      contract.relinkProviderKey({
        authorization: forged,
        providerKeyId: "x" as never,
        credentialName: "N",
      }),
      contract.updateProviderKey({ authorization: forged, providerKeyId: "x" as never, patch: {} }),
      contract.deleteProviderKey({ authorization: forged, providerKeyId: "x" as never }),
      contract.describeProviders({ authorization: forged }),
      contract.describeProvider({ authorization: forged, provider: "openai" }),
      contract.setProviderAdoption({ authorization: forged, provider: "openai", enabled: true }),
      contract.unlinkProvider({ authorization: forged, provider: "openai" }),
      contract.listUsableProviders({ authorization: forged }),
    ]);
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
    }
  });

  it("routes a turn through the contract and reports which key paid", async () => {
    const context = buildProvidersTestContext();
    const key = configureOpenAi(context);
    const contract = build(context);

    const opened = await contract.openModelRoute({
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      model: "openai:gpt-4o",
    });
    if (!opened.ok) throw new Error(`unreachable: ${opened.error.code}`);
    expect(opened.value.providerKey.providerKeyId).toBe(key.providerKeyId);
    expect(opened.value.session.plan.reference.provider).toBe("openai");
  });

  it("reports every provider's liveness in one call", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    const contract = build(context);

    const reports = await contract.checkAllProvidersHealth({
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
    });
    if (!reports.ok) throw new Error("unreachable");
    expect(reports.value).toHaveLength(DEFAULT_PROVIDER_CATALOGUE.length);
  });
});
