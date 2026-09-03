import { describe, expect, it } from "vitest";

import { asProvidersIdentifier, type ProviderId } from "../domain/index.js";
import { checkAllProvidersHealth, checkProviderHealth } from "./check-provider-health.js";
import {
  buildProvidersTestContext,
  otherEnvironment,
  testProviderKey,
  type ProvidersTestContext,
} from "./testing/index.js";

function configureOpenAi(context: ProvidersTestContext): void {
  const credential = context.secrets.seed({
    name: "OPENAI_API_KEY",
    provider: "openai",
    plaintext: "sk-live",
  });
  context.repository.seedProviderKey(
    testProviderKey(context.scope, { credentialId: credential.id }),
  );
}

function check(context: ProvidersTestContext, provider = "openai") {
  return checkProviderHealth(context.dependencies, {
    authorization: context.secrets.runtimeGrant(),
    scope: context.scope,
    provider,
  });
}

describe("what a check answers", () => {
  it("reports healthy, with the model it named and a measured latency", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);

    const report = await check(context);
    if (!report.ok) throw new Error(`unreachable: ${report.error.code}`);
    expect(report.value.status).toBe("healthy");
    expect(report.value.model).toBe("gpt-4.1-mini");
    expect(report.value.failure).toBeNull();
    expect(context.modelRouter.probes[0]?.revealed).toBe("sk-live");
    expect(context.modelRouter.probes[0]?.timeoutMs).toBe(10_000);
  });

  it("CONDEMNS THE KEY only when the provider refused it", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    context.modelRouter.failProbe("openai", "auth_refused");

    const report = await check(context);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.status).toBe("invalid_key");
    expect(report.value.failure).toBe("auth_refused");
  });

  it("does NOT condemn the key when the provider could not be reached", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    context.modelRouter.breakProvider("openai");

    const report = await check(context);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.status).toBe("error");
    expect(report.value.failure).toBe("request_failed");
  });

  it("reports not_configured WITHOUT calling anything", async () => {
    const context = buildProvidersTestContext();

    const report = await check(context);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.status).toBe("not_configured");
    expect(report.value.latencyMs).toBe(0);
    expect(context.modelRouter.probes).toEqual([]);
    expect(context.probeCache.healthReads).toBe(0);
  });

  it("distinguishes an unknown provider from an unconfigured one", async () => {
    const context = buildProvidersTestContext();
    const report = await check(context, "not-a-provider");
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.status).toBe("not_configured");
    expect(report.value.failure).toBe("unknown_provider");
  });

  it("reports every required credential's presence, in manifest order", async () => {
    const context = buildProvidersTestContext();
    context.secrets.seed({
      name: "AZURE_OPENAI_API_KEY",
      provider: "azure",
      plaintext: "sk-azure",
    });

    const report = await check(context, "azure");
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.requiredCredentials.map((entry) => entry.name)).toEqual([
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_BASE_URL",
    ]);
    expect(report.value.status).toBe("not_configured");
  });
});

describe("the cache", () => {
  it("does not call the provider a second time inside the window", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);

    await check(context);
    await check(context);
    expect(context.modelRouter.probes).toHaveLength(1);
  });

  it("calls again once the window has elapsed", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);

    await check(context);
    context.clock.advanceSeconds(300);
    await check(context);
    expect(context.modelRouter.probes).toHaveLength(2);
  });

  it("re-checks a FAILED result within a minute, not five", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    context.modelRouter.failProbe("openai", "auth_refused");

    await check(context);
    context.clock.advanceSeconds(59);
    await check(context);
    expect(context.modelRouter.probes).toHaveLength(1);

    context.clock.advanceSeconds(1);
    await check(context);
    expect(context.modelRouter.probes).toHaveLength(2);
  });

  it("reports a cache that will not accept a write, because the next call pays for it", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    context.probeCache.writesFail = true;

    const denied = await check(context);
    expect(denied.ok).toBe(false);
  });
});

describe("the grant", () => {
  it("refuses a runtime grant minted for another environment", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    const denied = await checkProviderHealth(context.dependencies, {
      authorization: context.secrets.runtimeGrant(otherEnvironment()),
      scope: context.scope,
      provider: "openai",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_SCOPE_MISMATCH");
  });
});

describe("checking every provider", () => {
  it("returns one report per catalogue entry, in catalogue order", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);

    const reports = await checkAllProvidersHealth(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
    });
    if (!reports.ok) throw new Error("unreachable");
    expect(reports.value).toHaveLength(context.dependencies.catalogue.length);
    expect(reports.value.map((report) => report.provider)).toEqual(
      context.dependencies.catalogue.map((manifest) => manifest.id),
    );
    const openai = reports.value.find(
      (report) => report.provider === asProvidersIdentifier<ProviderId>("openai"),
    );
    expect(openai?.status).toBe("healthy");
    // Only the one configured provider was actually called.
    expect(context.modelRouter.probes).toHaveLength(1);
  });
});
