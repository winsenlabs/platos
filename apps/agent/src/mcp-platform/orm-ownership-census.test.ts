// WIN-268 P2 — the MCP platform's remaining ORM surface, SPLIT BY THE CONTEXT
// THAT OWNS THE ROW, and ratcheted.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AND WHY IT IS NOT A MARKDOWN TABLE
//
// The tranche brief asks for "the exact remaining count with its ownership
// split". A number in a commit message is true for one commit; this is the same
// number, recomputed on every run, JOINED to three things this file does not
// write:
//
//   * the CALL SITES come from `prisma-delegate-census.ts` — the type-checker
//     walk `clean-prisma-delegates.test.ts` has always used, extracted so its
//     per-call-site results survive. One analyzer, two consumers, so the
//     ownership split and the app-wide pin cannot disagree by construction.
//   * the DELEGATE -> MODEL map comes from `Prisma.dmmf`, which `prisma
//     generate` derives from `schema.prisma`. Rename a model and this map
//     changes with no edit here.
//   * the MODEL -> OWNER map is imported from `scripts/arch/table-ownership.mjs`,
//     which is ADR M0.3 §5.2's ownership column as data and is enforced against
//     the canonical schema by `scripts/arch/sole-writer.mjs`.
//
// So "who owns the rows this directory still reaches" is answered by the
// architecture's own map rather than by a list somebody kept here.
//
// ---------------------------------------------------------------------------
// THE RATCHET IS ONE-WAY AND IT IS PER FILE
//
// A single grand total would let a tranche add ten statements to one file while
// removing eleven from another and report progress. The pin is per file, and a
// file may only go DOWN. A file that goes UP fails; a NEW file with ORM calls
// fails, because it is not on the pin at all.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  analyzeAgentSource,
  disconnectGeneratedClient,
  modelForDelegate,
} from "../prisma-delegate-census";
// @ts-expect-error — a plain-Node governance module with no types. It is the
// ADR's ownership column, and importing it is the whole point: a TypeScript
// re-declaration of the same map would be a second source of truth.
import { OWNER } from "../../../../scripts/arch/table-ownership.mjs";

const OWNERSHIP: Readonly<Record<string, string>> = OWNER as Readonly<Record<string, string>>;

const MCP_PLATFORM_PREFIX = "mcp-platform/";

/**
 * The per-file ceiling. A file may hold FEWER ORM call sites than this; never
 * more, and a file absent from this map may hold none.
 *
 * MEASURED, NOT ASSERTED. Every number below was read off this analyzer on the
 * committed tree. The three services WIN-268 P2 converted are absent, which is
 * the same claim `mcp-platform-service-no-prisma` makes in
 * `scripts/arch/boundary-rules.mjs` — deliberately made twice, because the
 * boundary rule sees IMPORTS and this sees CALLS, and a file could in principle
 * lose the import while keeping a call through some other route.
 */
const CEILING: Readonly<Record<string, number>> = Object.freeze({
  "mcp-platform/mcp-entity.controller.ts": 20,
  "mcp-platform/mcp-bearer-token.service.ts": 9,
  "mcp-platform/token.service.ts": 10,
  "mcp-platform/events.service.ts": 8,
  "mcp-platform/entity-tool-policy.store.ts": 10,
  "mcp-platform/mcp-policy.store.ts": 7,
  "mcp-platform/mcp-identity.store.ts": 5,
  "mcp-platform/tools/entities.ts": 0,
  "mcp-platform/tools/events.ts": 0,
  "mcp-platform/tools/mcp.ts": 0,
});

/** The three services the tranche took off the ORM. They must hold ZERO. */
const CONVERTED = Object.freeze([
  "mcp-platform/permission-gateway.service.ts",
  "mcp-platform/mcp-tool-acl.service.ts",
  "mcp-platform/identity-resolver.service.ts",
]);

