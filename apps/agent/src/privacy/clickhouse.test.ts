import { describe, it, expect, afterEach } from "vitest";
import {
  ClickhouseQueryError,
  ErasureClickhouse,
  clickhouseArrayParam,
  clickhouseErrorCode,
  parseClickhouseEndpoint,
  parseTabSeparated,
} from "./clickhouse";

const ENV_KEYS = ["PLATOS_OTEL_CLICKHOUSE_URL", "CLICKHOUSE_URL"] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("configured URL handling", () => {
  it("splits the compose-form credentials out of the URL", () => {
    // Node's fetch REFUSES a URL carrying credentials, and the previous
    // executor passed one straight in — every probe threw, and a throw read as
    // "no ClickHouse in this deployment".
    const parsed = parseClickhouseEndpoint("http://default:pw%40rd@clickhouse:8123?secure=false");

    expect(parsed).toEqual({
      endpoint: "http://clickhouse:8123",
      auth: { user: "default", pass: "pw@rd" },
    });
    expect(() => new Request(parsed!.endpoint)).not.toThrow();
  });

  it("drops the configured query string so `?query=` cannot collide with it", () => {
    expect(parseClickhouseEndpoint("http://clickhouse:8123/?secure=false")?.endpoint).toBe(
      "http://clickhouse:8123",
    );
  });

  it("returns null for absent or unusable configuration", () => {
    expect(parseClickhouseEndpoint(undefined)).toBeNull();
    expect(parseClickhouseEndpoint("   ")).toBeNull();
    expect(parseClickhouseEndpoint("clickhouse:8123")).toBeNull();
  });

  it("prefers the variable the agent process actually receives", () => {
    // Compose sets PLATOS_OTEL_CLICKHOUSE_URL on the agent and CLICKHOUSE_URL
    // on the webapp; the spans being erased were written to the former.
    process.env.PLATOS_OTEL_CLICKHOUSE_URL = "http://spans:8123";
    process.env.CLICKHOUSE_URL = "http://elsewhere:8123";
    expect(new ErasureClickhouse().available).toBe(true);

    delete process.env.PLATOS_OTEL_CLICKHOUSE_URL;
    expect(new ErasureClickhouse().available).toBe(true);
  });

  it("is unavailable, not broken, when nothing is configured", async () => {
    // ClickHouse is deliberately absent from local/dev compose.
    const client = new ErasureClickhouse();
    expect(client.available).toBe(false);
    await expect(client.query("SELECT 1")).rejects.toThrow("not configured or not usable");
  });

  it("is available-but-broken when the endpoint is unusable, never absent", async () => {
    // `available: false` settles the erasure as not_provisioned. A typo in a
    // URL is not evidence that a store holds no personal data, so a configured
    // endpoint stays available and fails loudly on use.
    process.env.PLATOS_OTEL_CLICKHOUSE_URL = "clickhouse:8123";
    const client = new ErasureClickhouse();

    expect(client.available).toBe(true);
    await expect(client.query("SELECT 1")).rejects.toThrow("not configured or not usable");
  });
});

describe("parameters are never concatenated into SQL", () => {
  it("escapes quotes and backslashes in the array literal", () => {
    expect(clickhouseArrayParam(["a", "o'brien", "back\\slash"])).toBe(
      "['a','o\\'brien','back\\\\slash']",
    );
  });

  it("renders an empty subject list as an empty array", () => {
    expect(clickhouseArrayParam([])).toBe("[]");
  });
});

describe("error bodies never leave the client", () => {
  it("keeps the status and ClickHouse code, and nothing else", () => {
    const err = new ClickhouseQueryError(
      401,
      clickhouseErrorCode("Code: 516. DB::Exception: default: Authentication failed"),
    );

    expect(err.name).toBe("ClickhouseQueryError");
    expect(err.status).toBe(401);
    expect(err.code).toBe(516);
    // The body quotes the failing statement, which quotes the subject.
    expect(err.message).not.toContain("DB::Exception");
    expect(err.message).toBe("clickhouse statement failed (http 401) (code 516)");
  });

  it("survives a body with no code in it", () => {
    expect(clickhouseErrorCode("<html>502 Bad Gateway</html>")).toBeUndefined();
  });
});

describe("TabSeparated parsing", () => {
  it("splits rows and drops the trailing newline", () => {
    expect(parseTabSeparated("a\tb\tc\nd\te\tf\n")).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
    expect(parseTabSeparated("\n")).toEqual([]);
    expect(parseTabSeparated("")).toEqual([]);
  });
});
