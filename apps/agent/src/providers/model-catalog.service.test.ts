import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRuntimeError } from "./provider-runtime.error";
import { getManifest } from "./manifests";
import { ModelCatalogService } from "./model-catalog.service";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "environment-a",
};

describe("ModelCatalogService provider configuration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("escapes a stable safe error and makes no request when configured base URL is unreadable", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const scopedEnv = {
      getProviderApiKey: vi.fn().mockResolvedValue("tenant-provider-key"),
      getProviderConfiguration: vi.fn().mockRejectedValue(
        new ProviderRuntimeError("provider_configuration_unavailable"),
      ),
    };
    const service = new ModelCatalogService(scopedEnv as any);
    const manifest = getManifest("openai")!;

    const error = await service
      .listFor(scope, manifest)
      .catch((value) => value as ProviderRuntimeError);

    expect(error).toBeInstanceOf(ProviderRuntimeError);
    expect(error).toMatchObject({
      code: "provider_configuration_unavailable",
      message: "Provider configuration is unavailable for this environment.",
    });
    expect(JSON.stringify(error)).not.toMatch(/tenant-provider-key|cipher|prisma|AES-GCM/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
