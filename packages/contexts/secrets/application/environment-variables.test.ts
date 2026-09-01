import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { listEnvironmentVariables, readEnvironmentVariable } from "./environment-variable-reads.js";
import {
  deleteEnvironmentVariable,
  setEnvironmentVariable,
} from "./environment-variable-writes.js";

let context: InMemorySecrets;
let grants: InMemoryGrants;

beforeEach(() => {
  context = inMemorySecrets();
  grants = inMemoryGrants();
});

async function setSecret(key: string, value: string): Promise<void> {
  unwrap(
    await setEnvironmentVariable(context.dependencies, {
      authorization: grants.operator,
      key,
      value,
      secret: true,
    }),
  );
}

describe("a PLAIN variable keeps its own value", () => {
  it("stores and reads it back", async () => {
    const stored = unwrap(
      await setEnvironmentVariable(context.dependencies, {
        authorization: grants.operator,
        key: "LOG_LEVEL",
        value: "debug",
        secret: false,
      }),
    );
    expect(stored).toMatchObject({ kind: "PLAIN", value: "debug", hasSecret: false, version: 1 });

    const read = unwrap(
      await readEnvironmentVariable(context.dependencies, {
        authorization: grants.runtime,
        key: "LOG_LEVEL",
      }),
    );
    expect(read).toEqual({ kind: "PLAIN", value: "debug" });
  });

  it("bumps the version on every write", async () => {
    for (const value of ["a", "b", "c"]) {
      await setEnvironmentVariable(context.dependencies, {
        authorization: grants.operator,
        key: "LOG_LEVEL",
        value,
        secret: false,
      });
    }
    expect(context.store.allVariables()[0]?.version).toBe(3);
  });
});

describe("a SECRET variable stores nothing readable of its own", () => {
  it("puts the material in a SECRET_REFERENCE credential and leaves the row empty", async () => {
    await setSecret("OPENAI_API_KEY", "sk-live-1");

    const variable = context.store.allVariables()[0];
    expect(variable).toMatchObject({ kind: "SECRET", value: null });
    expect(variable?.credentialId).not.toBeNull();
    expect(JSON.stringify(context.store.allVariables())).not.toContain("sk-live-1");

    const credential = context.store.allCredentials()[0];
    expect(credential).toMatchObject({ kind: "SECRET_REFERENCE", name: "OPENAI_API_KEY" });
  });

  it("reads back through the runtime-only secret path", async () => {
    await setSecret("OPENAI_API_KEY", "sk-live-1");
    const read = unwrap(
      await readEnvironmentVariable(context.dependencies, {
        authorization: grants.runtime,
        key: "OPENAI_API_KEY",
      }),
    );
    expect(read.kind).toBe("SECRET");
    if (read.kind === "SECRET") expect(read.material.reveal()).toBe("sk-live-1");
  });

  it("ROTATES the backing credential rather than minting a second one", async () => {
    await setSecret("OPENAI_API_KEY", "sk-live-1");
    await setSecret("OPENAI_API_KEY", "sk-live-2");

    expect(context.store.allCredentials()).toHaveLength(1);
    expect(context.store.allVersions().map((entry) => entry.secretRevision).sort()).toEqual([1, 2]);
    const read = unwrap(
      await readEnvironmentVariable(context.dependencies, {
        authorization: grants.runtime,
        key: "OPENAI_API_KEY",
      }),
    );
    if (read.kind === "SECRET") expect(read.material.reveal()).toBe("sk-live-2");
  });

  it("commits the variable, the credential, the envelope and both audits as ONE transaction", async () => {
    await setSecret("OPENAI_API_KEY", "sk-live-1");
    expect(context.unitOfWork.commits()).toBe(1);
    expect(context.unitOfWork.rollbacks()).toBe(0);
  });

  it("rolls EVERYTHING back when the credential audit fails", async () => {
    context.store.failNextAudit();
    const failed = await setEnvironmentVariable(context.dependencies, {
      authorization: grants.operator,
      key: "OPENAI_API_KEY",
      value: "sk-live-1",
      secret: true,
    });
    expect(failed.ok).toBe(false);
    expect(context.store.allVariables()).toHaveLength(0);
    expect(context.store.allCredentials()).toHaveLength(0);
    expect(context.store.allVersions()).toHaveLength(0);
  });
});

