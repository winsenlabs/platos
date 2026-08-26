import { describe, expect, test } from "vitest";
import {
  ClickhouseObservabilitySink,
  ObservabilityWriteError,
  errorClass,
  healthLogLevel,
  observabilityErrorCode,
  type FetchLike,
} from "./clickhouse-observability-sink";
import {
  OBSERVABILITY_TABLES,
  resolveObservabilityConfig,
  type ObservabilityConfig,
} from "./observability-config";
import { emptyRows, projectTurn, type ObservabilityRows } from "./observability-event";

interface Sent {
  url: URL;
  body: string;
  headers: Record<string, string>;
}

/**
 * A real HTTP transport backed by a scripted responder rather than a mock of
 * the sink. The sink under test is exercised end to end: it builds the URL, the
 * headers and the JSONEachRow body, and this only decides what comes back.
 */
function transport(respond: (sent: Sent) => { status: number; body?: string }) {
  const sent: Sent[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const record: Sent = {
      url: input instanceof URL ? input : new URL(String(input)),
      body: typeof init?.body === "string" ? init.body : "",
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    sent.push(record);
    const { status, body = "" } = respond(record);
    return new Response(body, { status });
  };
  return { sent, fetchImpl };
}

function config(overrides: Partial<ObservabilityConfig> = {}): ObservabilityConfig {
  return {
    ...resolveObservabilityConfig({
      PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "http://default:pwd@clickhouse:8123",
    }),
    ...overrides,
  };
}

const scope = { organizationId: "org-1", projectId: "proj-1", environmentId: "env-1" };

function sampleRows(): ObservabilityRows {
  return projectTurn({
    turn: {
      scope,
      turnId: "11111111-1111-4111-8111-111111111111",
      threadId: "thread-1",
      agentId: "agent-1",
      status: "completed",
      acceptedAt: new Date("2026-08-20T10:00:00.000Z"),
      completedAt: new Date("2026-08-20T10:00:01.000Z"),
      costCents: 1.5,
    },
  });
}

describe("health", () => {
  test("reports disabled when nothing is configured, and does not call out", async () => {
    const { sent, fetchImpl } = transport(() => ({ status: 200 }));
    const sink = new ClickhouseObservabilitySink({
      fetchImpl,
      readConfig: () => resolveObservabilityConfig({}),
    });
    const health = await sink.health();
    expect(health).toMatchObject({ configured: false, available: false, status: "disabled" });
    expect(sent).toHaveLength(0);
  });

  test("reports misconfigured, not disabled, for an endpoint that is set but unusable", async () => {
    // An installation that HAS a store and mistyped where it is must never read as
    // an installation that has no store.
    const { fetchImpl } = transport(() => ({ status: 200 }));
    const sink = new ClickhouseObservabilitySink({
      fetchImpl,
      readConfig: () =>
        resolveObservabilityConfig({ PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "clickhouse://host:9000" }),
    });
    const health = await sink.health();
    expect(health.status).toBe("misconfigured");
    expect(health.configured).toBe(true);
    expect(health.available).toBe(false);
  });

  test("reports unreachable when the endpoint does not answer", async () => {
    const sink = new ClickhouseObservabilitySink({
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND clickhouse");
      },
      readConfig: config,
    });
    const health = await sink.health();
    expect(health.status).toBe("unreachable");
    expect(health.available).toBe(false);
  });

  test("reports schema_missing and names the file that fixes it", async () => {
    // This is the check whose absence let a broken pipeline look healthy.
    const { fetchImpl } = transport(() => ({ status: 200, body: "turns_v1\nsteps_v1\n" }));
    const sink = new ClickhouseObservabilitySink({ fetchImpl, readConfig: config });
    const health = await sink.health();
    expect(health.status).toBe("schema_missing");
    expect(health.available).toBe(false);
    expect(health.missingTables).toEqual(["tool_calls_v1", "usage_events_v1"]);
    expect(health.detail).toContain("033_create_platos_observability_v1.sql");
  });

  test("reports ready only when every table is present", async () => {
    const { sent, fetchImpl } = transport(() => ({
      status: 200,
      body: OBSERVABILITY_TABLES.join("\n") + "\n",
    }));
    const sink = new ClickhouseObservabilitySink({ fetchImpl, readConfig: config });
    const health = await sink.health();
    expect(health).toMatchObject({ configured: true, available: true, status: "ready" });
    expect(sent[0].url.searchParams.get("param_database")).toBe("platos_observability");
    expect(sent[0].body).toContain("system.tables");
  });

  test("does not warn every boot about an installation that chose to have no store", async () => {
    // Warning on `disabled` trains operators to ignore this line, which is the
    // state that hid the previous breakage.
    expect(healthLogLevel("disabled")).toBe("log");
    expect(healthLogLevel("ready")).toBe("log");
    expect(healthLogLevel("unreachable")).toBe("warn");
    expect(healthLogLevel("schema_missing")).toBe("error");
    expect(healthLogLevel("misconfigured")).toBe("error");
  });
});

