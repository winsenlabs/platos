// EVERY BRANCH OF THE MINT, WITH NO SOCKET AND NO FRAMEWORK.
//
// `secret-mint.ts` is a function over three published contracts, which is the
// whole point of splitting it from the controller: the ten ways this operation
// can refuse are reachable here, in memory, and a suite that had to bind a port
// to reach them would reach about three.
//
// THE DOUBLES BELOW ARE DOUBLES AND ARE NAMED SO. This programme has already
// paid for the alternative — "test doubles lie: the contexts' own fakes mint
// values PostgreSQL refuses, and every use-case suite passes with them" — so
// what these cases assert is deliberately restricted to what a double CAN
// witness: WHICH contract method was called, WITH WHAT, and what this module did
// with the answer. Whether `secrets.rotateCredential` actually advances a
// revision in PostgreSQL is asserted by that context's own integration suite
// over a real database, and is not re-asserted here with a `Map`.
//
// THE ONE PROPERTY WORTH THE MOST IS THE CHEAPEST TO GET WRONG: the bytes handed
// to the vault and the bytes handed to the caller must be the same bytes. A mint
// that sealed one secret and returned another would pass every status-code
// assertion in this file and hand every caller a dead credential, so it is
// asserted directly, from the two recorded values, in `mints one secret and
// hands the caller the same bytes it sealed`.

import { readFileSync } from "node:fs";

import { ok, err, domainError, type Result } from "@platos/kernel";
import type { IdentityAccessContract } from "@platos/context-identity-access";
import type { CredentialMetadata, SecretsContract } from "@platos/context-secrets";
import type { TenancyContract } from "@platos/context-tenancy";
import { describe, expect, it } from "vitest";

import {
  channelWebhookCredentialName,
  MINTED_SECRET_BYTES,
  rotateChannelWebhookSecret,
  type MintDependencies,
} from "./secret-mint.js";

/* ------------------------------------------------------------------ *
 * The doubles. Each is the smallest thing that satisfies the call the
 * mint makes, and NONE of them is a re-implementation of the context.
 * ------------------------------------------------------------------ */

const ORGANIZATION = "org_1";
const PROJECT = "prj_1";
const ENVIRONMENT = "env_1";
const CHANNEL = "chan_1";
const PRINCIPAL = "usr_1";

/** What `authenticateBearer` answers with when the caller is a real operator. */
function operatorPrincipal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    principalId: PRINCIPAL,
    tier: "OPERATOR",
    credentialId: "cred_bearer",
    scope: {
      kind: "ENVIRONMENT",
      tenant: {
        level: "environment",
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
      },
    },
    permissions: [],
    ...overrides,
  };
}

/**
 * The tenancy grant.
 *
 * BRANDED AND UNCONSTRUCTIBLE BY DESIGN — `EnvironmentOperatorAuthorization`
 * carries a unique symbol precisely so a transport cannot mint one — so this
 * double casts. That is the honest shape of a double for a branded value, and it
 * is why no case below asserts anything ABOUT the grant: the assertions are on
 * what the mint DERIVED from it.
 */
function tenancyGrant(): unknown {
  return {
    principalType: "operator",
    tier: "OPERATOR",
    access: "secret:mutate",
    scope: {
      level: "environment",
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
    },
    actorUserId: PRINCIPAL,
    effectiveUserId: PRINCIPAL,
    organizationRole: "OWNER",
    projectRole: null,
  };
}

function credential(name: string): CredentialMetadata {
  return {
    id: "cr_1",
    environmentId: ENVIRONMENT,
    kind: "webhook",
    name,
    provider: null,
    permissions: [],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    activeSecretVersion: null,
  } as unknown as CredentialMetadata;
}

/** What each double was asked, so a case can assert on the ARGUMENTS. */
interface Recorded {
  authenticateBearer: unknown[];
  authorizeEnvironmentOperator: unknown[];
  listCredentials: unknown[];
  rotateCredential: unknown[];
}

interface Harness {
  readonly dependencies: MintDependencies;
  readonly recorded: Recorded;
}

interface HarnessOptions {
  readonly principal?: Result<unknown>;
  readonly grant?: Result<unknown>;
  readonly credentials?: Result<readonly CredentialMetadata[]>;
  readonly rotation?: Result<CredentialMetadata>;
  readonly mintSecret?: () => string;
}

