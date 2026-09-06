import json
import os

SRC = "packages/adapters/postgres-tenancy/src/"

ROWS = ["src/files-rows.test.ts"]
CONF = ["src/files-conformance.integration.test.ts"]
CONS = ["src/files-constraints.integration.test.ts"]
RULES = ["src/files-rules.integration.test.ts"]
SCOPE = ["src/files-scope.integration.test.ts"]
TXN = ["src/files-transaction.integration.test.ts"]
STMT = ["src/files-statements.integration.test.ts"]

G = "src/files-guards.ts"
A = "src/files-ancestry.ts"
R = "src/files-rows.ts"
AT = "src/files-attachments.ts"
AR = "src/files-artifacts.ts"
E = "src/files-erasure.ts"
RF = "src/files-refusal.ts"

M = []


def add(name, file, frm, to, note, suites):
    M.append(
        {
            "name": name,
            "file": file,
            "from": frm,
            "to": to,
            "note": note,
            "suites": suites,
        }
    )


# --------------------------------------------------------------- files-guards
add("M-F01 guards: an identifier bound for @db.Uuid is validated", G,
    "  if (!looksLikeUuid(value)) {",
    "  if (false) {",
    "Every id this store writes is a `@db.Uuid` column and every one arrives as a branded string. The context's own `SequenceIdGenerator` mints `id-0001` and `testThreadScope` mints `org-1`; both satisfy the double and both reach the driver as a parameter error naming no column.",
    SCOPE + CONS)

add("M-F02 guards: the NULLABLE half of the uuid check is not a no-op", G,
    "  if (value !== null) requireUuid(field, value);",
    "  if (false) requireUuid(field, value);",
    "`MessageAttachment.turnId` is the one nullable uuid this store writes, and a binding is the value a caller supplies rather than one this store derives.",
    SCOPE)

add("M-F03 guards: an Invalid Date is refused before the driver sees NaN", G,
    "  if (Number.isNaN(value.getTime())) {",
    "  if (false) {",
    "An `Invalid Date` reaches the driver as `NaN` and is reported as a parameter error with no column named. Refusing here names the column.",
    CONS)

add("M-F04 guards: the NULLABLE half of the instant check is not a passthrough", G,
    "  return value === null ? null : requireInstant(field, value);",
    "  return value;",
    "`expiresAt` is nullable and is the column the retention sweep orders on. A null means retained indefinitely; an Invalid Date means nothing at all.",
    SCOPE)

add("M-F05 guards: a value bound for an INTEGER column is range-checked", G,
    "  if (!Number.isInteger(value) || value < minimum || value > INT32_MAX) {",
    "  if (false) {",
    "`bytes`, `width`, `height`, `durationSec` and `revision` are 32-bit signed on PostgreSQL and plain 64-bit floats in the domain. A 3 GB upload is a value the double stores and the column refuses.",
    CONS)

add("M-F06 guards: the FLOOR of the integer range is checked, not only the ceiling", G,
    "value < minimum || value > INT32_MAX",
    "value > INT32_MAX",
    "The floor is the half with no CHECK behind it: `bytes` has none, so a negative row is representable and is headroom a tenant did not buy; `revision` has none, so a zero makes `latest + 1` collide with the first revision.",
    CONS)

add("M-F07 guards: the NULLABLE half of the integer check is not a passthrough", G,
    "  return value === null ? null : requireInt32(field, value, minimum);",
    "  return value;",
    "The three media measurements are nullable and are the columns a caller supplies from a decoder it does not control.",
    CONS)

add("M-F08 guards: a value bound for a jsonb_typeof = 'object' column is checked", G,
    '  if (typeof value !== "object" || value === null || Array.isArray(value)) {',
    "  if (false) {",
    "`Artifact_metadata_json_root` is a real CHECK, so an array reaches the database and aborts the whole transaction rather than the statement.",
    CONS)

add("M-F09 guards: a TEXT value carrying U+0000 is refused", G,
    "  if (value.includes(NUL)) {",
    "  if (false) {",
    "`U+0000` is the one character a `text` value may not contain: the wire format is NUL-terminated, so the driver reports an encoding error naming no column.",
    CONS)

add("M-F10 guards: the NULLABLE half of the text check is not a passthrough", G,
    "  return value === null ? null : requireStorableText(field, value);",
    "  return value;",
    "`originalName` comes straight off an upload and is nullable — the most exposed of this table's free-form columns and the only one an operator names.",
    CONS)

