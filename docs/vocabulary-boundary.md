# Platos vocabulary boundary gate

WIN-144 separates Platos-owned language from the external Trigger durable-runtime
service. This prerequisite does not rename production identifiers. It records
reviewed contextual fingerprints so later M5 changes remove exceptions one
occurrence at a time without making unrelated line shifts fail the gate.

The machine-readable manifest is
[`vocabulary-boundary-exceptions.json`](./vocabulary-boundary-exceptions.json).
The gate discovers every tracked or newly added non-ignored file through
`git ls-files`, decodes textual files, and scans both content and repository
paths. It does not rely on selected roots, extensions, or directory suppression.
Binary files are detected from their bytes. The only content exclusions are
exact paths for generated or vendor-owned artifacts, with owner, rationale,
removal policy, and removal event.

Each exception records:

- an exact repository path, rule, and case-sensitive matched text;
- a SHA-256 digest of a bounded local character window: up to 64 characters
  before and after the occurrence, with the occurrence replaced by a marker;
- a semantic context kind and digest, selected deterministically from the
  repository path, complete Markdown heading breadcrumb, full JSON/YAML path,
  complete enclosing source scope chain, or same-block neighboring lines;
- JSON and YAML array objects use stable named identities such as `id`, `name`,
  `key`, `slug`, `title`, `type`, or `provider` instead of inheriting a repeated
  child key or relying on its source line;
- source chains include every detected module, namespace, function, class, and
  method, so same-named methods in different classes are independent;
- line and column values for diagnostics only; they do not participate in
  matching;
- a classification (`vendor`, `migration-debt`, `technical`, or
  `boundary-spec`), owner, rationale, and removal policy;
- either a concrete removal event, or for migration debt, a tracking issue and
  machine-validated expiry date.

Repeated fingerprints are intentional and are matched one-to-one: one exception
can approve only one finding. Prepending unrelated lines leaves a fingerprint
unchanged. Moving an occurrence to another declaration or document section,
changing its bounded local context, or replacing an external-vendor use with
product-owned language fails both the new finding and the stale exception.
Because local windows are bounded, a nearby edit invalidates only affected
anchors rather than every reviewed occurrence in the file. Identical spellings
can therefore retain separate classifications in the same file.

Before matching the manifest, generation and validation group base fingerprints
and compare their semantic scope instances. A base fingerprint appearing in
distinct same-named scope instances must carry a generated
`collisionContextSha256` stronger anchor. If those instances remain
indistinguishable even with the stronger scope context, the gate fails and
requires a stable named scope or object identity instead of accepting an
ambiguous exception.

## Lifecycle policy

Migration-debt exceptions are owned by WIN-144, WIN-145, or WIN-146 and expire
on **2026-09-15**, the coordinated near-term M5 release deadline. The gate fails
closed after that date. Vendor, technical, and boundary-spec exceptions do not
have calendar waivers; each is bound to the event that removes its exact API,
artifact, syntax, or boundary test.

## Legitimate external names

The manifest preserves context-anchored uses of the external service, including
`@trigger.dev/sdk`, Trigger Cloud/self-hosted API configuration such as
`TRIGGER_API_URL`, project/deploy credentials such as `TRIGGER_SECRET_KEY`,
`TRIGGER_ACCESS_TOKEN`, and `TRIGGER_PROJECT_REF`, and vendor-owned task, run,
session, deployment, waitpoint, and attempt metadata at integration adapters.
These names must not leak into Platos-owned schema, REST, MCP, UI, logs, or
domain identifiers.

`TRIGGER_INTERNAL_SECRET` is not a vendor API name: it authenticates Platos-owned
components and is therefore forbidden. Likewise, `spawn_bgo` and inherited
product nouns remain forbidden while anchored migration-debt occurrences await
the ordered M5 migration.

Run the gate and its mutation tests with:

```sh
pnpm test:vocabulary
pnpm audit:vocabulary
```
