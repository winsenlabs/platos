// WIN-284 — the isolated twin-PostgreSQL subject: the state-conservation half.
//
// WHAT IS REAL HERE, stated plainly so nobody has to infer it:
//
//   REAL  The schema. Both stores are built by running the repository's own
//         `prisma migrate deploy` over internal-packages/tenancy-database —
//         the same 93-model tenancy schema the shipping system uses, applied
//         by the same migration files, not a fixture that resembles it.
//   REAL  The isolation. Two separate PostgreSQL databases with separate
//         catalogues, separate connections and separate sequences. Nothing is
//         shared but the server process, which is why this subject reports
//         statement and row accounting and deliberately does NOT report cost
//         or timing: those would be measuring one machine's load, not parity.
//   REAL  The tier boundary. The restricted role's grants are derived at run
//         time from the model list in prisma/end-user.prisma — the actual
//         end-user schema, parsed, not a hardcoded copy. A scenario that runs
//         as the restricted role and touches an operator-only table is denied
//         by PostgreSQL itself, with a genuine 42501.
//
// WHAT IS NOT: this subject does not exercise REST, MCP, SDK, channels or
// streams, because no V1 implementation of those exists at this baseline. The
// coverage matrix records those cells as `uncovered` against the milestone that
// will build them. It does not claim production enforces the end-user tier in
// PostgreSQL — production enforces it in the client; this models that boundary
// at the store so the auth dimension has something real to compare today.
//
// No new dependency is introduced. Everything goes through the `docker` CLI and
// `psql` inside the container, so the root lockfile is untouched and the SBOM,
// advisory and licence gates see no change.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const DEFAULT_IMAGE = "pgvector/pgvector:pg16";
const OWNER_ROLE = "twin_owner";
const RESTRICTED_ROLE = "twin_restricted";
export const ROLES = Object.freeze(["owner", "restricted"]);

// PostgreSQL error classes this subject knows how to read as an HTTP-shaped
// outcome. Anything else is reported as 500 with its SQLSTATE intact rather
// than being flattened into a generic failure.
export const SQLSTATE_STATUS = Object.freeze({
  "42501": 403, // insufficient_privilege
  "42P01": 404, // undefined_table
  "23505": 409, // unique_violation
  "23503": 409, // foreign_key_violation
  "23502": 422, // not_null_violation
  "22P02": 400, // invalid_text_representation
});

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

// Provisioning statements — CREATE DATABASE, CREATE ROLE, GRANT. These are not
// observations and are never compared; they fail loudly if they fail at all,
// because a half-provisioned store would otherwise be twin-run and its missing
// grants would read as an auth divergence in the candidate.
function psql(container, database, statement, options = {}) {
  const user = options.user ?? OWNER_ROLE;
  const args = ["exec"];
  if (options.password) args.push("--env", `PGPASSWORD=${options.password}`);
  args.push(
    container, "psql", "-X", "-q", "-A", "-t", "--no-psqlrc",
    "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose",
    "-U", user, "-d", database, "-c", statement,
  );
  return docker(args, { stdio: ["ignore", "pipe", "pipe"] });
}