add("M-F11 guards: an empty Artifact.createdBy is refused", G,
    "  if (value.length === 0) {",
    "  if (false) {",
    "`createdBy` is a plain TEXT with no CHECK and it is what `deleteArtifactRevisionsForSubject` matches on. An empty principal is a row a LATER erasure of a different empty principal would destroy.",
    CONS)

add("M-F12 guards: requireScopeShape checks the ORGANIZATION id", G,
    '  requireUuid("scope.organizationId", scope.organizationId);\n  requireUuid("scope.projectId", scope.projectId);',
    '  requireUuid("scope.projectId", scope.projectId);',
    "Three ids, three columns, three separate ways to be wrong. A single case with one bad id proves one of them and leaves the other two unfalsified.",
    SCOPE)

add("M-F13 guards: requireScopeShape checks the PROJECT id", G,
    '  requireUuid("scope.projectId", scope.projectId);\n  requireUuid("scope.environmentId", scope.environmentId);',
    '  requireUuid("scope.environmentId", scope.environmentId);',
    "The middle id of the three, and the one the context's own fixture spells `proj-1`.",
    SCOPE)

add("M-F14 guards: requireScopeShape checks the ENVIRONMENT id", G,
    '  requireUuid("scope.environmentId", scope.environmentId);\n}',
    '  requireUuid("scope.organizationId", scope.organizationId);\n}',
    "The id both tables actually store. The mutation re-checks the organization instead, so the function still refuses SOMETHING — which is what makes this a test of the field rather than of the presence of a guard.",
    SCOPE)

add("M-F15 guards: requireTenantScopeShape checks the organization at every level", G,
    '  requireUuid("selector.scope.organizationId", scope.organizationId);',
    "  void scope.organizationId;",
    "An erasure may be addressed at an organization, a project or an environment, and the organization id is the one every level carries.",
    SCOPE)

add("M-F16 guards: the ORGANIZATION level stops before the project id", G,
    '  if (scope.level === "organization") return;',
    "  if (true) return;",
    "An organization-level selector has no `projectId` to check, and a guard that read one would be reading a field the union does not carry. Mutating it to always return leaves a project-level selector unchecked.",
    SCOPE)

add("M-F17 guards: the PROJECT level stops before the environment id", G,
    '  if (scope.level === "project") return;',
    "  if (true) return;",
    "The third id is only reachable from an environment-level selector, which is the narrowest an erasure can be.",
    SCOPE)

add("M-F18 guards: the uuid pattern is ANCHORED at both ends", G,
    "const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;",
    "const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;",
    "Without the anchors a string that merely CONTAINS a uuid passes the shape guard and reaches the statement as a `::uuid` cast, which fails in the driver naming no column — the failure the guard exists to replace.",
    SCOPE)

# ------------------------------------------------------------- files-ancestry
add("M-F19 ancestry: an environment that does not exist is its own refusal", A,
    "  if (resolved === undefined) {",
    "  if (false) {",
    "A deleted tenant and a caller lying about one are different operational events. Collapsing them makes a tenant deletion look like an attack.",
    RULES)

add("M-F20 ancestry: the claimed PROJECT is compared with the stored one", A,
    "  if (resolved.projectId !== scope.projectId || resolved.organizationId !== scope.organizationId) {",
    "  if (resolved.organizationId !== scope.organizationId) {",
    "No database rule checks the caller's claim about which project an environment sits under, and `threadPath()` — what every scoped read compares on and what the object-store prefix is derived from — carries it.",
    RULES)

add("M-F21 ancestry: the claimed ORGANIZATION is compared with the stored one", A,
    "  if (resolved.projectId !== scope.projectId || resolved.organizationId !== scope.organizationId) {",
    "  if (resolved.projectId !== scope.projectId) {",
    "The same rule one level up, and the level that decides which TENANT a blob's key names.",
    RULES)

# ----------------------------------------------------------------- files-rows
add("M-F22 rows: an unresolved ancestry is REFUSED, not guessed", R,
    "  if (ancestry.projectId === null || ancestry.organizationId === null) {",
    "  if (false) {",
    "Both tables store `environmentId` and nothing above it. The reads use an outer join, so the row type is honest about the null and the mapper has to answer the question rather than inherit an assumption.",
    ROWS)

add("M-F23 rows: a measurement column is validated on READ, not cast", R,
    "  if (!Number.isInteger(value) || value < 0) {",
    "  if (false) {",
    "`bytes` carries no CHECK, so a negative row is a row an OLDER BINARY could have written and is representable today. It is summed into an organization's quota.",
    ROWS + CONS)

