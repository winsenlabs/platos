---
"@platosdev/platools-sdk": patch
---

`currentScope()` and the `PlatosCallContext` field table documented
`organizationId`, `projectId` and `environmentId` as an external vendor's ids.
They are Platos tenancy ids: Platos mints them, owns them and binds every object
to them. The doc comments, and the `currentScope()` example in the package
README that ships in the tarball, now say so. Documentation only; no export, type
or wire field changed.

The Python `platools` package carries the same correction on `current_scope()`,
its module example and its README. It has no npm identity, so its version intent is recorded
here beside its TypeScript twin, as `docs/sdk-v1-migration.md` records for the
two Python SDKs.
