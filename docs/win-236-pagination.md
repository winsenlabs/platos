# WIN-236 pagination contract

## Compatibility

Collection responses retain their existing array fields (`agents`, `versions`, `rows`, `entities`, `tasks`, `criteria`, `attachments`, `users`, `conversations`, `skills`, `clusters`, `keys`, `channels`, `apps`, `templates`, and `caps`). `items`, truthful `total`, `limit`, `offset`, `hasMore`, `pagination`, and `filters` are additive. Files retain `messageId`, `turnId`, and `fetchedAt`; approvals retain `pendingCount`; AgentVersion cursor callers retain `versions` and `nextCursor`. Cursor requests intentionally omit offset range metadata because a cursor does not prove its absolute offset.

Malformed pagination and filter values now return HTTP 400 instead of being silently coerced. Agent APIs cap pages at 200 rows; dashboard loaders cap pages at 100.

## Query behavior and budgets

- Agent, Entity, Job, audit, approval, eval, criterion, attachment, Skill, Cluster, provider-key, Channel, Postman-template, safety-event, and configured-budget item/count queries share the same tenant scope and filter predicate.
- Search and filters are applied before count and pagination.
- Stable ordering always includes an immutable ID tie-break after the product sort key.
- Tool health is loaded only for Tool/entity pairs on the returned registry or Agent Tool page.
- ChannelInstallation statuses are loaded for the current ChannelApp page with one set query; the dashboard no longer performs a row-by-row status request.
- Skill environment readiness batches required key-presence lookup across the returned page instead of resolving each Skill independently.
- Files levels 1–3 use one grouped page query and one exact `COUNT(DISTINCT ...)` query; Agent names are selected in the grouped query. Attachments use one page query and one exact count, then presign only returned rows.
- Cost rollups preserve the existing Redis-plus-Step attribution algorithm. Pagination bounds the response and reports the exact number of matching rollup groups, but the attribution pass still reads the scoped window; this is a known implementation constraint rather than a hidden row cap.
- Budget status must evaluate every applicable cap to preserve the global `blocked` decision. Only its returned status rows are paged; configured-budget listing itself uses a bounded page/count query.

Target interactive budget for a 25–50 row page is two database round trips (page plus count), with no row-by-row database query. Files query-plan fixtures should verify indexes support tenant ancestry joins and the final stable ordering before release.

## Postgres verification

Run against an isolated generated-schema Postgres fixture, never production:

1. Seed approximately 40 Agents, 200 Tools, equal timestamps, multi-page audit/approval/eval rows, and all four Files hierarchy levels in two tenant scopes.
2. Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for each page and count query with first, middle, last, filtered-empty, and past-end offsets.
3. Assert every plan applies Organization/Project/Environment predicates before `Limit`, returns the same count predicate as the item query, and does not execute a correlated row-by-row lookup.
4. Assert equal-timestamp pages are ordered by descending ID for Agents, Jobs, audit, approvals, evals, criteria, attachments, and Files grouping IDs.
5. Record fixture cardinality, planning/execution time, rows removed by filter, shared buffer reads, and any sequential scan. A sequential scan on a dense fixture requires an index review before release.

The repository’s Postgres/testcontainers suite is the required environment for these assertions. Local WIN-236 work must not substitute a mocked Prisma source assertion for the real plan gate.
