---
"@platosdev/client": patch
---

The generated V1 client learns two additive contract changes from the webapp
cutover.

`ProjectResource` now carries `environments` — the project's unarchived
environments, oldest first, with `id`, `slug`, `name` and `createdAt`. The
`GET /projects` listing replaced a Prisma query that had selected them nested,
and the two dashboard screens it serves both choose an environment: a listing
that stopped at the project left a caller one round trip per project short of a
link. `EnvironmentSummaryResource` is the new schema those rows use.

`GET /environments/{environmentId}/end-users` now accepts `offset` beside its
opaque `cursor`, and refuses the two together. The collection already published
`total`, and a collection that tells a caller how many rows exist has committed
to random access; its cursor was `base64url({"offset":N})` and nothing else. The
offset is the one spelling a caller can construct, which is what a page-numbered
client needs.

Both are additive: `openapi-compat` classifies all four document changes
COMPATIBLE. Publication stays forbidden from this repository.
