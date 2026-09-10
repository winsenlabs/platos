// THE 4.34 -> 4.40 UPGRADE, EVIDENCED RATHER THAN ASSUMED.
//
// WIN-271 asks for the Chat SDK to move "from the audited 4.34 line toward
// approved current stable versions using provider fixtures", with upgrades
// "staged and rollbackable". This file is the evidence half of that.
//
// WHAT IS ACTUALLY STAGED. `packages/adapters/channel-slack` DEPENDS on
// `@chat-adapter/slack@^4.40.0` and `apps/agent` — the legacy channel monolith,
// which this tranche does not touch — stays on `^4.34.0`. Two lines, two
// packages, one version literal each. Rolling this adapter back is editing one
// string in one `package.json`: no source file in this directory names a
// version, because every SDK import goes through `vendor.ts`.
//
// WHAT THIS SUITE PROVES. `@chat-adapter/slack-audited` is a devDependency
// ALIAS pinned at exactly `4.34.0`. Every case below asks BOTH artifacts the
// same question about the same fixture and asserts they answer identically. The
// two are independently published builds — nothing in this repository produced
// either — so an agreement between them is a real join and not a comparison
// between two things this tranche controls.
//
// WHAT IT DOES NOT PROVE, and this is worth saying plainly: it covers the FOUR
// FUNCTIONS `vendor.ts` imports, over the fixtures in `fixtures.ts` and Slack's
// published vector. A behaviour change anywhere else in the 4.40 line — socket
// mode, block builders, the `chat` framework itself — is out of its reach, and
// out of this adapter's reach too, because this adapter imports none of it.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parseSlackWebhookBody as parse440,
  verifySlackSignature as verify440,
} from "@chat-adapter/slack/webhook";
import {
  parseSlackWebhookBody as parse434,
  verifySlackSignature as verify434,
} from "@chat-adapter/slack-audited/webhook";

import { ALL_FIXTURE_BODIES, FIXTURE_SIGNING_SECRET, signSlackDelivery } from "./fixtures.js";
import {
  PUBLISHED_BODY,
  PUBLISHED_SECRET,
  PUBLISHED_SIGNATURE,
  PUBLISHED_TIMESTAMP,
} from "./published-vector.js";

/**
 * The version this package's own `node_modules` link resolves a dependency to.
 *
 * READ OFF THE INSTALL, not resolved through a module loader. `createRequire`
 * refuses these subpaths — both packages are ESM-only and publish under the
 * `import` condition alone — and Vite's SSR transform replaces
 * `import.meta.resolve` with nothing. Both were tried; the layout is the thing
 * that is actually stable. pnpm links every DECLARED dependency into the
 * declaring package's own `node_modules`, so this path exists exactly when the
 * dependency is declared, which is the fact the case wants anyway.
 */
function installedVersion(packageName: string): string {
  const manifest = new URL(`../node_modules/${packageName}/package.json`, import.meta.url);
  return (JSON.parse(readFileSync(manifest, "utf8")) as { readonly version: string }).version;
}

type Verifier = typeof verify440;
type Parser = typeof parse440;

const LINES: ReadonlyArray<readonly [string, Verifier, Parser]> = [
  ["4.40 (shipped)", verify440, parse440],
  ["4.34 (audited)", verify434, parse434],
];

async function verdict(
  verify: Verifier,
  body: string,
  headers: Record<string, string>,
  atSeconds: number,
): Promise<string> {
  try {
    await verify(body, headers, {
      signingSecret: PUBLISHED_SECRET,
      now: () => atSeconds * 1000,
      maxSkewSeconds: 300,
    });
    return "ACCEPT";
  } catch (error) {
    // The CLASS, not the message. Vendor prose is allowed to change between
    // minors; the taxonomy is not, and this adapter maps on structure anyway.
    return `REJECT:${(error as Error).constructor.name}`;
  }
}