describe("dropping the secret drops the material behind it", () => {
  it("revokes the credential when a SECRET becomes PLAIN", async () => {
    await setSecret("OPENAI_API_KEY", "sk-live-1");
    await setEnvironmentVariable(context.dependencies, {
      authorization: grants.operator,
      key: "OPENAI_API_KEY",
      value: "not-a-secret",
      secret: false,
    });

    expect(context.store.allCredentials()[0]?.revokedAt).not.toBeNull();
    const read = unwrap(
      await readEnvironmentVariable(context.dependencies, {
        authorization: grants.runtime,
        key: "OPENAI_API_KEY",
      }),
    );
    expect(read).toEqual({ kind: "PLAIN", value: "not-a-secret" });
  });

  it("revokes the credential when the variable is deleted", async () => {
    await setSecret("OPENAI_API_KEY", "sk-live-1");
    const removed = unwrap(
      await deleteEnvironmentVariable(context.dependencies, {
        authorization: grants.operator,
        key: "OPENAI_API_KEY",
      }),
    );
    expect(removed).toEqual({ deleted: true, key: "OPENAI_API_KEY" });
    expect(context.store.allVariables()).toHaveLength(0);
    expect(context.store.allCredentials()[0]?.revokedAt).not.toBeNull();
  });

  it("reports a no-op delete without inventing a failure", async () => {
    const removed = unwrap(
      await deleteEnvironmentVariable(context.dependencies, {
        authorization: grants.operator,
        key: "ABSENT_KEY",
      }),
    );
    expect(removed).toEqual({ deleted: false, key: "ABSENT_KEY" });
  });
});

describe("access rules carry over unchanged", () => {
  it("DENIES a write from a read-only operator grant", async () => {
    const denied = await setEnvironmentVariable(context.dependencies, {
      authorization: grants.readOnlyOperator,
      key: "LOG_LEVEL",
      value: "debug",
      secret: false,
    });
    expect(denied.ok).toBe(false);
    expect(context.store.allVariables()).toHaveLength(0);
  });

  it("DENIES a read from anything but the runtime tier", async () => {
    await setSecret("OPENAI_API_KEY", "sk-live-1");
    for (const authorization of [grants.operator, grants.readOnlyOperator, grants.service]) {
      const denied = await readEnvironmentVariable(context.dependencies, {
        authorization,
        key: "OPENAI_API_KEY",
      });
      expect(denied.ok).toBe(false);
    }
  });

  it("lists metadata only, for any minted grant", async () => {
    await setSecret("OPENAI_API_KEY", "sk-live-1");
    await setEnvironmentVariable(context.dependencies, {
      authorization: grants.operator,
      key: "LOG_LEVEL",
      value: "debug",
      secret: false,
    });

    const listed = unwrap(await listEnvironmentVariables(context.dependencies, grants.readOnlyOperator));
    expect(listed.map((entry) => entry.key)).toEqual(["LOG_LEVEL", "OPENAI_API_KEY"]);
    expect(listed.find((entry) => entry.key === "OPENAI_API_KEY")).toMatchObject({
      value: null,
      hasSecret: true,
    });
    expect(JSON.stringify(listed)).not.toContain("sk-live-1");
  });

  it("refuses a malformed key and an empty value before writing anything", async () => {
    const badKey = await setEnvironmentVariable(context.dependencies, {
      authorization: grants.operator,
      key: "lowercase",
      value: "x",
      secret: false,
    });
    const badValue = await setEnvironmentVariable(context.dependencies, {
      authorization: grants.operator,
      key: "LOG_LEVEL",
      value: "",
      secret: false,
    });
    expect(badKey.ok).toBe(false);
    expect(badValue.ok).toBe(false);
    expect(context.store.allVariables()).toHaveLength(0);
  });

  it("reports an unknown key as unavailable", async () => {
    const refused = await readEnvironmentVariable(context.dependencies, {
      authorization: grants.runtime,
      key: "ABSENT_KEY",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("ENVIRONMENT_VARIABLE_UNAVAILABLE");
  });
});
