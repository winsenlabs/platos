import { describe, it, expect } from "vitest";
import {
  CLICKHOUSE_ERASURE_PLAN,
  eraseClickhouseSubject,
  notProvisioned,
  OBSERVABILITY_DATABASE,
  SPAN_DATABASE,
  type ClickhouseErasureTable,
} from "./clickhouse-erasure";
import type { ClickhouseErasureTransport, ClickhouseQueryOptions } from "./clickhouse";
import {
  deriveStatus,
  isStoreSettled,
  pendingStore,
  REQUIRED_STORES,
  type StoreOutcome,
} from "./erasure-receipt";
import type { SubjectKeys } from "./subject-graph";

/**
 * A ClickHouse that behaves like the real one in the only way that matters
 * here: `ALTER TABLE` REGISTERS work and returns, and the rows do not change
 * until a mutation reports `is_done`. Everything this module claims has to
 * survive that gap, so the gap is what the fake models.
 *
 * It is a fake server, not a mock of the code under test — the mutate → poll →
 * verify sequence runs for real against it.
 */
interface FakeTable {
  columns: string[];
  /** Rows still carrying subject identity. */
  rows: number;
  /** Rows left behind once the mutation applies. Default 0. */
  survivors?: number;
}

interface FakeBehaviour {
  /** Polls before a submitted mutation flips is_done. Infinity = never. */
  pollsUntilDone?: number;
  /** Mutation registers, then reports latest_fail_reason instead of finishing. */
  mutationFails?: boolean;
  /** Statements matching this prefix throw, as an unreachable server would. */
  throwOn?: string;
}

class FakeClickhouse implements ClickhouseErasureTransport {
  available = true;
  readonly statements: Array<{
    sql: string;
    params: Record<string, string>;
    settings?: Record<string, string>;
  }> = [];
  private readonly mutations: Array<{
    key: string;
    id: string;
    polls: number;
    done: boolean;
    failed: boolean;
  }> = [];
  private minted = 0;

  constructor(
    private readonly tables: Record<string, FakeTable>,
    private readonly behaviour: FakeBehaviour = {},
  ) {}

  get sql(): string[] {
    return this.statements.map((s) => s.sql);
  }

