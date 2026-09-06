// WIN-259 M2.4. A cached verdict must not outlive the material it was made
// about — and when the cache cannot be told, the caller must be told.
//
// TWO INDEPENDENT MECHANISMS, TESTED INDEPENDENTLY, and the order is the point.
//
//   STRUCTURAL. `credentialFingerprint` moves when a key is rotated or relinked,
//   so the stale entry stops being ADDRESSABLE whether or not the eviction ran.
//   The first two cases below break the eviction on purpose and still observe a
//   miss, which is the only way to show the fingerprint is doing the work.
//
//   ANNOUNCED. Four call sites now refuse when `forgetProvider` fails, so an
//   eviction that silently did nothing is no longer indistinguishable from one
//   that worked. Before this issue all six discarded the `Result`.
//
// A security property resting on a best-effort side effect is not a property, so
// the structural half leads and the announced half is what makes the residue
// visible.

import { describe, expect, it } from "vitest";

import { asProvidersIdentifier, credentialFingerprint, type ProviderId } from "../domain/index.js";
import { checkProviderHealth } from "./check-provider-health.js";
import { deleteProviderKey } from "./delete-provider-key.js";
import { unlinkProvider } from "./describe-providers.js";
import { relinkProviderKey, rotateProviderKeySecret } from "./rotate-provider-key.js";
import {
  buildProvidersTestContext,
  testProviderKey,
  type ProvidersTestContext,
} from "./testing/index.js";

const OPENAI = asProvidersIdentifier<ProviderId>("openai");

function configure(context: ProvidersTestContext): void {
  const credential = context.secrets.seed({
    name: "OPENAI_API_KEY",
    provider: "openai",
    plaintext: "sk-leaked",
  });
  context.repository.seedProviderKey(
    testProviderKey(context.scope, { credentialId: credential.id }),
  );
}

function check(context: ProvidersTestContext) {
  return checkProviderHealth(context.dependencies, {
    authorization: context.secrets.runtimeGrant(),
    scope: context.scope,
    provider: "openai",
  });
}

describe("the cache key moves when the material does", () => {
  it("changes on a rotation even though the row identifier does not", () => {
    // THE DEFECT, IN ONE ASSERTION. Until WIN-259 the fingerprint WAS
    // `providerKeyId`, and a rotation does not change it: `rotateProviderKeySecret`
    // rotates the credential behind the row and relinks the SAME row. So the two
    // fingerprints below were equal, the cache entry stayed addressable, and the
    // verdict about the old material stayed servable.
    const before = {
      providerKeyId: "key-1",
      credentialId: "cred-1",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const afterRotation = { ...before, updatedAt: new Date("2026-01-01T00:05:00.000Z") };
    const afterRelink = { ...before, credentialId: "cred-2" };

    expect(credentialFingerprint(before)).not.toBe(credentialFingerprint(afterRotation));
    expect(credentialFingerprint(before)).not.toBe(credentialFingerprint(afterRelink));
    // And it is STABLE when nothing about the material changed, or every read
    // would be a miss and the cache would be decoration.
    expect(credentialFingerprint(before)).toBe(credentialFingerprint({ ...before }));
  });

  it("keys on all three fields, so two keys in one environment never collide", () => {
    const base = {
      providerKeyId: "key-1",
      credentialId: "cred-1",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    expect(credentialFingerprint(base)).not.toBe(
      credentialFingerprint({ ...base, providerKeyId: "key-2" }),
    );
  });
});

describe("a rotated key does not serve the old key's verdict", () => {
  it("re-probes after a rotation even when the eviction did nothing", async () => {
    const context = buildProvidersTestContext();
    configure(context);

    // A `healthy` verdict is cached against the ORIGINAL material.
    const first = await check(context);
    if (!first.ok) throw new Error(`unreachable: ${first.error.code}`);
    expect(first.value.status).toBe("healthy");
    expect(context.probeCache.healthWrites).toBe(1);
    expect(context.modelRouter.probes).toHaveLength(1);

    // A second check is served from the cache and calls nothing. Without this
    // the test could not tell a working cache from an absent one, and the miss
    // below would prove nothing.
    const second = await check(context);
    expect(second.ok).toBe(true);
    expect(context.modelRouter.probes).toHaveLength(1);

    // THE EVICTION IS BROKEN ON PURPOSE, and the double leaves the entry exactly
    // where it is. Everything after this point is the fingerprint's doing.
    context.probeCache.evictionsFail = true;
    context.clock.advanceSeconds(1);

    const rotated = await rotateProviderKeySecret(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: asProvidersIdentifier("key-1"),
      plaintext: "sk-fresh",
    });
    // It refuses, because the cache could not be told — that is the ANNOUNCED
    // half, asserted on its own below. The rotation itself has landed.
    expect(rotated.ok).toBe(false);

    // The stale entry is still sitting in the cache, unreachable.
    const third = await check(context);
    if (!third.ok) throw new Error(`unreachable: ${third.error.code}`);
    expect(context.modelRouter.probes).toHaveLength(2);
    expect(context.modelRouter.probes[1]?.revealed).toBe("sk-fresh");
  });

  it("re-probes after a relink even when the eviction did nothing", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    context.secrets.seed({ name: "OPENAI_BACKUP", provider: "openai", plaintext: "sk-backup" });

    const first = await check(context);
    expect(first.ok).toBe(true);
    expect(context.modelRouter.probes).toHaveLength(1);

    context.probeCache.evictionsFail = true;
    const relinked = await relinkProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: asProvidersIdentifier("key-1"),
      credentialName: "OPENAI_BACKUP",
    });
    expect(relinked.ok).toBe(false);

    const second = await check(context);
    expect(second.ok).toBe(true);
    // A relink changes `credentialId`, so the fingerprint moves on that field
    // rather than on the instant — which is why the fingerprint carries both.
    expect(context.modelRouter.probes).toHaveLength(2);
    expect(context.modelRouter.probes[1]?.revealed).toBe("sk-backup");
  });
});

