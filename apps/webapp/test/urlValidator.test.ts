import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  lookup: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("node:dns", () => ({
  promises: {
    resolve4: mocks.resolve4,
    resolve6: mocks.resolve6,
    lookup: mocks.lookup,
  },
}));

vi.mock("undici", () => ({
  Agent: class Agent {},
  fetch: mocks.fetch,
}));

import {
  fetchWithValidatedRedirects,
  validatePublicUrl,
} from "~/utils/urlValidator.server";

describe("canonical webhook URL validation", () => {
  beforeEach(() => {
    mocks.resolve4.mockReset().mockResolvedValue(["93.184.216.34"]);
    mocks.resolve6.mockReset().mockRejectedValue(new Error("no AAAA record"));
    mocks.lookup.mockReset();
    mocks.fetch.mockReset();
  });

  it.each(["https://127.0.0.1/hook", "https://169.254.169.254/latest/meta-data"])(
    "rejects a direct private or link-local target: %s",
    async (url) => {
      await expect(validatePublicUrl(url)).resolves.toMatchObject({
        ok: false,
        error: { kind: "ip_private_or_reserved" },
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  );

  it("rejects a public URL that redirects to a private target", async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      })
    );

    await expect(
      fetchWithValidatedRedirects("https://hooks.example.com/start", 3, { method: "POST" })
    ).rejects.toThrow("host resolves to a private / reserved IP");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("dispatches a valid public webhook with the supplied request", async () => {
    const response = new Response(null, { status: 204 });
    mocks.fetch.mockResolvedValueOnce(response);
    const body = JSON.stringify({ event: "task.completed" });

    await expect(
      fetchWithValidatedRedirects("https://hooks.example.com/events", 3, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-signature": "signed" },
        body,
      })
    ).resolves.toBe(response);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://hooks.example.com/events",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", "x-test-signature": "signed" },
        body,
        redirect: "manual",
        dispatcher: expect.anything(),
      })
    );
  });
});