function harness(options: HarnessOptions = {}): Harness {
  const recorded: Recorded = {
    authenticateBearer: [],
    authorizeEnvironmentOperator: [],
    listCredentials: [],
    rotateCredential: [],
  };
  const name = channelWebhookCredentialName(CHANNEL);
  const identityAccess = {
    name: "identity-access",
    authenticateBearer: async (request: unknown) => {
      recorded.authenticateBearer.push(request);
      return options.principal ?? ok(operatorPrincipal());
    },
  } as unknown as IdentityAccessContract;
  const tenancy = {
    name: "tenancy",
    authorizeEnvironmentOperator: async (request: unknown) => {
      recorded.authorizeEnvironmentOperator.push(request);
      return options.grant ?? ok(tenancyGrant());
    },
  } as unknown as TenancyContract;
  const secrets = {
    name: "secrets",
    listCredentials: async (authorization: unknown) => {
      recorded.listCredentials.push(authorization);
      return options.credentials ?? ok([credential(name)]);
    },
    rotateCredential: async (command: unknown) => {
      recorded.rotateCredential.push(command);
      return options.rotation ?? ok(credential(name));
    },
  } as unknown as SecretsContract;
  return {
    recorded,
    dependencies: {
      identityAccess,
      tenancy,
      secrets,
      ...(options.mintSecret === undefined ? {} : { mintSecret: options.mintSecret }),
    },
  };
}

const REQUEST = { channelConnectionId: CHANNEL, presentedToken: "tok" };

/** `crypto.randomBytes(N).toString("hex")` as the oracle spells it. */
const ORACLE_MINT_PATTERN = /randomBytes\((\d+)\)\.toString\("hex"\)/gu;

/**
 * How wide the FROZEN ORACLE mints a channel webhook secret, read off its source.
 *
 * `apps/agent/src/agent-runtime/channels.controller.ts` mints one with
 * `crypto.randomBytes(32).toString("hex")`, in three places, and all three must
 * agree or the oracle itself is inconsistent and this constant is meaningless.
 * Reading it is what makes the width assertion falsifiable: the alternative,
 * `2 * MINTED_SECRET_BYTES`, is the assertion this programme has already been
 * bitten by — "an assertion comparing two things you control cannot fail".
 */
const ORACLE_SECRET_BYTES = ((): number => {
  const source = readFileSync(
    new URL("../../../../../apps/agent/src/agent-runtime/channels.controller.ts", import.meta.url),
    "utf8",
  );
  const widths = [...source.matchAll(ORACLE_MINT_PATTERN)].map((match) => Number(match[1]));
  if (widths.length === 0) throw new Error("the oracle mints no channel webhook secret");
  const distinct = new Set(widths);
  if (distinct.size !== 1) {
    throw new Error(`the oracle mints webhook secrets of ${[...distinct].join(", ")} bytes`);
  }
  return widths[0] as number;
})();

/** The code of a refusal, or a message naming what came back instead. */
function refusalCode(result: Result<unknown>): string {
  if (result.ok) return `unexpectedly ok: ${JSON.stringify(result.value)}`;
  return result.error.code;
}