describe("an eviction that failed is reported and not swallowed", () => {
  it("refuses a rotation, naming the provider and a window that clears the staleness", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    context.probeCache.evictionsFail = true;

    const rotated = await rotateProviderKeySecret(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: asProvidersIdentifier("key-1"),
      plaintext: "sk-fresh",
    });
    expect(rotated.ok).toBe(false);
    if (rotated.ok) return;
    expect(rotated.error.code).toBe("PROVIDERS_PROBE_CACHE_NOT_EVICTED");
    expect(rotated.error.category).toBe("unavailable");
    expect(rotated.error.details["provider"]).toBe("openai");
    // The LONGER of the two health windows. Being told to retry in one minute
    // while a `healthy` verdict is servable for five is a number that does not
    // clear what the caller was warned about.
    expect(rotated.error.retryAfterSeconds).toBe(300);
    // The message must not read as "your rotation did not happen": it did, and
    // repeating it would mint a second new secret rather than retrying.
    expect(rotated.error.message).toContain("was changed");
  });

  it("refuses a relink, a deletion and an unlink on the same terms", async () => {
    for (const operation of ["relink", "delete", "unlink"] as const) {
      const context = buildProvidersTestContext();
      configure(context);
      context.secrets.seed({ name: "OPENAI_BACKUP", provider: "openai", plaintext: "sk-backup" });
      context.probeCache.evictionsFail = true;

      const outcome =
        operation === "relink"
          ? await relinkProviderKey(context.dependencies, {
              authorization: context.tenancy.grant(),
              providerKeyId: asProvidersIdentifier("key-1"),
              credentialName: "OPENAI_BACKUP",
            })
          : operation === "delete"
            ? await deleteProviderKey(context.dependencies, {
                authorization: context.tenancy.grant(),
                providerKeyId: asProvidersIdentifier("key-1"),
              })
            : await unlinkProvider(context.dependencies, {
                authorization: context.tenancy.grant(),
                provider: "openai",
              });

      expect(outcome.ok, `${operation} must refuse`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error.code, `${operation} code`).toBe("PROVIDERS_PROBE_CACHE_NOT_EVICTED");
    }
  });

  it("does NOT refuse when the eviction succeeds", async () => {
    // The negative control. Without it a guard that refused unconditionally
    // would pass every case above, and four write paths would be dead.
    const context = buildProvidersTestContext();
    configure(context);

    const rotated = await rotateProviderKeySecret(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: asProvidersIdentifier("key-1"),
      plaintext: "sk-fresh",
    });
    expect(rotated.ok).toBe(true);
    expect(context.probeCache.forgotten).toEqual([OPENAI]);
  });

  it("still adds a key when the eviction fails, because nothing stale is reachable", async () => {
    // The DELIBERATE asymmetry, asserted so it cannot be quietly widened. A key
    // being ADDED has no entry keyed by it — the fingerprint carries the new
    // row's identifier — and `check-provider-health.ts` never serves a
    // `not_configured` answer from cache. Refusing here would tell an operator
    // their key was not created when it was.
    const context = buildProvidersTestContext();
    context.secrets.seed({ name: "OPENAI_API_KEY", provider: "openai", plaintext: "sk-live" });
    context.probeCache.evictionsFail = true;

    const linked = await import("./link-provider-key.js").then((module) =>
      module.linkProviderKey(context.dependencies, {
        authorization: context.tenancy.grant(),
        intake: {
          provider: "openai",
          label: "production",
          credentialName: "OPENAI_API_KEY",
          isDefault: true,
        },
      }),
    );
    expect(linked.ok).toBe(true);
    // The eviction was still ATTEMPTED. A site that stopped calling at all would
    // pass the assertion above and lose the "first key for a provider" case the
    // port's header names.
    expect(context.probeCache.forgotten).toEqual([OPENAI]);
  });
});