afterAll(async () => {
  await disconnectGeneratedClient();
});

describe("WIN-268 P2 — the mcp-platform ORM surface, by owning context", () => {
  it("every model this directory reaches resolves to an owner in the ADR's map", () => {
    const { analysis } = analyzeAgentSource();
    const here = analysis.calls.filter((call) => call.file.startsWith(MCP_PLATFORM_PREFIX));
    expect(here.length).toBeGreaterThan(0);

    const unowned = new Set<string>();
    for (const call of here) {
      const model = modelForDelegate.get(call.delegate);
      // A delegate with no model would mean the analyzer resolved something the
      // generated client does not have — which `clean-prisma-delegates.test.ts`
      // already refuses app-wide, so it is an assertion about THIS filter.
      expect(model, `${call.delegate} is not a generated delegate`).toBeDefined();
      if (model && OWNERSHIP[model] === undefined) unowned.add(model);
    }
    expect(
      [...unowned].sort(),
      "a row this directory writes has no owning context in ADR M0.3 §5.2",
    ).toEqual([]);
  });

  it("the three converted services hold ZERO ORM call sites", () => {
    const { analysis } = analyzeAgentSource();
    const offenders = analysis.calls
      .filter((call) => CONVERTED.includes(call.file))
      .map((call) => `${call.file}:${call.line} ${call.delegate}.${call.operation}`);
    expect(offenders, "a converted service still calls the ORM").toEqual([]);
  });

  it("RATCHET: no file in this directory holds more ORM call sites than its ceiling", () => {
    const { analysis } = analyzeAgentSource();
    const counts = new Map<string, number>();
    for (const call of analysis.calls) {
      if (!call.file.startsWith(MCP_PLATFORM_PREFIX)) continue;
      counts.set(call.file, (counts.get(call.file) ?? 0) + 1);
    }

    const regressions: string[] = [];
    for (const [file, count] of counts) {
      const ceiling = CEILING[file] ?? 0;
      if (count > ceiling) regressions.push(`${file}: ${count} > ${ceiling}`);
    }
    expect(
      regressions.sort(),
      "an mcp-platform file gained ORM call sites; the ratchet is one-way",
    ).toEqual([]);
  });

  it("reports the split, and the split is joined to the app-wide pin", () => {
    const { analysis } = analyzeAgentSource();
    const here = analysis.calls.filter((call) => call.file.startsWith(MCP_PLATFORM_PREFIX));

    const byOwner = new Map<string, number>();
    for (const call of here) {
      const owner = OWNERSHIP[modelForDelegate.get(call.delegate) ?? ""] ?? "<unowned>";
      byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
    }

    // THE JOIN. `clean-prisma-delegates.test.ts` pins the app-wide total, and
    // that pin is itself joined to the frozen `main` oracle (see its own note).
    // Reading the digit out of that file rather than restating it here is what
    // stops the two drifting: re-pin one and not the other, and this fails.
    const gate = readFileSync(
      fileURLToPath(new URL("../clean-prisma-delegates.test.ts", import.meta.url)),
      "utf8",
    );
    const pinned = /expect\(analysis\.calls\.length\)\.toBe\((\d+)\)/u.exec(gate);
    expect(pinned?.[1], "the app-wide call-site pin could not be read").toBeDefined();

    const total = Number(pinned?.[1]);
    const outside = analysis.calls.length - here.length;
    expect(here.length + outside).toBe(analysis.calls.length);
    expect(analysis.calls.length).toBe(total);

    // Not an assertion — the report. Printed so a reviewer reading CI output
    // gets the ownership split without running anything.
    const split = [...byOwner.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, count]) => `${owner}=${count}`)
      .join(" ");
    process.stdout.write(
      `\n[WIN-268 P2] mcp-platform ORM call sites: ${here.length} of ${total} app-wide\n` +
        `[WIN-268 P2] ownership split: ${split}\n`,
    );
  });
});