add("M-F24 rows: a NULL measurement is absent rather than zero", R,
    "  if (value === null) return ok(null);",
    "  if (false) return ok(null);",
    "The three media columns are nullable, and `AttachmentMedia` distinguishes absent from zero. Reading a missing width as `0` would make a document look like an image with no pixels.",
    ROWS)

add("M-F25 rows: Artifact.revision is validated on READ", R,
    "  if (!Number.isInteger(row.revision) || row.revision < 1) {",
    "  if (false) {",
    "`nextRevisionNumber` answers `latest + 1`, so a stored `0` makes the next write target `1` — where the first revision already is, and the append-only unique would refuse a write that is correct.",
    ROWS + CONS)

add("M-F26 rows: the summed bytes are checked against the 53-bit ceiling", R,
    "  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < 0n) {",
    "  if (false) {",
    "`sum(integer)` is `bigint` and the port answers a `number`. Below 2^53 the conversion is exact and above it is silently not, and a quota decision taken on a rounded total is taken on a number nobody wrote.",
    ROWS)

add("M-F27 rows: a NEGATIVE total is refused as well as an oversized one", R,
    "  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < 0n) {",
    "  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {",
    "No set of non-negative rows sums below zero, so a negative total is evidence that a row this binary would refuse is already stored — the one signal the quota read has that the row-level guard cannot give it.",
    ROWS + CONS)

add("M-F28 rows: the binding union is rebuilt from the column", R,
    '    binding: row.turnId === null ? PENDING_BINDING : boundTo(asIdentifier<TurnId>(row.turnId)),',
    "    binding: PENDING_BINDING,",
    "`turnId` is nullable and the two states have different rules, so `domain/attachment.ts` models them as a union. A store that always answered `pending` would make every bound attachment re-bindable.",
    ROWS + CONF)

# ----------------------------------------------------------- files-attachments
add("M-F29 findAttachment: the THREAD clause", AT,
    '           WHERE attachment."id" = $1::uuid\n             AND attachment."threadId" = $2::uuid\n             AND attachment."environmentId" = $3::uuid',
    '           WHERE attachment."id" = $1::uuid\n             AND $2::uuid IS NOT NULL\n             AND attachment."environmentId" = $3::uuid',
    "A sibling thread of the same environment is the case that isolates it: every other id is correct, so nothing else in the tree can produce the miss.",
    SCOPE)

add("M-F30 findAttachment: the ENVIRONMENT clause", AT,
    '             AND attachment."environmentId" = $3::uuid\n             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid`,\n          attachmentId,',
    '             AND $3::uuid IS NOT NULL\n             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid`,\n          attachmentId,',
    "The tenant boundary the port's own comment calls out: an implementation MUST return `null`, not a row from another environment, when the id exists elsewhere.",
    SCOPE)

add("M-F31 findAttachment: the PROJECT clause", AT,
    '             AND attachment."environmentId" = $3::uuid\n             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid`,\n          attachmentId,',
    '             AND attachment."environmentId" = $3::uuid\n             AND $4::uuid IS NOT NULL\n             AND project."organizationId" = $5::uuid`,\n          attachmentId,',
    "The environment clause alone would answer a caller holding a forged project the row it asked for, and `threadPath()` — the object-store prefix — carries the project.",
    SCOPE)

add("M-F32 findAttachment: the ORGANIZATION clause", AT,
    '             AND attachment."environmentId" = $3::uuid\n             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid`,\n          attachmentId,',
    '             AND attachment."environmentId" = $3::uuid\n             AND environment."projectId" = $4::uuid\n             AND $5::uuid IS NOT NULL`,\n          attachmentId,',
    "The outermost of the four, and the one whose absence a cross-tenant test with every id wrong could never see.",
    SCOPE)

add("M-F33 findAttachmentsInScope: an empty list costs no statement", AT,
    "        if (attachmentIds.length === 0) return ok([]);",
    "        if (false) return ok([]);",
    "`= ANY('{}')` is a correct query that returns nothing, and sending it would make a no-op read cost a round trip on a path a turn calls before it can do anything.",
    STMT)

add("M-F34 findAttachmentsInScope: the THREAD clause", AT,
    '           WHERE attachment."id" = ANY(string_to_array($1, \',\')::uuid[])\n             AND attachment."threadId" = $2::uuid',
    '           WHERE attachment."id" = ANY(string_to_array($1, \',\')::uuid[])\n             AND $2::uuid IS NOT NULL',
    "The port's comment says an id the boundary does not cover is simply ABSENT from the result, so the caller can compare counts and fail closed. A missing clause makes a partial answer look complete.",
    SCOPE)