  async query(sql: string, options: ClickhouseQueryOptions = {}): Promise<string> {
    this.statements.push({ sql, params: options.params ?? {}, settings: options.settings });
    if (this.behaviour.throwOn && sql.startsWith(this.behaviour.throwOn)) {
      const err = new Error("boom");
      err.name = "ClickhouseQueryError";
      throw err;
    }
    if (sql.startsWith("SELECT database, table, name FROM system.columns")) {
      return (
        Object.entries(this.tables)
          .flatMap(([key, table]) => table.columns.map((column) => `${key.replace(".", "\t")}\t${column}`))
          .join("\n") + "\n"
      );
    }
    if (sql.startsWith("SELECT database, table, mutation_id")) {
      for (const mutation of this.mutations) {
        if (mutation.done || mutation.failed) continue;
        mutation.polls -= 1;
        if (mutation.polls > 0) continue;
        if (this.behaviour.mutationFails) mutation.failed = true;
        else {
          mutation.done = true;
          const table = this.tables[mutation.key]!;
          table.rows = table.survivors ?? 0;
        }
      }
      return (
        this.mutations
          .map(
            (m) =>
              `${m.key.replace(".", "\t")}\t${m.id}\t${m.done ? "1" : "0"}\t${m.failed ? "1" : "0"}`,
          )
          .join("\n") + "\n"
      );
    }
    if (sql.startsWith("SELECT count()")) {
      const key = /FROM ([\w.]+) WHERE/.exec(sql)?.[1] ?? "";
      return `${this.tables[key]?.rows ?? 0}\n`;
    }
    if (sql.startsWith("ALTER TABLE")) {
      const key = /ALTER TABLE ([\w.]+) /.exec(sql)?.[1] ?? "";
      this.mutations.push({
        key,
        id: `mutation_${(this.minted += 1)}`,
        polls: this.behaviour.pollsUntilDone ?? 1,
        done: false,
        failed: false,
      });
      return "";
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

const TURN_COLUMNS = [
  "organization_id",
  "end_user_id",
  "thread_id",
  "subject_key_hash",
  "user_display_name",
  "user_email",
];
const SPAN_COLUMNS = ["organization_id", "user_id", "thread_id"];

const subject: SubjectKeys = {
  platosEndUserIds: ["end_user_1"],
  legacyUserIds: ["lead-abc"],
  scopes: [],
};

/** Deterministic clock so a timeout is a decision, not a wall-clock wait. */
function clock() {
  let ms = 0;
  return {
    intervalMs: 250,
    timeoutMs: 1_000,
    now: () => ms,
    sleep: async (by: number) => {
      ms += by;
    },
  };
}

function erase(clickhouse: ClickhouseErasureTransport | null, over: Record<string, unknown> = {}) {
  return eraseClickhouseSubject({
    clickhouse,
    subject,
    organizationId: "org_1",
    subjectKeyHash: "a".repeat(64),
    threadIds: ["thread_1"],
    poll: clock(),
    ...over,
  });
}

describe("the mutation is submitted, not assumed", () => {
  it("submits one mutation per present table, in the shape each table needs", async () => {
    const server = new FakeClickhouse({
      [`${OBSERVABILITY_DATABASE}.turns_v1`]: { columns: TURN_COLUMNS, rows: 4 },
      [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 9 },
    });

    const outcome = await erase(server);

    const mutations = server.statements.filter((s) => s.sql.startsWith("ALTER TABLE"));
    expect(mutations).toHaveLength(2);
    // Turn-shaped rows are unlinked, not destroyed: the billing fact survives.
    expect(mutations[0]!.sql).toContain(
      `ALTER TABLE ${OBSERVABILITY_DATABASE}.turns_v1 UPDATE end_user_id = '', user_display_name = NULL, user_email = NULL WHERE`,
    );
    // The legacy span blob cannot be certified identity-free, so it goes.
    expect(mutations[1]!.sql).toContain(`ALTER TABLE ${SPAN_DATABASE}.platos_spans_v1 DELETE WHERE`);
    // Completion is proved by the poll, never by the statement returning.
    expect(mutations.every((s) => s.settings?.mutations_sync === "0")).toBe(true);
    expect(outcome.anonymized).toBe(4);
    expect(outcome.deleted).toBe(9);
    expect(outcome.discovered).toBe(13);
  });

  it("never concatenates a subject identifier into SQL", async () => {
    const server = new FakeClickhouse({
      [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 1 },
    });

    await erase(server);

    for (const statement of server.statements) {
      expect(statement.sql).not.toContain("lead-abc");
      expect(statement.sql).not.toContain("end_user_1");
    }
    const mutation = server.statements.find((s) => s.sql.startsWith("ALTER TABLE"))!;
    expect(mutation.params.ids).toBe("['end_user_1','lead-abc']");
    expect(mutation.params.threads).toBe("['thread_1']");
    expect(mutation.params.organization).toBe("org_1");
  });

  it("drops blank ids before they reach a predicate", async () => {
    const server = new FakeClickhouse({
      [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 1 },
    });

    // `user_id IN ['']` matches every system-attributed row in the org.
    await erase(server, {
      subject: { platosEndUserIds: ["", "end_user_1"], legacyUserIds: [""], scopes: [] },
      threadIds: ["", "thread_1"],
    });

    const mutation = server.statements.find((s) => s.sql.startsWith("ALTER TABLE"))!;
    expect(mutation.params.ids).toBe("['end_user_1']");
    expect(mutation.params.threads).toBe("['thread_1']");
  });
});

describe("polling waits for is_done", () => {
  it("does not verify until system.mutations reports the mutation done", async () => {
    const server = new FakeClickhouse(
      { [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 6 } },
      { pollsUntilDone: 3 },
    );

    const outcome = await erase(server);

    const kinds = server.sql.map((sql) =>
      sql.startsWith("ALTER TABLE")
        ? "mutate"
        : sql.startsWith("SELECT database, table, mutation_id")
          ? "poll"
          : sql.startsWith("SELECT count()")
            ? "count"
            : "catalog",
    );
    const mutateAt = kinds.indexOf("mutate");
    const verifyAt = kinds.lastIndexOf("count");
    // Three polls: the snapshot before the mutation plus the ones that waited.
    expect(kinds.filter((k) => k === "poll").length).toBeGreaterThanOrEqual(4);
    expect(verifyAt).toBeGreaterThan(mutateAt);
    expect(kinds.slice(mutateAt, verifyAt)).toContain("poll");
    expect(outcome.verificationStatus).toBe("passed");
  });

  it("an in-flight mutation is unknown, and unknown is never rounded up", async () => {
    const server = new FakeClickhouse(
      { [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 6 } },
      { pollsUntilDone: Number.POSITIVE_INFINITY },
    );

    const outcome = await erase(server);

    expect(outcome.verificationStatus).toBe("unknown");
    // No count after the mutation: with the mutation still running, a count is
    // meaningless in BOTH directions, so it is not run and not reported.
    const counts = server.sql.filter((sql) => sql.startsWith("SELECT count()"));
    expect(counts).toHaveLength(1);
    // And nothing may be claimed as deleted on the strength of a submission.
    expect(outcome.deleted).toBe(0);
    expect(isStoreSettled(outcome)).toBe(false);
    expect(deriveStatus(settledExcept(outcome), { started: true })).toBe("partial_failure");
  });

  it("counts a mutation ClickHouse is failing to apply as a failure, once", async () => {
    const server = new FakeClickhouse(
      { [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 6 } },
      { mutationFails: true },
    );

    const outcome = await erase(server);

    expect(outcome.status).toBe("failed");
    expect(outcome.failures).toBe(1);
    expect(outcome.verificationStatus).toBe("unknown");
    expect(outcome.note).toContain("mutations reported a failure");
  });

  it("cannot prove completion when system.mutations is unreadable", async () => {
    const server = new FakeClickhouse(
      { [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 6 } },
      { throwOn: "SELECT database, table, mutation_id" },
    );

    const outcome = await erase(server);

    expect(outcome.verificationStatus).toBe("unknown");
    expect(outcome.note).toContain("completion unproven");
  });
});

describe("negative verification", () => {
  it("re-counts with the same predicate the mutation used", async () => {
    const server = new FakeClickhouse({
      [`${OBSERVABILITY_DATABASE}.turns_v1`]: { columns: TURN_COLUMNS, rows: 2 },
    });

    const outcome = await erase(server);

    const counts = server.sql.filter((sql) => sql.startsWith("SELECT count()"));
    expect(counts).toHaveLength(2);
    expect(counts[0]).toBe(counts[1]);
    const where = /WHERE (.+) FORMAT/.exec(counts[0]!)![1]!;
    expect(server.sql.find((s) => s.startsWith("ALTER TABLE"))).toContain(`WHERE ${where}`);
    // Not a tautology: the locator alone would return zero the moment the
    // columns it matches on are emptied, so the residue clause is what is
    // actually being proved absent.
    expect(where).toContain("coalesce(end_user_id, '') != ''");
    expect(where).toContain("coalesce(user_email, '') != ''");
    expect(outcome.verificationStatus).toBe("passed");
  });

  it("reports survivors as a failed verification, not a partial success", async () => {
    const server = new FakeClickhouse({
      [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 5, survivors: 2 },
    });

    const outcome = await erase(server);

    expect(outcome.verificationStatus).toBe("failed");
    expect(deriveStatus(settledExcept(outcome), { started: true })).toBe("verification_failed");
  });

  it("treats an inconclusive re-count as still present, never as gone", async () => {
    const server = new FakeClickhouse({
      [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 5 },
    });
    const failing: ClickhouseErasureTransport = {
      available: true,
      query: async (sql, options) => {
        // Fail only the verification read: everything before it succeeds.
        if (sql.startsWith("SELECT count()") && server.sql.filter((s) => s.startsWith("ALTER")).length) {
          const err = new Error("boom");
          err.name = "ClickhouseQueryError";
          throw err;
        }
        return server.query(sql, options);
      },
    };

    const outcome = await erase(failing);

    expect(outcome.verificationStatus).toBe("unknown");
    expect(outcome.note).toContain("unverified (treated as still present)");
  });
});

describe("not_provisioned is never evidence of deletion", () => {
  it("zeroes every deletion counter and refuses to look verified", () => {
    const outcome = notProvisioned("no clickhouse endpoint configured");

    expect(outcome.status).toBe("not_provisioned");
    expect(outcome.deleted).toBe(0);
    expect(outcome.anonymized).toBe(0);
    expect(outcome.discovered).toBe(0);
    expect(outcome.verificationStatus).toBe("not_applicable");
    expect(outcome.verificationStatus).not.toBe("passed");
    // It settles the operation — which is exactly why it may claim nothing.
    expect(isStoreSettled(outcome)).toBe(true);
  });

  it("is the outcome when no endpoint is configured, and submits nothing", async () => {
    const absent: ClickhouseErasureTransport = {
      available: false,
      query: async () => {
        throw new Error("must not be called");
      },
    };

    await expect(erase(absent)).resolves.toMatchObject({
      status: "not_provisioned",
      deleted: 0,
      anonymized: 0,
    });
    await expect(erase(null)).resolves.toMatchObject({ status: "not_provisioned" });
  });

  it("is the outcome when a reachable ClickHouse holds none of the tables", async () => {
    const server = new FakeClickhouse({});

    const outcome = await erase(server);

    expect(outcome.status).toBe("not_provisioned");
    expect(outcome.verificationStatus).toBe("not_applicable");
    expect(outcome.note).toContain("not evidence of deletion");
    expect(server.sql.filter((sql) => sql.startsWith("ALTER TABLE"))).toHaveLength(0);
  });

  it("is NOT the outcome when ClickHouse exists and cannot be reached", async () => {
    const unreachable = new FakeClickhouse(
      { [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 3 } },
      { throwOn: "SELECT database, table, name" },
    );

    const outcome = await erase(unreachable);

    // The difference that matters: an unreachable store does not settle.
    expect(outcome.status).toBe("failed");
    expect(outcome.verificationStatus).toBe("unknown");
    expect(isStoreSettled(outcome)).toBe(false);
    expect(outcome.note).toContain("store NOT reported absent");
    expect(outcome.note).toContain("ClickhouseQueryError");
  });

  it("is NOT the outcome when a table is present but unaddressable", async () => {
    const drifted = new FakeClickhouse({
      [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: ["organization_id", "span_id"], rows: 3 },
    });

    const outcome = await erase(drifted);

    expect(outcome.status).toBe("failed");
    expect(outcome.verificationStatus).toBe("unknown");
    expect(outcome.note).toContain("schema drift");
    expect(drifted.sql.filter((sql) => sql.startsWith("ALTER TABLE"))).toHaveLength(0);
  });

  it("is NOT the outcome when the subject resolves to no addressable key", async () => {
    const server = new FakeClickhouse({
      [`${SPAN_DATABASE}.platos_spans_v1`]: { columns: SPAN_COLUMNS, rows: 3 },
    });

    const outcome = await erase(server, {
      subject: { platosEndUserIds: [], legacyUserIds: [], scopes: [] },
      threadIds: [],
      subjectKeyHash: null,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.verificationStatus).toBe("unknown");
    expect(server.statements).toHaveLength(0);
  });
});

describe("the plan is turn-shaped", () => {
  it("covers Thread -> Turn -> Step -> Tool Call, plus the legacy span projection", () => {
    const named = (table: string): ClickhouseErasureTable =>
      CLICKHOUSE_ERASURE_PLAN.find((spec) => spec.table === table)!;

    for (const table of ["turns_v1", "steps_v1", "tool_calls_v1", "usage_events_v1"]) {
      expect(named(table).database).toBe(OBSERVABILITY_DATABASE);
      expect(named(table).threadColumn).toBe("thread_id");
      expect(named(table).subjectHashColumn).toBe("subject_key_hash");
      // Unlink, never delete: these rows are billing and reliability facts.
      expect(named(table).action.kind).toBe("clear");
    }
    // Plaintext identity lives on the Turn; the rest carry only the id.
    expect(named("turns_v1").action).toMatchObject({
      columns: [
        { name: "end_user_id" },
        { name: "user_display_name" },
        { name: "user_email" },
      ],
    });
    expect(named("platos_spans_v1").database).toBe(SPAN_DATABASE);
    expect(named("platos_spans_v1").action.kind).toBe("delete");
  });
});

/** The other three stores verified, so the clickhouse outcome decides the status. */
function settledExcept(clickhouse: StoreOutcome): StoreOutcome[] {
  const settled: StoreOutcome[] = REQUIRED_STORES.filter((store) => store !== "clickhouse").map(
    (store) => ({ ...pendingStore(store), status: "done", verificationStatus: "passed" }),
  );
  return [...settled, clickhouse];
}
