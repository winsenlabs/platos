// The proof that an error `Result` cannot commit.
//
// THE DOUBLE BELOW IS A REAL UNIT OF WORK, NOT A SPY. It holds a row list, takes
// a snapshot on the way into a transaction and RESTORES that snapshot when the
// callback rejects — the same shape `packages/adapters/outbox/src/in-memory.ts`
// had to be given after `conversations` shipped a double that did not roll back
// and certified a settlement that never landed. A spy that only recorded whether
// `run` rejected would go green against the very defect these cases exist to
// catch: the bug was never in the rejection, it was that there WAS no rejection,
// and only something that actually keeps and discards writes can tell the
// difference.
//
// JOINING IS MODELLED TOO, because the nested guarantee is weaker than the
// outermost one and a suite that only ever opened one transaction would state
// the strong guarantee and prove the weak one.

import { describe, expect, it } from "vitest";

import { asIdentifier } from "../vo/identifier.js";
import type { TransactionId } from "../vo/identifier.js";
import { domainError, err, ok } from "../vo/error.js";
import type { Result } from "../vo/error.js";
import type { NotResult, TransactionScope, UnitOfWork } from "./unit-of-work.js";
import {
  isTransactionAbort,
  runResult,
  TRANSACTION_ABORT_BRAND,
} from "./unit-of-work.js";

interface RecordingUnitOfWork extends UnitOfWork {
  /** Rows that actually committed, in write order. */
  committed(): readonly string[];
  /** Write inside the open transaction. Refuses outside one, as a store would. */
  write(row: string): void;
  readonly opened: () => number;
  readonly rolledBack: () => number;
}

function recordingUnitOfWork(): RecordingUnitOfWork {
  let rows: string[] = [];
  let depth = 0;
  let opened = 0;
  let rolledBack = 0;
  let counter = 0;

  const unitOfWork: RecordingUnitOfWork = {
    async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
      counter += 1;
      const scope: TransactionScope = {
        transactionId: asIdentifier<TransactionId>(`memory-txn-${String(counter)}`),
      };
      if (depth > 0) {
        // JOIN. No second transaction, and therefore no second boundary to roll
        // back to — which is exactly why the nested guarantee is the weaker one.
        return await work(scope);
      }
      opened += 1;
      const snapshot = [...rows];
      depth += 1;
      try {
        return await work(scope);
      } catch (cause) {
        rows = snapshot;
        rolledBack += 1;
        throw cause;
      } finally {
        depth -= 1;
      }
    },
    committed: () => [...rows],
    write: (row: string) => {
      if (depth === 0) throw new Error("a write must run inside a transaction");
      rows.push(row);
    },
    opened: () => opened,
    rolledBack: () => rolledBack,
  };
  return unitOfWork;
}

const FAILURE = domainError("FAN_OUT_FAILED", "unavailable", "the alert fan-out could not be written");

describe("runResult commits an ok answer", () => {
  it("returns the value the work produced", async () => {
    const unitOfWork = recordingUnitOfWork();
    const outcome = await runResult(unitOfWork, async (transaction) => {
      unitOfWork.write(`event:${transaction.transactionId}`);
      return ok(7);
    });
    expect(outcome).toEqual({ ok: true, value: 7 });
  });

  it("keeps everything the work wrote", async () => {
    const unitOfWork = recordingUnitOfWork();
    await runResult(unitOfWork, async () => {
      unitOfWork.write("threshold-event");
      unitOfWork.write("delivery");
      return ok(null);
    });
    expect(unitOfWork.committed()).toEqual(["threshold-event", "delivery"]);
  });

  it("opens exactly one transaction", async () => {
    const unitOfWork = recordingUnitOfWork();
    await runResult(unitOfWork, async () => ok("done"));
    expect(unitOfWork.opened()).toBe(1);
    expect(unitOfWork.rolledBack()).toBe(0);
  });

  it("carries an undefined value through without inventing one", async () => {
    const unitOfWork = recordingUnitOfWork();
    const outcome = await runResult<void>(unitOfWork, async () => ok(undefined));
    expect(outcome).toEqual({ ok: true, value: undefined });
  });
});

describe("the cost-monitoring shape: an error Result must not commit", () => {
  it("rolls back everything the work wrote before it failed", async () => {
    const unitOfWork = recordingUnitOfWork();
    const outcome = await runResult(unitOfWork, async () => {
      unitOfWork.write("threshold-event");
      return err(FAILURE);
    });
    expect(outcome.ok).toBe(false);
    // THE ASSERTION THE SHIPPED DEFECT WOULD HAVE FAILED. `detect-crossings`
    // committed the crossing and lost the fan-out; here the crossing is gone.
    expect(unitOfWork.committed()).toEqual([]);
  });

  it("counts the rollback rather than a quiet resolve", async () => {
    const unitOfWork = recordingUnitOfWork();
    await runResult(unitOfWork, async () => err(FAILURE));
    expect(unitOfWork.rolledBack()).toBe(1);
  });

  it("returns the SAME error value, so a caller can match on its code", async () => {
    const unitOfWork = recordingUnitOfWork();
    const outcome = await runResult(unitOfWork, async () => err(FAILURE));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe(FAILURE);
    expect(outcome.error.code).toBe("FAN_OUT_FAILED");
  });

  it("rolls back a partial write even when the failure arrives last", async () => {
    const unitOfWork = recordingUnitOfWork();
    await runResult(unitOfWork, async () => {
      unitOfWork.write("row-1");
      unitOfWork.write("row-2");
      unitOfWork.write("row-3");
      return err(FAILURE);
    });
    expect(unitOfWork.committed()).toEqual([]);
  });

  it("leaves an earlier committed transaction alone", async () => {
    const unitOfWork = recordingUnitOfWork();
    await runResult(unitOfWork, async () => {
      unitOfWork.write("kept");
      return ok(null);
    });
    await runResult(unitOfWork, async () => {
      unitOfWork.write("discarded");
      return err(FAILURE);
    });
    expect(unitOfWork.committed()).toEqual(["kept"]);
  });
});