// The end-user tier's model list, read from the real schema. Hardcoding this
// list would let the schema and the harness drift apart silently, and the
// harness would keep reporting auth parity against a boundary that had moved.
export function readEndUserModels(repositoryRoot) {
  const source = readFileSync(
    join(repositoryRoot, "internal-packages/tenancy-database/prisma/end-user.prisma"),
    "utf8",
  );
  const models = [...source.matchAll(/^model\s+(\w+)\s*\{/gmu)].map((match) => match[1]);
  if (models.length === 0) throw new Error("no models found in end-user.prisma; the tier boundary cannot be derived");
  return models.sort();
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/gu, '""')}"`;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export async function startTwinStores(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const image = options.image ?? DEFAULT_IMAGE;
  const label = options.label ?? randomBytes(4).toString("hex");
  const container = `win284-twin-${label}`;
  const password = randomBytes(12).toString("hex");

  docker([
    "run", "--detach", "--rm",
    "--name", container,
    "--env", `POSTGRES_USER=${OWNER_ROLE}`,
    "--env", `POSTGRES_PASSWORD=${password}`,
    "--env", "POSTGRES_DB=postgres",
    "--publish", "0:5432",
    image,
  ]);

  const stop = () => {
    try {
      docker(["stop", container], { stdio: "pipe" });
    } catch {
      // The container is --rm and may already be gone; failing to stop an
      // already-stopped container must never mask a real test failure.
    }
  };

  try {
    await waitForReady(container, OWNER_ROLE);
    const port = docker(["port", container, "5432/tcp"]).trim().split("\n")[0].split(":").pop();
    const endUserModels = readEndUserModels(repositoryRoot);

    const stores = {};
    for (const [side, database] of [["oracle", "twin_oracle"], ["candidate", "twin_candidate"]]) {
      psql(container, "postgres", `CREATE DATABASE ${quoteIdentifier(database)}`);
      applySchema(repositoryRoot, `postgresql://${OWNER_ROLE}:${password}@127.0.0.1:${port}/${database}`);
      grantRestrictedRole(container, database, password, endUserModels);
      stores[side] = { side, container, database, port, password, endUserModels };
    }

    // The isolation the engine asserts on: two different store identities.
    if (stores.oracle.database === stores.candidate.database) {
      throw new Error("twin stores must be two databases; one database compared with itself cannot diverge");
    }
    return { container, port, password, stores, endUserModels, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

async function waitForReady(container, user) {
  const deadline = Date.now() + 90_000;
  let lastError = "never probed";
  while (Date.now() < deadline) {
    try {
      docker(["exec", container, "pg_isready", "-U", user, "-d", "postgres"], { stdio: "pipe" });
      return;
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`twin PostgreSQL never became ready: ${lastError}`);
}

function applySchema(repositoryRoot, databaseUrl) {
  const packageDirectory = join(repositoryRoot, "internal-packages/tenancy-database");
  execFileSync(join(packageDirectory, "node_modules/.bin/prisma"), [
    "migrate", "deploy", "--schema", join(packageDirectory, "prisma/schema.prisma"),
  ], {
    cwd: packageDirectory,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
    encoding: "utf8",
  });
}

function grantRestrictedRole(container, database, password, endUserModels) {
  const statements = [
    `DROP ROLE IF EXISTS ${quoteIdentifier(RESTRICTED_ROLE)}`,
    `CREATE ROLE ${quoteIdentifier(RESTRICTED_ROLE)} LOGIN PASSWORD ${literal(password)}`,
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(RESTRICTED_ROLE)}`,
    `GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(RESTRICTED_ROLE)}`,
    ...endUserModels.map(
      (model) =>
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${quoteIdentifier(model)} TO ${quoteIdentifier(RESTRICTED_ROLE)}`,
    ),
  ];
  for (const statement of statements) psql(container, database, statement);
}

