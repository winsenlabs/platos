import { describe, expect, it, vi } from "vitest";

import { PlatosClient } from "../src/index.js";

function clientWith(response: unknown = {}) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
  return {
    client: new PlatosClient({
      baseUrl: "https://platos.example.com",
      sessionToken: "session-token",
      fetch,
    }),
    fetch,
  };
}

describe("canonical Turn and Job paths", () => {
  it("uses the Jobs collection and preserves bounded aliases", async () => {
    const { client, fetch } = clientWith({ jobs: [] });
    expect(client.bgo).toBe(client.jobs);
    expect(client.trigger).toBe(client.jobs);

    await client.jobs.list({ status: "queued", limit: 9 });
    expect(fetch).toHaveBeenCalledWith(
      "https://platos.example.com/api/v1/agent/jobs?status=queued&limit=9",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses the Turns collection", async () => {
    const { client, fetch } = clientWith({ turns: [] });
    await client.turns.list({ threadId: "thread/1" });
    expect(fetch).toHaveBeenCalledWith(
      "https://platos.example.com/api/v1/agent/turns?threadId=thread%2F1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses generated budget and approval route shapes", async () => {
    const { client, fetch } = clientWith({ caps: [] });
    await client.budgets.list();
    await client.approvals.resolve("approval/1", { response: "approve" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://platos.example.com/api/v1/agent/budgets",
      "https://platos.example.com/api/v1/agent/approvals/approval%2F1/resolve",
    ]);
  });
});
