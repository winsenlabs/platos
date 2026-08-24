import { describe, expect, it, vi } from "vitest";

import { PlatosClient } from "../src/index.js";

function clientWith(responses: unknown[]) {
  const fetch = vi.fn(async () => {
    const response = responses.shift();
    return new Response(JSON.stringify(response), { status: 200 });
  });
  return {
    client: new PlatosClient({
      baseUrl: "https://platos.example.com",
      sessionToken: "session-token",
      fetch,
    }),
    fetch,
  };
}

describe("canonical Job paths", () => {
  it("maps every Jobs method to the generated runtime contract", async () => {
    const job = { id: "job_internal", jobId: "daily-report" };
    const { client, fetch } = clientWith([
      { jobs: [job] },
      { job },
      { job },
      { job },
      { deleted: true },
      { accepted: true, jobId: "daily-report" },
    ]);

    await expect(client.jobs.list({
      page: 2,
      limit: 9,
      offset: 4,
      search: "daily/report",
      status: "active",
    })).resolves.toEqual([job]);
    await expect(client.jobs.create({
      jobId: "daily-report",
      displayName: "Daily report",
      handler: "return payload",
    })).resolves.toEqual(job);
    await expect(client.jobs.get("job/internal")).resolves.toEqual(job);
    await expect(client.jobs.update("job/internal", { isActive: false })).resolves.toEqual(job);
    await expect(client.jobs.delete("job/internal")).resolves.toEqual({ deleted: true });
    await expect(client.jobs.dispatch("job/internal", { date: "2026-08-24" })).resolves.toEqual({
      accepted: true,
      jobId: "daily-report",
    });

    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [
        "https://platos.example.com/api/v1/agent/jobs?page=2&limit=9&offset=4&search=daily%2Freport&status=active",
        "GET",
        undefined,
      ],
      [
        "https://platos.example.com/api/v1/agent/jobs",
        "POST",
        JSON.stringify({
          jobId: "daily-report",
          displayName: "Daily report",
          handler: "return payload",
        }),
      ],
      ["https://platos.example.com/api/v1/agent/jobs/job%2Finternal", "GET", undefined],
      [
        "https://platos.example.com/api/v1/agent/jobs/job%2Finternal",
        "PATCH",
        JSON.stringify({ isActive: false }),
      ],
      ["https://platos.example.com/api/v1/agent/jobs/job%2Finternal", "DELETE", undefined],
      [
        "https://platos.example.com/api/v1/agent/jobs/job%2Finternal/dispatch",
        "POST",
        JSON.stringify({ payload: { date: "2026-08-24" } }),
      ],
    ]);
  });

  it("does not expose unsupported legacy or canonical Turn namespaces", () => {
    const { client } = clientWith([]);
    expect("bgo" in client).toBe(false);
    expect("trigger" in client).toBe(false);
    expect("turns" in client).toBe(false);
  });

  it("uses generated budget and approval route shapes", async () => {
    const { client, fetch } = clientWith([{ caps: [] }, {}]);
    await client.budgets.list();
    await client.approvals.resolve("approval/1", { response: "approve" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://platos.example.com/api/v1/agent/budgets",
      "https://platos.example.com/api/v1/agent/approvals/approval%2F1/resolve",
    ]);
  });
});
