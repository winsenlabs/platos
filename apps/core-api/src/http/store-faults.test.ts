import { describe, expect, it } from "vitest";

import { isStoreUnavailableFault, STORE_UNAVAILABLE_REQUEST_CODES } from "./store-faults.js";

/** A thrown value shaped as the database client shapes its request errors. */
function requestError(code: string): Error {
  return Object.assign(new Error("Invalid `operatorSession.findUnique()` invocation"), {
    name: "PrismaClientKnownRequestError",
    code,
    meta: { modelName: "OperatorSession" },
    clientVersion: "6.14.0",
  });
}

describe("which thrown values mean the store did not answer", () => {
  it("recognises every request-error code in the closed set", () => {
    // P1008 is the one measured through the process against a paused server:
    // the 20-second socket deadline. The others are the same outage seen at a
    // different moment — unreachable, slow to accept, closed, pool exhausted.
    expect([...STORE_UNAVAILABLE_REQUEST_CODES].sort()).toEqual(["P1001", "P1002", "P1008", "P1017", "P2024"]);
    for (const code of STORE_UNAVAILABLE_REQUEST_CODES) {
      expect(isStoreUnavailableFault(requestError(code)), code).toBe(true);
    }
  });

  it("recognises the client failing to open a connection, which carries no code", () => {
    const refused = Object.assign(new Error("Can't reach database server"), {
      name: "PrismaClientInitializationError",
      errorCode: undefined,
      clientVersion: "6.14.0",
    });
    expect(isStoreUnavailableFault(refused)).toBe(true);
  });

  it("leaves every other request error a defect", () => {
    // A unique violation that escaped its repository, a record-not-found fence,
    // a raw query failure: each is a 500 somebody must look at.
    for (const code of ["P2002", "P2003", "P2025", "P2010"]) {
      expect(isStoreUnavailableFault(requestError(code)), code).toBe(false);
    }
  });

  it("does not trust a code without the client's error name, nor a name without a code", () => {
    expect(isStoreUnavailableFault(Object.assign(new Error("x"), { code: "P1008" }))).toBe(false);
    expect(isStoreUnavailableFault(Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError" }))).toBe(false);
    expect(isStoreUnavailableFault(new TypeError("undefined is not a function"))).toBe(false);
    expect(isStoreUnavailableFault("P1008")).toBe(false);
    expect(isStoreUnavailableFault(null)).toBe(false);
  });
});