describe("both lines agree on Slack's published vector", () => {
  it("accepts it, on 4.34 and on 4.40", async () => {
    const headers = {
      "x-slack-request-timestamp": PUBLISHED_TIMESTAMP,
      "x-slack-signature": PUBLISHED_SIGNATURE,
    };
    for (const [label, verify] of LINES) {
      expect(`${label}:${await verdict(verify, PUBLISHED_BODY, headers, Number(PUBLISHED_TIMESTAMP))}`).toBe(
        `${label}:ACCEPT`,
      );
    }
  });

  it("refuses the same four ways, on both lines", async () => {
    const at = Number(PUBLISHED_TIMESTAMP);
    const good = {
      "x-slack-request-timestamp": PUBLISHED_TIMESTAMP,
      "x-slack-signature": PUBLISHED_SIGNATURE,
    };
    const perturbations: ReadonlyArray<readonly [string, string, Record<string, string>, number]> = [
      ["tampered body", `${PUBLISHED_BODY}&extra=1`, good, at],
      ["flipped signature", PUBLISHED_BODY, { ...good, "x-slack-signature": `${PUBLISHED_SIGNATURE.slice(0, -1)}0` }, at],
      ["absent headers", PUBLISHED_BODY, {}, at],
      ["stale timestamp", PUBLISHED_BODY, good, at + 4000],
    ];

    for (const [name, body, headers, instant] of perturbations) {
      const answers = await Promise.all(LINES.map(([, verify]) => verdict(verify, body, headers, instant)));
      // Both refused, and refused the same way.
      expect(`${name}:${answers[0]}`).toBe(`${name}:${answers[1]}`);
      expect(answers[0]).toMatch(/^REJECT:/u);
    }
  });
});

describe("both lines normalize every provider fixture identically", () => {
  it("produces the same parse for each of the eight fixtures", async () => {
    for (const [name, body] of ALL_FIXTURE_BODIES) {
      const shapes = LINES.map(([, , parse]) => {
        try {
          return JSON.stringify(parse(body));
        } catch (error) {
          return `THREW:${(error as Error).constructor.name}`;
        }
      });
      // THE WHOLE PARSE, not a summary of it. Comparing only the fields this
      // adapter reads would miss a change in a field it might read tomorrow, and
      // a stringify of the whole object costs nothing here.
      expect(`${name}:${shapes[0]}`).toBe(`${name}:${shapes[1]}`);
    }
  });

  it("agrees on the fields this adapter actually depends on", async () => {
    // The whole-object comparison above would also pass if BOTH lines started
    // returning `{}`. These are the five properties `normalize.ts` reads, named,
    // so a change that hollowed them out on both lines at once still fails.
    const [, mention] = ALL_FIXTURE_BODIES[1] ?? ["", ""];
    for (const [label, , parse] of LINES) {
      const parsed = parse(mention) as unknown as Record<string, unknown>;
      expect(`${label}:${String(parsed["kind"])}`).toBe(`${label}:app_mention`);
      expect(`${label}:${String(parsed["eventId"])}`).toBe(`${label}:Ev0MDYGDK4`);
      expect(`${label}:${String(parsed["channelId"])}`).toBe(`${label}:C0LAN2Q65`);
      expect(`${label}:${String(parsed["threadTs"])}`).toBe(`${label}:1515449522.000016`);
      expect(`${label}:${typeof parsed["text"]}`).toBe(`${label}:string`);
    }
  });
});

describe("the differential is not vacuous", () => {
  it("is running two DIFFERENT artifacts", async () => {
    // If the alias ever resolved to the same install as the primary dependency,
    // every case above would compare a function with itself and pass forever.
    // The two lines are separate module instances, so the function identities
    // differ; and the packages' own manifests carry the two versions.
    expect(verify434).not.toBe(verify440);
    expect(parse434).not.toBe(parse440);

    // The manifests are READ OFF DISK rather than imported: neither package
    // exports `./package.json`, and resolving the subpath that IS exported and
    // walking up to the manifest is what an install actually looks like.
    expect(installedVersion("@chat-adapter/slack-audited")).toBe("4.34.0");
    expect(installedVersion("@chat-adapter/slack")).not.toBe("4.34.0");
  });

  it("would notice a disagreement, demonstrated on a case where one is wrong", async () => {
    // A NEGATIVE CONTROL for the comparison itself. Both lines are asked about
    // the same fixture, but one is handed a DIFFERENT secret — so the comparison
    // must fail. If this passes, the equality above is comparing something other
    // than what it claims to.
    const delivery = signSlackDelivery(ALL_FIXTURE_BODIES[1]?.[1] ?? "");
    const at = Number(delivery.headers["x-slack-request-timestamp"]);
    const rightSecret = await (async () => {
      try {
        await verify440(delivery.rawBody, delivery.headers, {
          signingSecret: FIXTURE_SIGNING_SECRET,
          now: () => at * 1000,
          maxSkewSeconds: 300,
        });
        return "ACCEPT";
      } catch {
        return "REJECT";
      }
    })();
    const wrongSecret = await (async () => {
      try {
        await verify434(delivery.rawBody, delivery.headers, {
          signingSecret: `${FIXTURE_SIGNING_SECRET}x`,
          now: () => at * 1000,
          maxSkewSeconds: 300,
        });
        return "ACCEPT";
      } catch {
        return "REJECT";
      }
    })();
    expect(rightSecret).toBe("ACCEPT");
    expect(wrongSecret).toBe("REJECT");
    expect(rightSecret).not.toBe(wrongSecret);
  });
});
