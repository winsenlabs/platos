import { describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent.service";

describe("AgentService fallback preflight logging", () => {
  it("logs only a stable safe provider failure when the SDK error contains upstream detail", () => {
    const sentinel = "upstream-response-body-with-sentinel-secret";
    const service = new AgentService(
      {} as any,
      {} as any,
      {} as any,
      { get: vi.fn() } as any,
    );
    const warn = vi.fn();
    Object.assign((service as any).logger, { warn, log: vi.fn() });

    (service as any).logFallbackPreflightFailure(
      "fallback",
      "openai:fallback-model",
      new Error(sentinel),
    );

    const captured = JSON.stringify(warn.mock.calls);
    expect(captured).toContain("code=provider_request_failed");
    expect(captured).toContain("message=Provider request failed.");
    expect(captured).not.toContain(sentinel);
    expect(captured).not.toContain("upstream-response-body");
  });
});
