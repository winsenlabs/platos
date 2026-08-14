# Platos tenancy database

This package is the clean-slate Prisma boundary for the Platos tenancy core. It
does not import, migrate, or modify the inherited database schema.

- `prisma/schema.prisma` is the authoritative control-plane schema.
- `prisma/end-user.prisma` generates a restricted data-plane projection with
  no operator or shared-tenancy relation paths.
- `src/end-user.ts` further removes raw SQL and transaction escape hatches from
  the data-plane client surface.
- `prisma/migrations/00000000000000_initial` is the single migration generated
  from an empty PostgreSQL database, followed by tier and parent-chain checks
  that Prisma cannot express in its schema language.

Tests start one isolated PostgreSQL testcontainer and pass its connection URL
directly to Prisma. They do not read the repository `DATABASE_URL`.
