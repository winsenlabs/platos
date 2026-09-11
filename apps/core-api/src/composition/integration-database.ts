// HOW AN INTEGRATION SUITE IN THIS DIRECTORY TALKS TO A DATABASE SOMEBODY ELSE
// STARTED.
//
// WHY THIS FILE EXISTS. Six suites under `composition/` prove their contracts
// against a REAL PostgreSQL, and each of them needs a SECOND READER — a `psql`
// PROCESS, outside the adapter's pool, driver and transaction — because
// durability is not "the writer can see its own row" but "somebody else can see
// it". In container mode that process runs INSIDE the container, addressed by
// `-U user -d database`. In external mode it runs on the host and is addressed by
// a URL, and that is where a real defect lived.
//
// THE DEFECT, MEASURED. `PLATOS_POSTGRES_INTEGRATION_DATABASE_URL` is a PRISMA
// url, and the value this repository's own CI sets ends in `?schema=public`.
// `schema` is not a libpq parameter — it is Prisma's — so handing that url
// straight to `psql` fails with
//
//     psql: error: invalid URI query parameter: "schema"
//
// and every assertion that reads a row back fails. It is not a subtle failure and
// it is not a silent one, but it is an UNRELATED one: the case reports that a row
// is missing when the row is there and the reader could not connect. Run against
// the canonical url, the one suite that had external mode was 5 passed / 5 failed
// on this exact cause.
//
// SO THE URL IS TRANSLATED, AND THE TRANSLATION IS A PURE FUNCTION WITH ITS OWN
// CASES. It is one rule in one place rather than six copies, because a rule
// duplicated six times is a rule that gets "fixed" in one of them to make a
// failure go away.
//
// THIS FILE READS NO ENVIRONMENT. Every suite that uses it takes its own single
// frozen `{ ...process.env }` at module load and hands the values in, which is
// what keeps `scripts/arch/env-access.mjs` at one read per suite. A helper that
// read the environment itself would be a door this gate could not attribute.

/**
 * Query parameters PRISMA understands and `libpq` does not.
 *
 * Enumerated rather than allow-listing libpq's own set, which is long, versioned
 * and would refuse a parameter a newer client legitimately accepts. These are the
 * ones a Prisma url in this repository actually carries.
 *
 * `schema` is the one that bites: it is in the canonical CI url. `connection_limit`,
 * `pool_timeout`, `connect_timeout`, `socket_timeout`, `pgbouncer` and
 * `statement_cache_size` are the rest of Prisma's PostgreSQL set, listed so that a
 * runner who tunes a pool does not hit the same failure with a different name.
 */
export const PRISMA_ONLY_URL_PARAMETERS: readonly string[] = Object.freeze([
  "schema",
  "connection_limit",
  "pool_timeout",
  "connect_timeout",
  "socket_timeout",
  "pgbouncer",
  "statement_cache_size",
]);

/**
 * The same database, addressed the way `psql` can address it.
 *
 * WHAT IS AND IS NOT CHANGED. Only the query string is touched, and only by
 * REMOVING the parameters above; the scheme, credentials, host, port and database
 * are carried through untouched, so this cannot quietly point a suite at a
 * different server. Parameters it does not recognise are LEFT ALONE — `sslmode`
 * and `application_name` are real libpq parameters and dropping them would change
 * how the connection is made.
 *
 * A url that does not parse is returned UNCHANGED rather than repaired. `psql`
 * accepts more than a URL — a bare database name, a `key=value` conninfo string —
 * and a helper that threw here would turn a working plain-name invocation into a
 * failure. The caller's own connection is the right place for that to be refused,
 * with the real client's message.
 */
export function psqlConnectionUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return databaseUrl;
  let removed = false;
  for (const parameter of PRISMA_ONLY_URL_PARAMETERS) {
    if (parsed.searchParams.has(parameter)) {
      parsed.searchParams.delete(parameter);
      removed = true;
    }
  }
  if (!removed) return databaseUrl;
  // `URL.toString()` keeps a `?` for an emptied query string; `psql` tolerates it,
  // but a url that round-trips to something a human recognises is worth the line.
  const text = parsed.toString();
  return parsed.searchParams.size === 0 && text.endsWith("?") ? text.slice(0, -1) : text;
}

/**
 * The rows a second reader saw, one per line, `|`-separated by column.
 *
 * The shape both modes return, so a suite's assertions do not branch on which
 * mode it is in. Empty lines are dropped because `psql -t` emits a trailing one.
 */
export function psqlRows(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