add("M-F35 findAttachmentsInScope: the ORGANIZATION clause", AT,
    '             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid\n           ORDER BY attachment."createdAt" ASC, attachment."id" ASC`,\n          attachmentIds.join(","),',
    '             AND environment."projectId" = $4::uuid\n             AND $5::uuid IS NOT NULL\n           ORDER BY attachment."createdAt" ASC, attachment."id" ASC`,\n          attachmentIds.join(","),',
    "The batch read is the one a turn uses to resolve every attachment it was handed, so a leak here is a leak on the busiest path in the context.",
    SCOPE)

add("M-F36 dedupe probe: the ENVIRONMENT clause", AT,
    '           WHERE attachment."contentHash" = $1\n             AND attachment."environmentId" = $2::uuid',
    '           WHERE attachment."contentHash" = $1\n             AND $2::uuid IS NOT NULL',
    "The port says the probe is 'scoped to an environment; never wider'. Dedupe is a server-side COPY of a blob, so a probe that crossed a tenant would hand one tenant a pointer at another tenant's bytes.",
    CONF + CONS)

add("M-F37 dedupe probe: the ORGANIZATION clause", AT,
    '             AND environment."projectId" = $3::uuid\n             AND project."organizationId" = $4::uuid\n           ORDER BY attachment."createdAt" ASC, attachment."id" ASC\n           LIMIT 1`,',
    '             AND environment."projectId" = $3::uuid\n             AND $4::uuid IS NOT NULL\n           ORDER BY attachment."createdAt" ASC, attachment."id" ASC\n           LIMIT 1`,',
    "The same leak one level out, reachable only by a caller whose environment is right and whose organization is not.",
    SCOPE)

add("M-F38 dedupe probe: the PROJECT clause", AT,
    '             AND environment."projectId" = $3::uuid\n             AND project."organizationId" = $4::uuid\n           ORDER BY attachment."createdAt" ASC, attachment."id" ASC\n           LIMIT 1`,',
    '             AND $3::uuid IS NOT NULL\n             AND project."organizationId" = $4::uuid\n           ORDER BY attachment."createdAt" ASC, attachment."id" ASC\n           LIMIT 1`,',
    "And one level in from that.",
    SCOPE)

add("M-F39 dedupe probe: the order is DECIDED, not left to the plan", AT,
    '           ORDER BY attachment."createdAt" ASC, attachment."id" ASC\n           LIMIT 1`,',
    '           ORDER BY attachment."createdAt" DESC, attachment."id" DESC\n           LIMIT 1`,',
    "`contentHash` carries no unique index, so several rows may answer the probe and the port's signature is `Attachment | null`. An unordered `LIMIT 1` lets the plan decide: two calls, two answers, and a dedupe that copies a different blob each time.",
    CONS)

add("M-F40 sumAttachmentBytes: the ORGANIZATION clause", AT,
    '          WHERE project."organizationId" = ${scope.organizationId}::uuid`;',
    '          WHERE project."organizationId" IS NOT NULL AND ${scope.organizationId}::uuid IS NOT NULL`;',
    "This sum is an organization's quota input. Without the clause every tenant in the installation shares one ceiling.",
    CONF)

add("M-F41 sumAttachmentBytes: COALESCE makes an empty total a number", AT,
    '          SELECT COALESCE(SUM(attachment."bytes"), 0)::bigint AS "total"',
    '          SELECT SUM(attachment."bytes")::bigint AS "total"',
    "`sum()` over no rows is SQL NULL, and a quota input of `null` is not zero — it is a crash one layer up, in a caller that subtracts it from a ceiling.",
    SCOPE)

add("M-F42 listElapsedAttachments: the expiry predicate", AT,
    '           WHERE attachment."expiresAt" <= $1',
    "           WHERE $1 IS NOT NULL",
    "The sweep destroys blobs. A predicate that matched every row would destroy the bytes of every attachment in the installation on its first pass.",
    CONF)

add("M-F43 listElapsedAttachments: the caller's LIMIT is the limit", AT,
    "           LIMIT $2::int`,",
    "           LIMIT 1000`,",
    "The sweep is a batch job whose batch size is the caller's to choose; a store that chose its own would make a bounded pass unbounded.",
    CONF)