describe("writes", () => {
  test("targets platos_observability and never platos_telemetry", async () => {
    const { sent, fetchImpl } = transport(() => ({ status: 200 }));
    const sink = new ClickhouseObservabilitySink({ fetchImpl, readConfig: config });
    await sink.writeRows(sampleRows());
    const query = sent[0].url.searchParams.get("query") ?? "";
    expect(query).toBe("INSERT INTO platos_observability.turns_v1 FORMAT JSONEachRow");
    expect(query).not.toContain("platos_telemetry");
  });

  test("sends credentials as a Basic header, never in the URL", async () => {
    // Node's fetch refuses a URL carrying credentials outright.
    const { sent, fetchImpl } = transport(() => ({ status: 200 }));
    const sink = new ClickhouseObservabilitySink({ fetchImpl, readConfig: config });
    await sink.writeRows(sampleRows());
    expect(sent[0].headers["Authorization"]).toBe(
      "Basic " + Buffer.from("default:pwd").toString("base64"),
    );
    expect(sent[0].url.toString()).not.toContain("pwd");
  });

  test("asks ClickHouse to deduplicate an identical retried insert", async () => {
    const { sent, fetchImpl } = transport(() => ({ status: 200 }));
    const sink = new ClickhouseObservabilitySink({ fetchImpl, readConfig: config });
    await sink.writeRows(sampleRows());
    expect(sent[0].url.searchParams.get("insert_deduplicate")).toBe("1");
  });

  test("writes one newline-delimited JSON object per row", async () => {
    const { sent, fetchImpl } = transport(() => ({ status: 200 }));
    const sink = new ClickhouseObservabilitySink({ fetchImpl, readConfig: config });
    await sink.writeRows(sampleRows());
    const lines = sent[0].body.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ organization_id: "org-1", status: "completed" });
  });

  test("sends the parent Turn before its Steps", async () => {
    // A Turn with no detail is legible; Steps whose Turn never arrived read as
    // orphaned cost.
    const rows = { ...emptyRows(), ...sampleRows() };
    rows.steps_v1 = [{ organization_id: "org-1", step_id: "s" }];
    const { sent, fetchImpl } = transport(() => ({ status: 200 }));
    const sink = new ClickhouseObservabilitySink({ fetchImpl, readConfig: config });
    await sink.writeRows(rows);
    expect(sent.map((s) => s.url.searchParams.get("query"))).toEqual([
      "INSERT INTO platos_observability.turns_v1 FORMAT JSONEachRow",
      "INSERT INTO platos_observability.steps_v1 FORMAT JSONEachRow",
    ]);
  });

  test("splits a payload larger than the batch size into several inserts", async () => {
    const rows = emptyRows();
    rows.steps_v1 = Array.from({ length: 5 }, (_, i) => ({ step_id: String(i) }));
    const { sent, fetchImpl } = transport(() => ({ status: 200 }));
    const sink = new ClickhouseObservabilitySink({
      fetchImpl,
      readConfig: () => config({ batchSize: 2 }),
    });
    await sink.writeRows(rows);
    expect(sent).toHaveLength(3);
    expect(sent.map((s) => s.body.trim().split("\n").length)).toEqual([2, 2, 1]);
  });

  test("sends nothing at all for an empty payload", async () => {
    const { sent, fetchImpl } = transport(() => ({ status: 200 }));
    const sink = new ClickhouseObservabilitySink({ fetchImpl, readConfig: config });
    await sink.writeRows(emptyRows());
    expect(sent).toHaveLength(0);
  });

  test("refuses to write when no endpoint is configured rather than reporting success", async () => {
    const { fetchImpl } = transport(() => ({ status: 200 }));
    const sink = new ClickhouseObservabilitySink({
      fetchImpl,
      readConfig: () => resolveObservabilityConfig({}),
    });
    await expect(sink.writeRows(sampleRows())).rejects.toThrow(/not configured/);
  });

  test("re-resolves configuration per call so a rotated credential takes effect", async () => {
    const { sent, fetchImpl } = transport(() => ({ status: 200 }));
    let password = "old";
    const sink = new ClickhouseObservabilitySink({
      fetchImpl,
      readConfig: () =>
        resolveObservabilityConfig({
          PLATOS_OBSERVABILITY_CLICKHOUSE_URL: `http://default:${password}@clickhouse:8123`,
        }),
    });
    await sink.writeRows(sampleRows());
    password = "rotated";
    await sink.writeRows(sampleRows());
    expect(sent[0].headers["Authorization"]).toBe(
      "Basic " + Buffer.from("default:old").toString("base64"),
    );
    expect(sent[1].headers["Authorization"]).toBe(
      "Basic " + Buffer.from("default:rotated").toString("base64"),
    );
  });
});

describe("errors", () => {
  test("keeps only the status and error number out of a failing response", async () => {
    // ClickHouse quotes the failing statement in its body, and a failing INSERT
    // quotes the rows — which can carry a display name and an email.
    const leaky =
      "Code: 62. DB::Exception: Syntax error: INSERT INTO platos_observability.turns_v1" +
      ' VALUES ("Ada Lovelace","ada@example.test")';
    const { fetchImpl } = transport(() => ({ status: 400, body: leaky }));
    const sink = new ClickhouseObservabilitySink({ fetchImpl, readConfig: config });

    const error = await sink.writeRows(sampleRows()).catch((err) => err);
    expect(error).toBeInstanceOf(ObservabilityWriteError);
    expect(error.status).toBe(400);
    expect(error.code).toBe(62);
    expect(error.message).not.toContain("Ada Lovelace");
    expect(error.message).not.toContain("ada@example.test");
    expect(errorClass(error)).toBe("ObservabilityWriteError 400/62");
  });

  test("keeps identity out of the health detail an unreachable endpoint produces", async () => {
    const sink = new ClickhouseObservabilitySink({
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED default:hunter2@clickhouse:8123");
      },
      readConfig: config,
    });
    const health = await sink.health();
    expect(health.detail).not.toContain("hunter2");
  });

  test("extracts the error number only from the head of a body", () => {
    expect(observabilityErrorCode("Code: 241. DB::Exception: Memory limit exceeded")).toBe(241);
    expect(observabilityErrorCode("no code here")).toBeUndefined();
  });
});
