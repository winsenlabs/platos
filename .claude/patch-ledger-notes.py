import json

p = "packages/adapters/postgres-tenancy/mutations-governance.json"
d = json.load(open(p))

# The rating entry: the constraint text and the note both change.
for m in d["mutations"]:
    if m["name"].startswith("M-G20"):
        m["name"] = "M-G20 ratings: the CHECK the migration ENDS with is met before a statement is sent"
        m["note"] = (
            "`MessageRating_rating_check` exists only in the migrations, and that file "
            "installs it TWICE: `BETWEEN 1 AND 5` at line 2799, then `IN (-1, 1)` at line "
            "3802 after dropping the first. Let raise, the refusal is still reported — and "
            "PostgreSQL aborts the caller's transaction with it, so a use case that writes a "
            "rating and then anything else loses both."
        )
    if m["name"].startswith("M-G21"):
        m["note"] = (
            "`MessageRating_revision_check CHECK (\"revision\" > 0)` is installed by the same "
            "later block that corrects the rating constraint, on a column that block adds. The "
            "int4 half is the column type and has no CHECK, so the guard covers both."
        )
    if m["name"].startswith("M-G23"):
        m["suites"] = ["src/governance-rules.integration.test.ts"]
        m["note"] = (
            "An erasure that dropped the subject predicate would destroy every rating in the "
            "scope, and the COUNT it returns would still look right — the rows it destroyed are "
            "the rows it counted. The only thing that sees the missing predicate is somebody "
            "ELSE'S vote, which is why the case seeds a second subject."
        )
    if m["name"].startswith("M-G18"):
        m["note"] = (
            "`writer(scope)` is what proves the token a write was handed is the transaction it is "
            "actually inside. `append` is the ONE method here whose transaction parameter is "
            "NULLABLE, so it is the one an implementation could plausibly have resolved through "
            "`reader()` on both branches — and a stale or foreign token would then be accepted."
        )
    if m["name"].startswith("M-G27"):
        m["note"] = (
            "`undefined` does not filter; an explicit `null` matches only the SHARED criteria. The "
            "two are told apart by `\"agentId\" in query`, and the difference is only reachable "
            "when the KEY IS PRESENT and the value is undefined — a third case the port's "
            "`agentId?: AgentId | null` permits and the double already handles."
        )

# Two new entries covering the corrected rating constraint from the other side.
d["mutations"].append(
    {
        "name": "M-G46 ratings: BOTH thumbs are storable, and the guard says which",
        "file": "src/governance-guards.ts",
        "from": "  if (value !== 1 && value !== -1) {",
        "to": "  if (value !== 1 && value !== -1 && value !== 3) {",
        "note": "The inverse of M-G20: a guard WIDENED past the constraint the migration ends with lets a five-star value reach the column, where the CHECK raises and takes the caller's transaction. The refusal has to be exactly `IN (-1, 1)` — neither narrower nor wider.",
        "suites": ["src/governance-constraints.integration.test.ts"],
        "kills": [],
    }
)

purpose = d["purpose"]
for i, line in enumerate(purpose):
    if line.startswith("AND ONE GUARD REFUSES A VALUE THE DOMAIN"):
        purpose[i] = "AND ONE COLUMN'S CONSTRAINT IS INSTALLED TWICE IN ONE FILE."
        break
d["purpose"] = purpose[: i + 1] + [
    "`00000000000000_initial/migration.sql` installs",
    "`MessageRating_rating_check CHECK (\"rating\" BETWEEN 1 AND 5)` at line 2799 and,",
    "1,000 lines later in the SAME FILE, DROPS it and installs",
    "`CHECK (\"rating\" IN (-1, 1))` behind a preflight block that refuses to build the",
    "database at all if any row holds 2, 3, 4 or 5. An adapter written against the",
    "FIRST reading refuses every thumbs-down the product emits and accepts four",
    "values no database this migration builds can hold — wrong in both directions at",
    "once, with `schema.prisma` showing neither constraint. M-G20 and M-G46 are the",
    "two halves of that guard, and the constraints suite stands them side by side.",
]

json.dump(d, open(p, "w"), indent=2)
open(p, "a").write("\n")
print("ledger notes corrected;", len(d["mutations"]), "entries")
