#!/usr/bin/env node
// Multi-tenant scope audit — REPORT-ONLY advisory (no Docker, no DB).
//
// CLAUDE.md treats the (organizationId, projectId, environmentId) tuple as a
// sacred invariant: every Prisma query on a scoped Platos table should filter by
// it, or a cross-tenant leak is possible. The cross-scope-isolation.test.ts
// cases meant to guard this are skipped (they need testcontainers, and seeding
// ORG_A then querying with ORG_B only proves Prisma filters by what you pass — a
// tautology). The real bug class is "a SERVICE forgot to pass the scope filter",
// which is a STATIC property — what this surfaces, on any machine, no infra.
//
// IMPORTANT: this is a REVIEW AID, not a gate. It is heuristic: it cannot see a
// where-clause built dynamically (`const w = {}; w.organizationId = ...`) or a
// scope check that lives one call up, so it has false positives. It is therefore
// NOT wired into CI as a blocking check. Use it to triage: walk the list, and
// for each call either add the tuple filter or annotate the call (or the line
// above it) with `// scope-audit-ok: <reason>` to record that it is intentionally
// unscoped (admin cross-scope tooling, PK lookup scoped elsewhere, dynamic where,
// etc). As annotations accumulate the list shrinks to genuine unknowns, and a
// future maintainer can decide whether `--strict` is clean enough to gate on.
//
// Usage:  node scripts/audit-scope.mjs            # report
//         node scripts/audit-scope.mjs --strict   # exit 1 if any un-annotated
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIRS = ["apps/agent/src", "apps/webapp/app"];

// Prisma client accessors (camelCase) for tables carrying organizationId.
const SCOPED = [
  "platosAgent", "platosAgentApproval", "platosAgentArtifact",
  "platosAgentCluster", "platosAgentEval", "platosAgentThread",
  "platosConnectedEntity", "platosEndUser", "platosToolCallAudit",
  "platosMessageAttachment", "platosMessageRating", "platosMemory",
  "platosSafetyEvent", "platosMCPServer", "platosPAT",
];
const METHODS = [
  "findFirst", "findUnique", "findMany", "update", "updateMany",
  "delete", "deleteMany", "count", "aggregate",
];
const ACCESSOR_RE = new RegExp(`\\.(${SCOPED.join("|")})\\.(${METHODS.join("|")})\\s*\\(`, "g");
const OK_RE = /scope-audit-ok/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (["node_modules", "dist", "build"].includes(e)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e) && !/\.(test|spec)\./.test(e)) out.push(p);
  }
  return out;
}

// Brace/paren/bracket- and string-aware matched-call extraction.
function matchedCall(src, open) {
  let depth = 0, str = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (str) { if (c === "\\") { i++; continue; } if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === "`") { str = c; continue; }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") { if (--depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}
const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

const findings = [];
let scanned = 0, scopedCalls = 0, annotatedCount = 0;
for (const dir of SCAN_DIRS) {
  let files;
  try { files = walk(join(ROOT, dir)); } catch { continue; }
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    scanned++;
    ACCESSOR_RE.lastIndex = 0;
    let m;
    while ((m = ACCESSOR_RE.exec(src))) {
      scopedCalls++;
      const call = matchedCall(src, ACCESSOR_RE.lastIndex - 1);
      const line = lineOf(src, m.index);
      const before = src.split("\n").slice(Math.max(0, line - 3), line).join("\n");
      const annotated = OK_RE.test(call) || OK_RE.test(before);
      if (annotated) { annotatedCount++; continue; }
      if (!/organizationId/.test(call)) {
        findings.push({ file: relative(ROOT, file), line, accessor: `${m[1]}.${m[2]}` });
      }
    }
  }
}

const strict = process.argv.includes("--strict");
console.log(`scope-audit (report-only): ${scanned} files, ${scopedCalls} scoped-table calls, ${annotatedCount} annotated scope-audit-ok`);
console.log(`unscoped + un-annotated (REVIEW these — false positives expected): ${findings.length}\n`);
for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.accessor}`);
if (findings.length) {
  console.log(`\nFor each: add the (organizationId, projectId, environmentId) filter,`);
  console.log(`or annotate with \`// scope-audit-ok: <reason>\` if intentionally unscoped.`);
}
// Default run NEVER fails a build — this is advisory. --strict is opt-in for a
// future where the baseline is fully annotated.
process.exit(strict && findings.length ? 1 : 0);