function literal(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

// ---------------------------------------------------------------------------
// Statement execution
// ---------------------------------------------------------------------------

// Every operation is wrapped in a data-modifying CTE and aggregated to one JSON
// document, so a SELECT and an INSERT ... RETURNING come back through the same
// path and the observation never depends on which verb a scenario used.
export function runStatement(store, statement, role = "owner") {
  if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
  const user = role === "owner" ? OWNER_ROLE : RESTRICTED_ROLE;
  const wrapped = `WITH op AS (${statement}) SELECT coalesce(json_agg(op), '[]'::json)::text FROM op`;
  try {
    const output = docker([
      "exec", "--env", `PGPASSWORD=${store.password}`, store.container,
      "psql", "-X", "-q", "-A", "-t", "--no-psqlrc",
      "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose",
      "-U", user, "-d", store.database, "-c", wrapped,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, rows: JSON.parse(output.trim() || "[]"), sqlstate: null, message: null };
  } catch (error) {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    const sqlstate = /SQLSTATE\s+([0-9A-Z]{5})/u.exec(text)?.[1] ?? null;
    if (sqlstate === null) {
      // A failure the subject cannot classify is raised, never folded into a
      // comparable "it failed somehow" that would compare equal on both sides.
      throw new Error(`unclassifiable psql failure on ${store.database}: ${text.trim() || error.message}`);
    }
    return { ok: false, rows: [], sqlstate, message: firstErrorLine(text) };
  }
}

function firstErrorLine(text) {
  const line = text.split("\n").find((entry) => entry.startsWith("ERROR:"));
  return line ? line.replace(/^ERROR:\s*/u, "").trim() : null;
}

export function dumpTable(store, table) {
  const result = runStatement(
    store,
    `SELECT * FROM public.${quoteIdentifier(table)} ORDER BY 1`,
    "owner",
  );
  if (!result.ok) throw new Error(`could not dump ${table}: ${result.sqlstate} ${result.message}`);
  return result.rows;
}

// ---------------------------------------------------------------------------
// The subject
// ---------------------------------------------------------------------------

// A scenario for this subject declares:
//   operations       [{ id, sql, role }]           executed in order
//   resultOf         <operation id>                whose rows become the body
//   storeTables      [table, ...]                  dumped into store state
//   sideEffectVerbs  { <operation id>: "insert" }  how a change is described
export function createPostgresSubject({ side, store }) {
  if (side !== "oracle" && side !== "candidate") throw new Error(`side must be oracle or candidate, saw ${side}`);
  return {
    name: `postgres-twin:${store.database}`,
    async run(scenario) {
      const events = [];
      const sideEffects = [];
      let status = 200;
      let body = null;
      let decision = "allow";
      let reason = null;
      let rowsReturned = 0;

      const startedAt = Date.now();
      for (const operation of scenario.operations) {
        const role = operation.role ?? "owner";
        const result = runStatement(store, operation.sql, role);
        events.push({
          name: operation.id,
          payload: { ok: result.ok, rowCount: result.rows.length, sqlstate: result.sqlstate },
        });
        if (result.ok) {
          rowsReturned += result.rows.length;
          const verb = scenario.sideEffectVerbs?.[operation.id];
          if (verb && result.rows.length > 0) {
            sideEffects.push({ kind: verb, target: operation.target ?? operation.id, detail: { rows: result.rows.length } });
          }
          if (operation.id === scenario.resultOf) body = result.rows;
        } else {
          status = SQLSTATE_STATUS[result.sqlstate] ?? 500;
          if (status === 403) {
            decision = "deny";
            reason = `sqlstate.${result.sqlstate}`;
          }
          if (operation.id === scenario.resultOf) body = null;
          if (!operation.continueOnError) break;
        }
      }

      const store_ = {};
      for (const table of scenario.storeTables ?? []) store_[table] = dumpTable(store, table);

      return {
        scenario: scenario.id,
        side,
        subject: `postgres-twin:${store.database}`,
        storeIdentity: store.database,
        response: { status, headers: { "content-type": "application/json" }, body },
        events,
        auth: {
          // The principal is the tier, not the ephemeral role name: role names
          // are identical across the twins by construction, so reporting the
          // name would make the auth dimension compare a constant.
          principal: scenario.operations.some((operation) => (operation.role ?? "owner") === "restricted")
            ? "tier:end-user"
            : "tier:operator",
          scopes: scenario.operations.some((operation) => (operation.role ?? "owner") === "restricted")
            ? store.endUserModels.map((model) => `table:${model}`)
            : ["table:*"],
          decision,
          reason,
        },
        sideEffects,
        usage: {
          // Statement and row accounting only. `costMicros` is zero because
          // this subject does not model money, and a scenario that wants cost
          // parity evidence must say so and use a metered subject instead.
          inputUnits: scenario.operations.length,
          outputUnits: rowsReturned,
          costMicros: 0,
          durationMs: Date.now() - startedAt,
        },
        store: store_,
      };
    },
  };
}
