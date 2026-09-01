## @platos/database

This is the internal database package for the Platos project. It exports a generated prisma client that can be instantiated with a connection string.

### How to switch branches when you've done migrations

Sometimes you've applied migrations and then want to switch branches without wiping out your local database.

The current compose stack uses the named `platos-postgres` volume. To preserve
it while testing a clean database, stop the stack and create a separate compose
project name:

```bash
docker compose -p platos-alt -f docker-compose.platos.yml up -d postgres
```

The `platos-alt` project owns a separate named volume. Apply migrations and seed
that clean database using the normal contributing workflow.

To switch back to the original volume, run the following command:

```bash
docker compose -p platos -f docker-compose.platos.yml up -d postgres
```

### How to add a new index on a large table

1. Modify the Prisma.schema with a single index change (no other changes, just one index at a time)
2. Create a Prisma migration using `cd internal-packages/database && pnpm run db:migrate:dev:create`
3. Modify the SQL file: add IF NOT EXISTS to it and CONCURRENTLY:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobRun_eventId_idx" ON "JobRun" ("eventId");
```

4. Don’t apply the Prisma migration locally yet. This is a good opportunity to test the flow.
5. Manually apply the index to your database, by running the index command.
6. Then locally run `pnpm run db:migrate:deploy`

#### Before deploying

Run the index creation before deploying

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobRun_eventId_idx" ON "JobRun" ("eventId");
```

These commands are useful:

```sql
-- creates an index safely, this can take a long time (2 mins maybe)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobRun_eventId_idx" ON "JobRun" ("eventId");
-- checks the status of an index
SELECT * FROM pg_stat_progress_create_index WHERE relid = '"JobRun"'::regclass;
-- checks if the index is there
SELECT * FROM pg_indexes WHERE tablename = 'JobRun' AND indexname = 'JobRun_eventId_idx';
```

Now, when you deploy and prisma runs the migration, it will skip the index creation because it already exists. If you don't do this, there will be pain.
