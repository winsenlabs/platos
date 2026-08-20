/**
 * In-memory stand-ins for the stores an erasure destroys data in.
 *
 * These are doubles for the STORES, never for the code under test. Every test
 * that uses them runs the real ErasureService, the real orchestrator and the
 * real key planner; what is substituted is Postgres, Redis and the object
 * store, because the properties worth asserting here are all statements about
 * what those stores contain AFTERWARDS. A mock that records "del was called"
 * asserts nothing about that — it is satisfied by a sweep that deletes nothing.
 *
 * Each double therefore reproduces the one semantic of its real counterpart
 * that erasure can get wrong:
 *
 *   REDIS   ioredis's `keyPrefix` is asymmetric. keys()/scan() hand back
 *           PREFIXED keys and del()/exists() prefix again, so feeding a scan
 *           result straight into del() addresses "platos:platos:…" and deletes
 *           nothing — successfully, because deleting an absent key is a no-op.
 *           The double prefixes on both sides exactly as ioredis does, which is
 *           what makes a state assertion able to catch the bug at all.
 *
 *   BUCKET  S3-compatible delete is idempotent and returns success for a key
 *           that was never there. So a successful delete is not evidence, and
 *           the double will happily "succeed" at deleting nothing; only the
 *           existence probe distinguishes the two.
 *
 *   POSTGRES enough of the Prisma filter language for the queries this module
 *           issues, including the JSON-path form the tool-call audit sweep
 *           depends on — without it every audit row matches every subject, and
 *           a test asserting a bystander survived would pass for the wrong
 *           reason.
 */

import { Prisma } from "@platos/tenancy-database";

export type Row = Record<string, any>;

/**
 * Prisma's JSON-null sentinels are write-side markers only: the column reads
 * back as a plain null.
 *
 * Reproduced because the tool-call audit anonymization writes `Prisma.DbNull`
 * and then RE-READS the row to prove it came out content-free. A double that
 * handed the sentinel back would fail a verification the real database passes,
 * and the failure would look like a defect in the sweep.
 */
function applyWrite(row: Row, data: Row): Row {
  for (const [field, value] of Object.entries(data)) {
    const isJsonNull =
      value === Prisma.DbNull || value === Prisma.JsonNull || value === Prisma.AnyNull;
    row[field] = isJsonNull ? null : value;
  }
  return row;
}

/**
 * Enough of the Prisma filter language for the queries these services issue.
 *
 * Nested relation filters (`environment: { project: … }`) are treated as
 * satisfied: the ancestry rules they express are asserted directly in
 * erasure.service.test.ts, and reproducing joins here would be a second
 * implementation of Prisma to get wrong.
 */
export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!(condition as Row[]).some((clause) => matches(row, clause))) return false;
      continue;
    }
    const value = row[key];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
    } else if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
    } else if (condition && typeof condition === "object") {
      const c = condition as Row;
      if (Array.isArray(c.in)) {
        if (!c.in.includes(value)) return false;
      } else if ("not" in c) {
        if (c.not === null ? value === null || value === undefined : value === c.not) return false;
      } else if ("gt" in c) {
        if (!(value > c.gt)) return false;
      } else if ("lte" in c) {
        if (value === null || value === undefined || !(value <= c.lte)) return false;
      } else if (Array.isArray(c.path) && "equals" in c) {
        // JSON path, as the legacy audit and safety-event matchers use it.
        let cursor: unknown = value;
        for (const step of c.path) cursor = (cursor as Row | undefined)?.[step as string];
        if (cursor !== c.equals) return false;
      } else {
        // Relation filter; see the note above.
        continue;
      }
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

let sequence = 0;
function newId(prefix: string): string {
  sequence++;
  return `${prefix}_${sequence}`;
}

export function table(name: string, rows: Row[] = []) {
  const compound = (where: Row): Row => {
    const key = Object.keys(where)[0]!;
    return key.includes("_") && typeof where[key] === "object" ? where[key] : where;
  };
  /**
   * Which mutating operations this table received.
   *
   * The sweep names its models by hand, so the set of tables it touched is the
   * only statement of what it actually covers — a constant listing the intent
   * would still be satisfied by an executor that skipped one.
   */
  const destructive: string[] = [];
  return {
    rows,
    destructive,
    findFirst: async ({ where }: Row = {}) => rows.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: Row) => rows.find((r) => matches(r, compound(where))) ?? null,
    findMany: async ({ where, orderBy, take }: Row = {}) => {
      let hits = rows.filter((r) => matches(r, where));
      if (orderBy) {
        const [field, direction] = Object.entries(orderBy)[0] as [string, string];
        hits = [...hits].sort((a, b) =>
          (direction === "desc" ? -1 : 1) * ((a[field] ?? 0) - (b[field] ?? 0)),
        );
      }
      return typeof take === "number" ? hits.slice(0, take) : hits;
    },
    count: async ({ where }: Row = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: Row) => {
      const row = applyWrite({ id: data.id ?? newId(name) }, data);
      rows.push(row);
      return row;
    },
    createMany: async ({ data, skipDuplicates }: Row) => {
      let count = 0;
      for (const item of data as Row[]) {
        const clash =
          skipDuplicates &&
          rows.some(
            (r) => r.organizationId === item.organizationId && r.aliasHash === item.aliasHash,
          );
        if (clash) continue;
        rows.push(applyWrite({ id: newId(name) }, item));
        count++;
      }
      return { count };
    },
    update: async ({ where, data }: Row) => {
      destructive.push("update");
      const row = rows.find((r) => matches(r, compound(where)));
      if (!row) throw new Error(`${name} row not found`);
      return applyWrite(row, data);
    },
    updateMany: async ({ where, data }: Row) => {
      destructive.push("updateMany");
      const hits = rows.filter((r) => matches(r, where));
      for (const row of hits) applyWrite(row, data);
      return { count: hits.length };
    },
    upsert: async ({ where, create, update }: Row) => {
      destructive.push("upsert");
      const row = rows.find((r) => matches(r, compound(where)));
      if (row) return applyWrite(row, update);
      const created = applyWrite({ id: newId(name), ...compound(where) }, create);
      rows.push(created);
      return created;
    },
    deleteMany: async ({ where }: Row = {}) => {
      destructive.push("deleteMany");
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i]!, where)) rows.splice(i, 1);
      }
      return { count: before - rows.length };
    },
  };
}