add("M-F44 listElapsedAttachments: a zero limit costs no statement", AT,
    "        if (limit === 0) return ok([]);",
    "        if (false) return ok([]);",
    "The same argument the empty id list carries, on the other read that can be asked for nothing.",
    STMT)

add("M-F45 updateAttachmentBinding: the OWNER is in the WHERE", AT,
    "          where: {\n            id: attachment.attachmentId,\n            environmentId: scope.environment.environmentId,\n            endUserId: scope.owner.endUserId,",
    "          where: {\n            id: attachment.attachmentId,\n            environmentId: scope.environment.environmentId,",
    "The port hands the store a WHOLE `Attachment`, so a caller that mutated the owner is asking for a row move `MessageAttachment_owner_immutable` refuses. Writing only the binding would drop the move silently and report success.",
    RULES)

add("M-F46 updateAttachmentBinding: a zero row count is NOT FOUND", AT,
    "        if (changed.count === 0) return err(attachmentNotFound(attachment.attachmentId));",
    "        if (false) return err(attachmentNotFound(attachment.attachmentId));",
    "`InMemoryFilesRepository.updateAttachmentBinding` is `Map.set`, so on that side an update of an absent row CREATES it and answers ok — an upsert wearing an update's name. This is the guard that makes the real store disagree.",
    RULES)

add("M-F47 updateAttachmentBinding: the binding is what the update WRITES", AT,
    "          data: { turnId: attachmentTurnId(attachment), expiresAt: attachment.expiresAt },",
    "          data: { expiresAt: attachment.expiresAt },",
    "Binding an attachment to the turn that used it is the whole purpose of the method; an update that moved only the expiry would leave every attachment pending for ever.",
    CONF)

add("M-F48 deleteAttachment: the ancestry is re-asserted BEFORE the row goes", AT,
    "        await requireAncestry(transactions.writer(transaction), scope.environment);\n        const removed = await transactions.writer(transaction).messageAttachment.deleteMany({",
    "        const removed = await transactions.writer(transaction).messageAttachment.deleteMany({",
    "`MessageAttachment` holds no project or organization column and the delegate API cannot filter a delete through a relation, so this statement is the only thing standing between a forged scope and a destroyed row.",
    RULES)

add("M-F49 deleteAttachment: the THREAD clause", AT,
    "          where: { id: attachmentId, threadId: scope.threadId, environmentId: scope.environment.environmentId },",
    "          where: { id: attachmentId, environmentId: scope.environment.environmentId },",
    "A delete addressed at a sibling thread of the right environment must remove nothing; the ancestry re-assertion passes for that scope, so the clause is the only thing that can refuse it.",
    SCOPE)

add("M-F50 insertAttachment: the ancestry is re-asserted BEFORE the row is written", AT,
    "        await requireAncestry(transactions.writer(transaction), scope.environment);\n        await transactions.writer(transaction).messageAttachment.create({",
    "        await transactions.writer(transaction).messageAttachment.create({",
    "A row written under a forged claim reads back under the TRUE ancestry, so the write succeeds and every subsequent read addressed the way it was written answers null: an attachment nobody can reach, whose blob nothing points at.",
    RULES)

add("M-F51 insertAttachment: an existing binding is written, not dropped", AT,
    "            turnId: attachmentTurnId(attachment),",
    "            turnId: null,",
    "`MessageAttachment_binding_one_way` only refuses a CHANGE, so an insert that dropped the binding would make an attachment created bound look unbound — and the unbind the database refuses would then succeed.",
    RULES)

# ------------------------------------------------------------- files-artifacts
add("M-F52 findLatestArtifactRevision: newest is by REVISION, not by clock", AR,
    '           ORDER BY artifact."revision" DESC',
    '           ORDER BY artifact."revision" ASC',
    "Two revisions written in the same millisecond TIE on `timestamp(3)`. The newest revision is a fact about the number the append-only rule counts, not about a clock.",
    CONF)

add("M-F53 findLatestArtifactRevision: the ARTIFACT KEY clause", AR,
    '           WHERE artifact."threadId" = $1::uuid\n             AND artifact."artifactKey" = $2\n             AND artifact."environmentId" = $3::uuid\n             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid\n           ORDER BY artifact."revision" DESC',
    '           WHERE artifact."threadId" = $1::uuid\n             AND $2 IS NOT NULL\n             AND artifact."environmentId" = $3::uuid\n             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid\n           ORDER BY artifact."revision" DESC',
    "One logical artifact is the set of rows sharing `(threadId, artifactKey)`. Without the key clause a thread with two artifacts answers every read with whichever has the higher revision.",
    CONS)