describe("a thrown defect is not a business failure", () => {
  it("propagates a genuine exception instead of turning it into an err", async () => {
    const unitOfWork = recordingUnitOfWork();
    await expect(
      runResult(unitOfWork, async () => {
        throw new TypeError("a real defect");
      }),
    ).rejects.toThrow(TypeError);
  });

  it("still rolls back when the work throws", async () => {
    const unitOfWork = recordingUnitOfWork();
    await expect(
      runResult(unitOfWork, async () => {
        unitOfWork.write("row");
        throw new TypeError("a real defect");
      }),
    ).rejects.toThrow(TypeError);
    expect(unitOfWork.committed()).toEqual([]);
  });

  it("does not swallow an object that merely carries the brand string", async () => {
    // A DECODED ROW COULD CARRY THE BRAND. Without the `error.code` check in
    // `isTransactionAbort` this would be caught, `err(undefined)` returned, and
    // the crash moved to the caller's first `error.code` read.
    const unitOfWork = recordingUnitOfWork();
    await expect(
      runResult(unitOfWork, async () => {
        throw { brand: TRANSACTION_ABORT_BRAND, error: { message: "no code" } };
      }),
    ).rejects.toMatchObject({ brand: TRANSACTION_ABORT_BRAND });
  });
});

describe("isTransactionAbort discriminates exactly", () => {
  it("accepts the carrier runResult throws", () => {
    expect(isTransactionAbort({ brand: TRANSACTION_ABORT_BRAND, error: FAILURE })).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string carrying the brand", TRANSACTION_ABORT_BRAND],
    ["a number", 7],
    ["an Error", new Error("boom")],
    ["an object with no brand", { error: FAILURE }],
    ["an object with the wrong brand", { brand: "other", error: FAILURE }],
    ["an object whose error is null", { brand: TRANSACTION_ABORT_BRAND, error: null }],
    ["an object whose error has no code", { brand: TRANSACTION_ABORT_BRAND, error: {} }],
    ["an object whose code is not a string", { brand: TRANSACTION_ABORT_BRAND, error: { code: 7 } }],
  ])("refuses %s", (_label, value) => {
    expect(isTransactionAbort(value)).toBe(false);
  });

  it("names the brand in Platos terms so two copies of this module agree", () => {
    // A SYMBOL WOULD FAIL OPEN. Two resolved copies of @platos/kernel in one
    // process — the ordinary state of a workspace mid-migration — would mint two
    // symbols, and an abort thrown by one would be rethrown as a defect by the
    // other. The literal is the pin.
    expect(TRANSACTION_ABORT_BRAND).toBe("platos.kernel.unit-of-work.abort");
  });
});

describe("the joined frame, whose guarantee is the weaker one", () => {
  it("hands the inner error back as a value without opening a second transaction", async () => {
    const unitOfWork = recordingUnitOfWork();
    let seen: Result<number> | null = null;
    await runResult(unitOfWork, async () => {
      seen = await runResult(unitOfWork, async () => err<number>(FAILURE));
      return ok(null);
    });
    expect(seen).toEqual({ ok: false, error: FAILURE });
    expect(unitOfWork.opened()).toBe(1);
  });

  it("commits the outer transaction when the outer frame swallows the inner error", async () => {
    // THE HONEST HALF OF THE CONTRACT. Swallowing is a decision a reader can
    // see at the call site, and a mechanism that overrode it would make a
    // tolerated partial failure unexpressible.
    const unitOfWork = recordingUnitOfWork();
    await runResult(unitOfWork, async () => {
      unitOfWork.write("outer");
      await runResult(unitOfWork, async () => err<number>(FAILURE));
      return ok(null);
    });
    expect(unitOfWork.committed()).toEqual(["outer"]);
  });

  it("discards everything when the outer frame propagates the inner error", async () => {
    const unitOfWork = recordingUnitOfWork();
    const outcome = await runResult(unitOfWork, async () => {
      unitOfWork.write("outer");
      const inner = await runResult(unitOfWork, async () => {
        unitOfWork.write("inner");
        return err<number>(FAILURE);
      });
      if (!inner.ok) return err<null>(inner.error);
      return ok(null);
    });
    expect(outcome).toEqual({ ok: false, error: FAILURE });
    expect(unitOfWork.committed()).toEqual([]);
    expect(unitOfWork.rolledBack()).toBe(1);
  });
});

describe("NotResult states the rule at the type level", () => {
  it("collapses a Result to never and leaves everything else alone", () => {
    // Compile-time assertions, kept executable so a deleted line is a red case
    // rather than an unread comment.
    const accepted: NotResult<number> = 7;
    const record: NotResult<{ id: string }> = { id: "a" };
    const refused: NotResult<Result<number>> extends never ? true : false = true;
    expect([accepted, record.id, refused]).toEqual([7, "a", true]);
  });

  it("refuses both arms of a Result, not merely the failing one", () => {
    const okArm: NotResult<{ readonly ok: true; readonly value: number }> extends never
      ? true
      : false = true;
    const errArm: NotResult<{ readonly ok: false; readonly error: string }> extends never
      ? true
      : false = true;
    expect([okArm, errArm]).toEqual([true, true]);
  });
});