/**
 * A table the sweep must never touch, wired so that touching it is loud.
 *
 * `userId` on the operator-session, membership, PAT, MFA and OAuth token
 * tables means the PLATOS OPERATOR — the human who logs in — not the subject,
 * as subject-graph.ts sets out. Those enumerations are declarative constants
 * that no executor consults, so the only thing standing between an operator's
 * account and a customer's erasure request is that postgresExecutor names its
 * models by hand. Here the attempt is both recorded (so a failing test can name
 * the table) and refused (so the double cannot quietly carry out the deletion
 * the assertion is about to look for).
 */
export function operatorTable(name: string, rows: Row[] = []) {
  const delegate = table(name, rows);
  const forbid = (operation: string) => async () => {
    delegate.destructive.push(operation);
    throw new Error(`operator table ${name} must never be swept (${operation})`);
  };
  return {
    ...delegate,
    deleteMany: forbid("deleteMany"),
    update: forbid("update"),
    updateMany: forbid("updateMany"),
    upsert: forbid("upsert"),
  };
}

/** The tenancy tables an erasure reads, writes or must leave alone. */
export function database(environments: Row[] = [{ id: "env_1", projectId: "project_1" }]) {
  const db: Row = {
    adminAudit: table("admin_audit"),
    endUser: table("end_user"),
    endUserIdentity: table("identity"),
    erasureOperation: table("operation"),
    erasureTombstone: table("tombstone"),
    thread: table("thread"),
    memory: table("memory"),
    memoryEntity: table("memory_entity"),
    memoryRelationship: table("memory_relationship"),
    messageRating: table("rating"),
    messageAttachment: table("attachment"),
    toolCallAudit: table("audit"),
    safetyEvent: table("safety"),
    environment: table("environment", environments),
  };
  // The Postgres executor is the only thing here that opens a transaction, so
  // counting them counts destructive Postgres passes.
  db.transactions = 0;
  db.$transaction = async (arg: any) => {
    db.transactions++;
    return typeof arg === "function" ? arg(db) : Promise.all(arg);
  };
  return db;
}

/**
 * ioredis stand-in. Keys are stored on the wire, WITH the prefix attached.
 *
 * That is the whole design: scans hand back the physical key and mutations
 * prefix what they are given, so code that forgets to strip addresses a key
 * that does not exist and the store keeps the data. Assertions against `store`
 * are therefore assertions about the keyspace, not about call arguments.
 */
export function redisDouble() {
  const keys = new Map<string, string>();
  const state = {
    scanFails: false,
    /** del() raises, as a read-only replica or a severed connection would. */
    undeletable: new Set<string>(),
    /**
     * del() reports success and removes nothing — the exact signature of the
     * double-prefix bug, reproduced so the verification pass can be shown to
     * catch it rather than inheriting the same broken assumption.
     */
    silentlyIgnores: new Set<string>(),
  };
  /** Every key handed to del(), exactly as the caller addressed it. */
  const deleteTargets: string[] = [];
  return {
    store: keys,
    state,
    deleteTargets,
    keys: async (pattern: string) => {
      if (state.scanFails) throw new Error("connection reset");
      const re = new RegExp(
        `^platos:${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
      );
      return [...keys.keys()].filter((k) => re.test(k));
    },
    del: async (key: string) => {
      deleteTargets.push(key);
      if (state.undeletable.has(key)) throw new Error("READONLY");
      if (state.silentlyIgnores.has(key)) return 0;
      return keys.delete(`platos:${key}`) ? 1 : 0;
    },
    exists: async (key: string) => (keys.has(`platos:${key}`) ? 1 : 0),
  };
}

/**
 * ErasureObjectStore stand-in over an in-memory bucket.
 *
 * Delete succeeds whether or not the key was there, exactly as S3 does, so the
 * only thing that can distinguish an erased object from one that was never
 * addressed is the probe. `inconclusive` reproduces the contract the real
 * client implements for a non-404 error: report the object as STILL PRESENT
 * rather than rounding an ambiguous answer down to "gone".
 */
export function bucketDouble(objects: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(objects));
  const state = { available: true, deleteFails: new Set<string>(), inconclusive: new Set<string>() };
  const deleted: string[] = [];
  return {
    store,
    state,
    deleted,
    get available() {
      return state.available;
    },
    deleteObject: async (key: string) => {
      if (state.deleteFails.has(key)) throw new Error("SlowDown");
      deleted.push(key);
      store.delete(key);
    },
    objectExists: async (key: string) => state.inconclusive.has(key) || store.has(key),
  };
}