add("M-F54 findLatestArtifactRevision: the THREAD clause", AR,
    '           WHERE artifact."threadId" = $1::uuid\n             AND artifact."artifactKey" = $2\n             AND artifact."environmentId" = $3::uuid\n             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid\n           ORDER BY artifact."revision" DESC',
    '           WHERE $1::uuid IS NOT NULL\n             AND artifact."artifactKey" = $2\n             AND artifact."environmentId" = $3::uuid\n             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid\n           ORDER BY artifact."revision" DESC',
    "Two tenants may hold the same key in two threads, and the differential seeds exactly that: revision 1 in one, revision 2 in the other.",
    CONF)

add("M-F55 findLatestArtifactRevision: the PROJECT clause", AR,
    '             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid\n           ORDER BY artifact."revision" DESC',
    '             AND $4::uuid IS NOT NULL\n             AND project."organizationId" = $5::uuid\n           ORDER BY artifact."revision" DESC',
    "An artifact's content is inline in the row, so a scope leak here is a leak of the document itself rather than of a pointer.",
    SCOPE)

add("M-F56 findLatestArtifactRevision: the ORGANIZATION clause", AR,
    '             AND environment."projectId" = $4::uuid\n             AND project."organizationId" = $5::uuid\n           ORDER BY artifact."revision" DESC',
    '             AND environment."projectId" = $4::uuid\n             AND $5::uuid IS NOT NULL\n           ORDER BY artifact."revision" DESC',
    "The outermost clause on the read that returns a whole document.",
    SCOPE)

add("M-F57 findArtifactRevision: the REVISION clause", AR,
    '             AND artifact."revision" = $3::int',
    "             AND $3::int IS NOT NULL",
    "`selectRevision` in the domain says a request for a revision that does not exist FAILS and never falls back to the latest: returning newer content to a caller who asked for revision 3 is how a cached render silently becomes wrong.",
    CONF)

add("M-F58 findArtifactRevision: the THREAD clause", AR,
    '           WHERE artifact."threadId" = $1::uuid\n             AND artifact."artifactKey" = $2\n             AND artifact."revision" = $3::int',
    '           WHERE $1::uuid IS NOT NULL\n             AND artifact."artifactKey" = $2\n             AND artifact."revision" = $3::int',
    "The exact read carries the same boundary the latest read does, and the differential asks it of a thread that holds revision 1 while the tenant's holds revision 2.",
    CONF)

add("M-F59 insertArtifactRevision: the conflict is a ROW COUNT, never an overwrite", AR,
    '          ON CONFLICT ("threadId", "artifactKey", "revision") DO NOTHING',
    '          ON CONFLICT ("threadId", "artifactKey", "revision") DO UPDATE SET "content" = EXCLUDED."content"',
    "The port's comment is explicit: an implementation MUST surface a violation as `FILES_ARTIFACT_REVISION_CONFLICT` and MUST NOT convert the insert into an update. This mutation is that exact forbidden conversion.",
    CONF + TXN)

add("M-F60 insertArtifactRevision: zero rows returned IS the conflict", AR,
    "        if (written.length === 0) {",
    "        if (false) {",
    "The statement has no WHERE, so zero rows can only mean the slot was taken. Without the check the caller is told the revision was appended when it was not.",
    CONF)

add("M-F61 insertArtifactRevision: the ancestry is re-asserted", AR,
    "        await requireAncestry(writer, scope.environment);",
    "        void writer;",
    "`Artifact_ancestry` checks the thread against the row's environment and says nothing about the two parents the caller claims.",
    RULES)

add("M-F62 insertArtifactRevision: a null metadata is the SQL NULL", AR,
    "        const metadata = revision.metadata === null ? null : JSON.stringify(revision.metadata);",
    "        const metadata = JSON.stringify(revision.metadata);",
    "`JSON.stringify(null)` is the string `'null'`, whose `jsonb_typeof` is `'null'` — refused by `Artifact_metadata_json_root`, whose first clause looks like it should have allowed it. This is the two-nulls trap `client.ts` records, reached through a text parameter instead of a client sentinel.",
    CONS)

