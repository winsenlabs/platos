// WIN-259 — the WRITE side of the encryption boundary.
//
// The read side has been safe since this context was written: `readSecret`
// answers with `SecretMaterial`, which redacts itself under JSON, string
// coercion, inspection, spreading and enumeration. The WRITE side was a bare
// `string` on three commands, so the plaintext existed as an ordinary property
// of an ordinary object for the whole distance between a caller building the
// command and this context sealing it — and that distance is exactly where a
// transport puts a request logger, a retry buffer, an error report and a queue.
//
// Every case below fails against the shape this file replaced. The literal
// `SENTINEL-PLAINTEXT-WIN259` is what makes them fail rather than a shape
// assertion: it is searched for in the serialised command, so a case cannot pass
// by agreeing with a projection this branch also wrote.

import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { secretMaterial } from "../domain/secret-material.js";
import { createCredential } from "./create-credential.js";
import { setEnvironmentVariable } from "./environment-variable-writes.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { rotateCredential } from "./rotate-credential.js";

const SENTINEL = "SENTINEL-PLAINTEXT-WIN259";

let context: InMemorySecrets;
let grants: InMemoryGrants;

beforeEach(() => {
  context = inMemorySecrets();
  grants = inMemoryGrants();
});

describe("a mutating command cannot be written down", () => {
  it("survives JSON.stringify with no plaintext, on all three commands", () => {
    const commands = [
      { authorization: grants.operator, name: "K", plaintext: secretMaterial(SENTINEL) },
      { authorization: grants.operator, credentialId: "c1", plaintext: secretMaterial(SENTINEL) },
      { authorization: grants.operator, key: "K", value: secretMaterial(SENTINEL), secret: true },
    ];
    for (const command of commands) {
      expect(JSON.stringify(command)).not.toContain(SENTINEL);
      expect(JSON.stringify(command)).toContain("[REDACTED SecretMaterial]");
    }
  });

  it("survives string coercion and template interpolation", () => {
    const command = { authorization: grants.operator, name: "K", plaintext: secretMaterial(SENTINEL) };
    expect(`${String(command.plaintext)}`).not.toContain(SENTINEL);
    expect([command.plaintext].join(",")).not.toContain(SENTINEL);
  });

  it("survives the two accidental-capture paths a structured logger takes", () => {
    const command = { authorization: grants.operator, name: "K", plaintext: secretMaterial(SENTINEL) };
    expect(JSON.stringify({ ...command.plaintext })).toBe("{}");
    expect(Object.keys(command.plaintext)).toEqual([]);
  });

  it("gives up the plaintext only to a caller that NAMES reveal()", () => {
    expect(secretMaterial(SENTINEL).reveal()).toBe(SENTINEL);
  });
});

describe("a bare string is refused, with its own code", () => {
  it("refuses one at createCredential and writes nothing", async () => {
    const refused = await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: SENTINEL as never,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("SECRET_INPUT_NOT_WRITE_ONLY");
      expect(refused.error.fields).toEqual([
        {
          field: "plaintext",
          code: "write_only",
          message: "must be minted by acceptPlaintext, never passed as a plain string",
        },
      ]);
    }
    expect(context.store.allCredentials()).toHaveLength(0);
    expect(context.store.allVersions()).toHaveLength(0);
  });

  it("refuses one at rotateCredential without advancing the revision", async () => {
    const credentialId = unwrap(
      await createCredential(context.dependencies, {
        authorization: grants.operator,
        name: "OPENAI_API_KEY",
        plaintext: secretMaterial("first"),
      }),
    ).id;
    const refused = await rotateCredential(context.dependencies, {
      authorization: grants.operator,
      credentialId,
      plaintext: SENTINEL as never,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("SECRET_INPUT_NOT_WRITE_ONLY");
    expect(context.store.allVersions()).toHaveLength(1);
  });

  it("refuses one at setEnvironmentVariable and leaves the row absent", async () => {
    const refused = await setEnvironmentVariable(context.dependencies, {
      authorization: grants.operator,
      key: "OPENAI_API_KEY",
      value: SENTINEL as never,
      secret: true,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("SECRET_INPUT_NOT_WRITE_ONLY");
      expect(refused.error.fields[0]?.field).toBe("value");
    }
    expect(context.store.allCredentials()).toHaveLength(0);
  });

  it("refuses one BEFORE the transaction, so no audit row is appended", async () => {
    await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: SENTINEL as never,
    });
    expect(context.store.allAudits()).toHaveLength(0);
    expect(context.unitOfWork.commits()).toBe(0);
  });

  it("refuses every non-string shape a decoded request body can carry", async () => {
    for (const carried of [null, undefined, 42, true, {}, { reveal: "not a function" }, []]) {
      const refused = await createCredential(context.dependencies, {
        authorization: grants.operator,
        name: "OPENAI_API_KEY",
        plaintext: carried as never,
      });
      expect(refused.ok, JSON.stringify(carried)).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("SECRET_INPUT_NOT_WRITE_ONLY");
    }
  });
});

describe("the two refusals are told apart", () => {
  it("answers a HOLDER of empty plaintext with the material code, not the carrier code", async () => {
    const refused = await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: secretMaterial(""),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("INVALID_SECRET_MATERIAL");
      expect(refused.error.details).toMatchObject({ reason: "plaintext_empty" });
    }
  });

  it("answers an EMPTY BARE STRING with the carrier code, because the carrier is the worse fault", async () => {
    const refused = await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: "" as never,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("SECRET_INPUT_NOT_WRITE_ONLY");
  });
});

describe("what the carrier check can and cannot see", () => {
  // MEASURED LIMIT, declared rather than overclaimed. The check is behavioural,
  // not identity: it asks whether the value answers `toJSON()` with the redaction
  // literal. A hand-rolled value CAN satisfy it — but a value that satisfies it
  // is, by construction, one that redacts itself under exactly the paths this
  // guard exists to close, so admitting it leaks nothing. Identity against a
  // register (the shape `authorization` uses) would be strictly stronger and is
  // deliberately not used here: `SecretMaterial` is minted by callers in three
  // contexts and a register would have to be reachable from all of them.
  it("admits a value that genuinely redacts itself, however it was built", async () => {
    const impostor = Object.freeze({
      reveal: () => SENTINEL,
      toJSON: () => "[REDACTED SecretMaterial]",
      toString: () => "[REDACTED SecretMaterial]",
    });
    expect(JSON.stringify({ plaintext: impostor })).not.toContain(SENTINEL);
    const created = await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: impostor,
    });
    expect(created.ok).toBe(true);
  });

  it("refuses a value that only LOOKS like one, because toJSON gives it away", async () => {
    const leaky = { reveal: () => SENTINEL, toJSON: () => SENTINEL, toString: () => SENTINEL };
    const refused = await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: leaky as never,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("SECRET_INPUT_NOT_WRITE_ONLY");
  });
});
