# WIN-252 licence provenance resolution gate

**Status: DECIDED BY OWNER — 2026-09-01**

The canonical, machine-readable, offline provenance record is
[`licence-resolution.json`](./licence-resolution.json). Its strict versioned receipt contains the
commit-pinned Trigger.dev source objects, exact import comparison, current protected package states,
and checked shipping-SBOM absence. The focused licence test validates locally available Git evidence
and vendored artifacts without network access.

The `v4.4.4` to `5ea36e08f25728ff2a75a31dfd82f4fe9c981002` mapping is an externally
reviewed point-in-time fact. The receipt preserves a bounded
[ref observation](./provenance/trigger-dev-v4.4.4-ref.json) and immutable commit URLs, but does not
claim to verify the live tag mapping offline. Published npm evidence is preserved as the exact
[`@trigger.dev/core@4.4.4` tarball](./provenance/trigger-dev-core-4.4.4.tgz) and a bounded
[registry metadata snapshot](./provenance/trigger-dev-core-4.4.4.registry.json).

The evidence establishes distinct upstream facts at the same revision: the root `LICENSE` is
Apache-2.0, while the public core package and private OTLP importer declare MIT and carry package-level
MIT text. The Platos import has 258 paths in common with upstream core, with 250 identical blob/mode
pairs, but no merge base is preserved and later source commits share the relevant core tree. The
evidence therefore does not prove which physical checkout produced the import.

The current public `@platos/core` manifest and package `LICENSE` are Apache-2.0. The current private,
non-shipping `@platos/otlp-importer` retains inherited MIT metadata and exact MIT bytes. These are
provenance and shipping-closure facts, not a legal conclusion.

## Owner decision — 2026-09-01

The repository owner has decided, and the decision is applied:

**Platos continues to distribute `@platos/core` under Apache-2.0, and the upstream MIT copyright and
permission notice is additionally retained verbatim in `packages/core/NOTICE`** under an explicit
`UPSTREAM ATTRIBUTION` heading. `NOTICE` is listed in the package's `files`, so it ships in the
published tarball.

The two halves are not in tension. MIT grants the right to sublicense, so the Apache-2.0 election for
the derivative stands on its own merits and is unchanged. Retaining the upstream notice independently
satisfies MIT's requirement that the copyright *and permission* notice accompany copies and substantial
portions. Doing both means the question does not have to be adjudicated in the abstract — it is moot
under either reading — and it costs nothing.

**Why `NOTICE` and not `LICENSE`.** Every publishable first-party package must ship a `LICENSE` that is
byte-identical to the repository Apache-2.0 text; `license-distribution` enforces this, and it is the
reason the package licence was normalised to Apache-2.0 in the first place. Appending to `LICENSE` would
have broken that invariant. `NOTICE` is the Apache-2.0 §4(d) mechanism for exactly this purpose, is
already part of the repository's legal-distribution contract (`LEGAL_FILES = ["LICENSE", "NOTICE"]`), and
is verified into every shipped image. So the attribution is satisfied with **no** relaxation of any
existing guard.

The retained notice text was **extracted verbatim** from the offline-verifiable published artifact
[`trigger-dev-core-4.4.4.tgz`](./provenance/trigger-dev-core-4.4.4.tgz) (member `package/LICENSE`,
tarball sha1 `9544b5ded8dd8deb2371081389961792bccfde4e`), not transcribed. The notice states explicitly
that it applies to the upstream-derived portions and does not alter the Apache-2.0 grant.

**`@platos/otlp-importer`: no change.** It is private, retains inherited upstream MIT metadata and exact
MIT bytes, and is absent from every recorded shipping SBOM. No attribution gap arises from a package
that is not distributed.

This is the owner's applied decision and the record of the facts supporting it. It is not legal advice.
The machine-readable form is `legalDecision` in
[`licence-resolution.json`](./licence-resolution.json) (`status: DECIDED_BY_OWNER`, `decided: true`).