add("M-F63 insertArtifactRevision: metadata is shape-checked before the statement", AR,
    '        if (revision.metadata !== null) requireJsonObject("Artifact.metadata", revision.metadata);',
    '        if (false) requireJsonObject("Artifact.metadata", revision.metadata);',
    "A violated CHECK aborts the whole transaction, not the statement, so a caller that appended a revision and then wrote an outbox row would meet 25P02 rather than its own refusal.",
    CONS)

# --------------------------------------------------------------- files-erasure
add("M-F64 erasure: a subject this context holds no column for costs no statement", E,
    "        if (selector.endUserId === null) return ok(0);",
    "        if (false) return ok(0);",
    "`MessageAttachment.endUserId` matches only an end-user subject. An `entity` subject has zero rows here, and asking the database a question with a known answer is a round trip per erasure operation across the installation.",
    CONF + STMT)

add("M-F65 erasure: the count matches on the SUBJECT column", E,
    '           WHERE attachment."endUserId" = $1::uuid\n             AND project."organizationId" = $2::uuid\n             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)\n             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)`,\n          selector.endUserId,',
    '           WHERE $1::uuid IS NOT NULL\n             AND project."organizationId" = $2::uuid\n             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)\n             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)`,\n          selector.endUserId,',
    "This count is the ROW COUNT in an erasure PLAN. A plan that over-counts promises destruction of rows belonging to somebody else.",
    SCOPE)

add("M-F66 erasure: the count is contained by the ORGANIZATION", E,
    '           WHERE attachment."endUserId" = $1::uuid\n             AND project."organizationId" = $2::uuid\n             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)\n             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)`,\n          selector.endUserId,',
    '           WHERE attachment."endUserId" = $1::uuid\n             AND $2::uuid IS NOT NULL\n             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)\n             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)`,\n          selector.endUserId,',
    "The selector is resolved by CONTAINMENT rather than by equality, and the organization is the level every erasure carries.",
    CONF)

add("M-F67 erasure: the PROJECT clause turns itself off rather than being absent", E,
    '           WHERE attachment."endUserId" = $1::uuid\n             AND project."organizationId" = $2::uuid\n             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)\n             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)`,\n          selector.endUserId,',
    '           WHERE attachment."endUserId" = $1::uuid\n             AND project."organizationId" = $2::uuid\n             AND ($3::uuid IS NULL OR $3::uuid IS NOT NULL)\n             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)`,\n          selector.endUserId,',
    "One statement for all three levels is what keeps the measured statement count of an organization-wide erasure equal to an environment-wide one — but only if the narrower clauses actually narrow.",
    SCOPE)

add("M-F68 erasure: the ENVIRONMENT clause turns itself off rather than being absent", E,
    '           WHERE attachment."endUserId" = $1::uuid\n             AND project."organizationId" = $2::uuid\n             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)\n             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)`,\n          selector.endUserId,',
    '           WHERE attachment."endUserId" = $1::uuid\n             AND project."organizationId" = $2::uuid\n             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)\n             AND ($4::uuid IS NULL OR $4::uuid IS NOT NULL)`,\n          selector.endUserId,',
    "The narrowest level, and the one a tenant with a single environment cannot falsify — which is why the harness seeds a second one that holds nothing.",
    SCOPE)

add("M-F69 erasure: a principal-less selector costs no statement", E,
    "        if (selector.principalId === null) return ok(0);\n        requirePrincipal(\"selector.principalId\", selector.principalId);\n        const bindings = scopeBindings(selector);\n        const rows = await transactions.reader().$queryRawUnsafe<",
    "        if (false) return ok(0);\n        requirePrincipal(\"selector.principalId\", selector.principalId);\n        const bindings = scopeBindings(selector);\n        const rows = await transactions.reader().$queryRawUnsafe<",
    "`Artifact.createdBy` matches an operator user as well as an end user, and an `entity` subject matches neither.",
    CONF)

add("M-F70 erasure: the artifact count matches on the AUTHOR", E,
    '           WHERE artifact."createdBy" = $1',
    "           WHERE $1 IS NOT NULL",
    "The count is the plan's row count for `Artifact`, and every revision in the thread shares the thread.",
    SCOPE)

add("M-F71 erasure: the listing matches on the SUBJECT column", E,
    '           WHERE attachment."endUserId" = $1::uuid\n             AND project."organizationId" = $2::uuid\n             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)\n             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)\n           ORDER BY attachment."createdAt" ASC, attachment."id" ASC`,',
    '           WHERE $1::uuid IS NOT NULL\n             AND project."organizationId" = $2::uuid\n             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)\n             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)\n           ORDER BY attachment."createdAt" ASC, attachment."id" ASC`,',
    "This listing is what the erasure target walks, destroying each row's BLOB. A row that does not belong to the subject has its bytes destroyed by an erasure of somebody else.",
    SCOPE)