describe("the channel webhook-secret mint", () => {
  describe("refuses before it reaches a context it does not have", () => {
    // THREE CASES AND NOT ONE PARAMETERISED CASE. Each names a DIFFERENT
    // context in the payload, and a mint that reported "identity-access" for
    // all three would pass a single case that only checked the code.
    it("names identity-access when identity-access is uncomposed", async () => {
      const { dependencies } = harness();
      const result = await rotateChannelWebhookSecret(
        { ...dependencies, identityAccess: undefined },
        REQUEST,
      );
      expect(refusalCode(result)).toBe("MINT_CONTEXT_UNCOMPOSED");
      expect(result.ok ? "" : JSON.stringify(result.error.fields)).toContain("identity-access");
    });

    it("names tenancy when tenancy is uncomposed", async () => {
      const { dependencies } = harness();
      const result = await rotateChannelWebhookSecret({ ...dependencies, tenancy: undefined }, REQUEST);
      expect(refusalCode(result)).toBe("MINT_CONTEXT_UNCOMPOSED");
      expect(result.ok ? "" : JSON.stringify(result.error.fields)).toContain("tenancy");
    });

    it("names secrets when the vault is uncomposed", async () => {
      const { dependencies } = harness();
      const result = await rotateChannelWebhookSecret({ ...dependencies, secrets: undefined }, REQUEST);
      expect(refusalCode(result)).toBe("MINT_CONTEXT_UNCOMPOSED");
      expect(result.ok ? "" : JSON.stringify(result.error.fields)).toContain("secrets");
    });

    it("refuses on the FIRST missing context and calls nothing", async () => {
      // The order is a contract too: a mint that authenticated before noticing
      // it had no vault would spend a rate-limit budget on a request it could
      // never serve.
      const { dependencies, recorded } = harness();
      await rotateChannelWebhookSecret({ ...dependencies, identityAccess: undefined }, REQUEST);
      expect(recorded.authorizeEnvironmentOperator).toHaveLength(0);
      expect(recorded.listCredentials).toHaveLength(0);
      expect(recorded.rotateCredential).toHaveLength(0);
    });
  });

  describe("the identity gate", () => {
    it("passes the authenticator's own refusal through unchanged", async () => {
      // NOT re-wrapped. `identity-access` owns "who is this caller", so its
      // refusal is the answer — a transport that replaced it with a code of its
      // own would erase the distinction between an expired credential and a
      // revoked one.
      const upstream = domainError("BEARER_TOKEN_EXPIRED", "unauthenticated", "expired");
      const { dependencies } = harness({ principal: err(upstream) });
      const result = await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(refusalCode(result)).toBe("BEARER_TOKEN_EXPIRED");
    });

    it("asks with the presented token and NO requested scope", async () => {
      const { dependencies, recorded } = harness();
      await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(recorded.authenticateBearer[0]).toEqual({
        presentedToken: "tok",
        requestedScope: null,
      });
    });

    it("refuses an END_USER credential", async () => {
      const { dependencies, recorded } = harness({
        principal: ok(operatorPrincipal({ tier: "END_USER" })),
      });
      const result = await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(refusalCode(result)).toBe("MINT_PRINCIPAL_NOT_OPERATOR");
      // AND STOPS. The tier check that reported and then continued would be a
      // comment rather than a gate.
      expect(recorded.authorizeEnvironmentOperator).toHaveLength(0);
    });

    it("refuses a credential addressed above one environment", async () => {
      const { dependencies, recorded } = harness({
        principal: ok(
          operatorPrincipal({
            scope: {
              kind: "ORGANIZATION",
              tenant: { level: "organization", organizationId: ORGANIZATION },
            },
          }),
        ),
      });
      const result = await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(refusalCode(result)).toBe("MINT_SCOPE_NOT_ENVIRONMENT");
      expect(recorded.authorizeEnvironmentOperator).toHaveLength(0);
    });

    it("refuses a credential carrying no tenant scope at all", async () => {
      const { dependencies } = harness({
        principal: ok(operatorPrincipal({ scope: { kind: "GLOBAL", tenant: null } })),
      });
      expect(refusalCode(await rotateChannelWebhookSecret(dependencies, REQUEST))).toBe(
        "MINT_SCOPE_NOT_ENVIRONMENT",
      );
    });
  });

  describe("the authorization gate", () => {
    it("asks for secret:mutate and not for a weaker level", async () => {
      // THE CASE THAT FAILS IF SOMEBODY WEAKENS THE ASK. `secret:metadata`
      // would let a read-only operator rotate a live webhook secret, and every
      // other assertion in this file would still pass.
      const { dependencies, recorded } = harness();
      await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(recorded.authorizeEnvironmentOperator[0]).toMatchObject({
        environmentId: ENVIRONMENT,
        access: "secret:mutate",
      });
    });

    it("passes tenancy's refusal through unchanged", async () => {
      const upstream = domainError("TENANCY_FORBIDDEN", "forbidden", "no");
      const { dependencies, recorded } = harness({ grant: err(upstream) });
      const result = await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(refusalCode(result)).toBe("TENANCY_FORBIDDEN");
      expect(recorded.rotateCredential).toHaveLength(0);
    });
  });

  describe("finding the credential", () => {
    it("looks for the name channelWebhookCredentialName builds", async () => {
      // JOINED TO THE FUNCTION, not to a literal. A test that spelled
      // "channel:chan_1:webhook" here would keep passing if the mint and the
      // resolver drifted apart, which is the ONE failure this name exists to
      // make impossible.
      const { dependencies, recorded } = harness({
        credentials: ok([credential("something-else")]),
      });
      const result = await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(refusalCode(result)).toBe("MINT_CREDENTIAL_UNKNOWN");
      expect(recorded.rotateCredential).toHaveLength(0);
    });

    it("refuses when the vault holds nothing at all", async () => {
      const { dependencies } = harness({ credentials: ok([]) });
      expect(refusalCode(await rotateChannelWebhookSecret(dependencies, REQUEST))).toBe(
        "MINT_CREDENTIAL_UNKNOWN",
      );
    });

    it("does NOT echo the channel connection id back in the refusal", async () => {
      // The id came off the URL. A 404 that quoted it is a log-forging
      // primitive, and `transport-errors.ts` refuses to build one.
      const { dependencies } = harness({ credentials: ok([]) });
      const result = await rotateChannelWebhookSecret(dependencies, {
        channelConnectionId: "PAYLOAD-marker",
        presentedToken: "tok",
      });
      expect(JSON.stringify(result)).not.toContain("PAYLOAD-marker");
    });

    it("passes the vault's own listing failure through unchanged", async () => {
      const { dependencies } = harness({
        credentials: err(domainError("SECRETS_UNAVAILABLE", "unavailable", "down")),
      });
      expect(refusalCode(await rotateChannelWebhookSecret(dependencies, REQUEST))).toBe(
        "SECRETS_UNAVAILABLE",
      );
    });
  });

  describe("the rotation", () => {
    it("mints one secret and hands the caller the same bytes it sealed", async () => {
      // THE PROPERTY THIS WHOLE FILE IS FOR. `SecretMaterial` is a
      // self-redacting holder, so the sealed value is read back through the
      // command the vault was handed rather than off the wire.
      const { dependencies, recorded } = harness();
      const result = await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const command = recorded.rotateCredential[0] as { plaintext: { reveal?: () => string } };
      const sealed = command.plaintext;
      // The holder's own accessor, whatever it is called, must reveal exactly
      // what the caller was given.
      const revealed =
        typeof sealed.reveal === "function" ? sealed.reveal() : String((sealed as unknown as string));
      expect(revealed).toBe(result.value.webhookSecret);
    });

    it("mints exactly as wide a secret as the FROZEN ORACLE mints", async () => {
      // JOINED TO `apps/agent`, WHICH THIS DIMENSION DOES NOT CONTROL, and that
      // is the whole point of reading it off disk. Asserting
      // `2 * MINTED_SECRET_BYTES` would have compared the module to itself:
      // narrowing the constant to 16 would move BOTH sides and the case could
      // never fire. The oracle's own `crypto.randomBytes(32)` is the width a
      // rotated secret has today, so a V1 handler that quietly narrowed it —
      // a security regression invisible in a diff — fails HERE.
      expect(ORACLE_SECRET_BYTES).toBeGreaterThan(0);
      expect(MINTED_SECRET_BYTES).toBe(ORACLE_SECRET_BYTES);
      const { dependencies } = harness();
      const result = await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.webhookSecret).toMatch(/^[0-9a-f]+$/u);
      expect(result.value.webhookSecret).toHaveLength(2 * ORACLE_SECRET_BYTES);
    });

    it("mints a DIFFERENT secret every time", async () => {
      // A mint that returned a constant would satisfy every other case here.
      const seen = new Set<string>();
      for (let index = 0; index < 8; index += 1) {
        const { dependencies } = harness();
        const result = await rotateChannelWebhookSecret(dependencies, REQUEST);
        if (result.ok) seen.add(result.value.webhookSecret);
      }
      expect(seen.size).toBe(8);
    });

    it("rotates the credential the LISTING returned, by its own id", async () => {
      const { dependencies, recorded } = harness();
      await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(recorded.rotateCredential[0]).toMatchObject({ credentialId: "cr_1" });
    });

    it("refuses an empty minted secret rather than sealing one", async () => {
      // Reachable only through the injected generator, and it is here because
      // `acceptPlaintext` is the guard WIN-259 put at this boundary: a mint
      // whose generator returned "" must refuse, not store an empty secret.
      const { dependencies, recorded } = harness({ mintSecret: () => "" });
      const result = await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(result.ok).toBe(false);
      expect(recorded.rotateCredential).toHaveLength(0);
    });

    it("passes the vault's rotation failure through unchanged", async () => {
      const { dependencies } = harness({
        rotation: err(domainError("SECRET_CREDENTIAL_REVOKED", "conflict", "revoked")),
      });
      expect(refusalCode(await rotateChannelWebhookSecret(dependencies, REQUEST))).toBe(
        "SECRET_CREDENTIAL_REVOKED",
      );
    });

    it("returns the metadata the vault answered with, carrying no material", async () => {
      const { dependencies } = harness();
      const result = await rotateChannelWebhookSecret(dependencies, REQUEST);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.credential.id).toBe("cr_1");
      expect(JSON.stringify(result.value.credential)).not.toContain(result.value.webhookSecret);
    });
  });

  describe("the credential name", () => {
    it("is scoped by the channel connection id", () => {
      expect(channelWebhookCredentialName("a")).not.toBe(channelWebhookCredentialName("b"));
    });

    it("names the channel and the purpose, so two purposes never collide", () => {
      expect(channelWebhookCredentialName(CHANNEL)).toBe(`channel:${CHANNEL}:webhook`);
    });
  });
});
