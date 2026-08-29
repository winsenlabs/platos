# SBOM/licence gate non-vacuity

Run:

```sh
pnpm audit:sbom:nonvacuity
```

The committed harness executes four assertions against scratch copies and the
real production-closure walker:

| Case | Mutation | Expected |
|---|---|---|
| A | Current lockfile and policy | pass |
| B | Inject an unapproved GPL-3.0-only package | fail |
| C | Explicitly disposition that injected canary | pass |
| D | Inject a commercial/no-grant package | fail |

This proves both copyleft and commercial/no-grant classes fail closed, while
the explicit disposition mechanism remains testable. The shipping baseline
contains no licence waiver: root release tooling is excluded from the webapp
production install, and the unused Fingerprint and PostHog dependencies were
removed rather than waived.