add("M-F72 erasure: a subject-less listing is empty without a statement", E,
    "        if (selector.endUserId === null) return ok([]);",
    "        if (false) return ok([]);",
    "The listing's half of the same decision the count makes.",
    CONF)

add("M-F73 erasure: the DELETE is contained by the organization", E,
    '             AND artifact."createdBy" = $1\n             AND project."organizationId" = $2::uuid',
    '             AND artifact."createdBy" = $1\n             AND $2::uuid IS NOT NULL',
    "This is the only statement in the context that destroys artifact rows. Without the containment clause an erasure addressed at one tenant destroys the same author's documents in every tenant.",
    CONF)

add("M-F74 erasure: the DELETE matches on the AUTHOR", E,
    '             AND artifact."createdBy" = $1\n             AND project."organizationId" = $2::uuid',
    '             AND $1 IS NOT NULL\n             AND project."organizationId" = $2::uuid',
    "Without it an erasure of one person destroys every artifact in the organization.",
    SCOPE)

add("M-F75 erasure: a principal-less DELETE destroys nothing", E,
    "        if (selector.principalId === null) return ok(0);\n        requirePrincipal(\"selector.principalId\", selector.principalId);\n        const bindings = scopeBindings(selector);\n        const removed = await transactions.writer(transaction).$executeRawUnsafe(",
    "        if (false) return ok(0);\n        requirePrincipal(\"selector.principalId\", selector.principalId);\n        const bindings = scopeBindings(selector);\n        const removed = await transactions.writer(transaction).$executeRawUnsafe(",
    "An `entity` subject matches no column here, and a DELETE issued for one would have `createdBy = NULL` — which matches nothing today and is a statement nobody meant to send.",
    CONF)

add("M-F76 erasure: scopeBindings carries the PROJECT only below the organization level", E,
    '    projectId: scope.level === "organization" ? null : scope.projectId,',
    "    projectId: null,",
    "The parameter is what turns the project clause off. A binding that always answered null would make every selector organization-wide whatever level it named.",
    SCOPE)

add("M-F77 erasure: scopeBindings carries the ENVIRONMENT only at the environment level", E,
    '    environmentId: scope.level === "environment" ? scope.environmentId : null,',
    "    environmentId: null,",
    "The same, one level in.",
    SCOPE)

# --------------------------------------------------------------- files-refusal
add("M-F78 refusal: a refused write becomes a Result rather than a throw", RF,
    "    if (error instanceof FilesWriteRefused || isDriverError(error)) {",
    "    if (false) {",
    "The port says every method returns `Result` and that a rejected promise is a defect, not an outcome. Without this the whole guard layer rejects instead of answering.",
    CONS)

add("M-F79 refusal: a driver error is an outcome, and a guard refusal is not the only one", RF,
    '  return error instanceof Error && error.name.startsWith("PrismaClient");',
    "  return false;",
    "The rules the migrations carry — every ancestry trigger, the one-way binding, the primary key — arrive as driver errors and nothing else. Without this half they reject the promise and no caller can act on them.",
    RULES)

add("M-F80 refusal: a TransactionScopeError is RETHROWN, never folded into a Result", RF,
    "    throw error;",
    "    return err(repositoryUnavailable(reasonOf(error, label)));",
    "The three scope refusals carry three distinct codes so three mistakes stay distinguishable. Converting them here would let a use case that lost its transaction carry on as though a row had merely failed to write.",
    TXN)

# ---------------------------------------------------------------------- verify
problems = []
seen = set()
for entry in M:
    if entry["name"] in seen:
        problems.append(f'duplicate name {entry["name"]}')
    seen.add(entry["name"])
    path = os.path.join("packages/adapters/postgres-tenancy", entry["file"])
    text = open(path, encoding="utf-8").read()
    count = text.count(entry["from"])
    if count != 1:
        problems.append(f'{entry["name"]}: `from` occurs {count} times in {entry["file"]}')
    if entry["from"] == entry["to"]:
        problems.append(f'{entry["name"]}: from == to')

if problems:
    print("PROBLEMS")
    for problem in problems:
        print(" -", problem)
else:
    print(f"OK {len(M)} entries, every anchor unique")

open("/tmp/pl-t5-entries.json", "w", encoding="utf-8").write(json.dumps(M, indent=2))
