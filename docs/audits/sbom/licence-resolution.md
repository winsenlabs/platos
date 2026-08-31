# WIN-252 licence provenance resolution gate

**Status: OPEN — HUMAN/LEGAL DECISION REQUIRED**

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

An authorized human/legal reviewer must decide whether the imported core MIT copyright and permission
notice must be retained alongside current Apache-2.0 materials, what notice/licence/metadata treatment
that requires, and whether the private non-shipping OTLP importer needs treatment beyond preserving its
current inherited MIT files. Until then, automation must not declare the package MIT metadata erroneous,
classify it as rename residue, close the legal item, or infer an answer from the root Apache-2.0 licence.
