// The kernel ports, in memory.
//
// TIME IS A DIAL, NOT A CLOCK. `MutableClock` starts at a fixed instant and only
// moves when a test moves it, which is what turns "the last thirty days" from a
// range a test has to tolerate into a boundary it can pin to the millisecond.
//
// IDENTITY IS A COUNTER. Sequential ids, so a test can assert WHICH row came
// back rather than merely that one did.
//
// THE UNIT OF WORK IS REAL ENOUGH TO FAIL. It hands out a distinct transaction
// handle per run, joins a nested run to the outer one (the kernel port says
// nesting must not open a second transaction), and records whether the last run
// committed or rolled back — so "the write was rolled back" is a thing a test
// can assert rather than infer.
//
// THE LOGGER RECORDS. The safety sink's whole failure contract is "drop it and
// say so", and a logger that discarded the saying would make that untestable.

import type { Clock, IdGenerator, LogFields, LogLevel, Logger, TransactionScope, Ulid, UnitOfWork, Uuid } from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";

export class MutableClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date("2026-03-01T12:00:00.000Z")) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Move time forward. Negative input moves it back, which some tests want. */
  advanceMilliseconds(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  set(instant: Date): void {
    this.current = new Date(instant.getTime());
  }
}

export class SequentialIds implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = "id") {}

  uuid(): Uuid {
    this.counter += 1;
    return asIdentifier<Uuid>(`${this.prefix}-${String(this.counter).padStart(4, "0")}`);
  }

  ulid(): Ulid {
    this.counter += 1;
    return asIdentifier<Ulid>(`${this.prefix}-ulid-${String(this.counter).padStart(4, "0")}`);
  }
}

export class InMemoryUnitOfWork implements UnitOfWork {
  private depth = 0;
  private counter = 0;
  private open: TransactionScope | null = null;

  /** The outcome of the most recent OUTERMOST run. */
  lastOutcome: "committed" | "rolled-back" | null = null;

  async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
    if (this.open !== null) {
      // Nesting JOINS the outer transaction rather than opening a second one.
      this.depth += 1;
      try {
        return await work(this.open);
      } finally {
        this.depth -= 1;
      }
    }
    this.counter += 1;
    const transaction: TransactionScope = { transactionId: asIdentifier(`txn-${this.counter}`) };
    this.open = transaction;
    this.depth = 1;
    try {
      const value = await work(transaction);
      this.lastOutcome = "committed";
      return value;
    } catch (thrown) {
      this.lastOutcome = "rolled-back";
      throw thrown;
    } finally {
      this.open = null;
      this.depth = 0;
    }
  }

  /** How many outermost transactions have been opened. */
  get opened(): number {
    return this.counter;
  }
}

export interface RecordedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

export class RecordingLogger implements Logger {
  readonly lines: RecordedLog[] = [];

  constructor(private readonly bound: LogFields = {}) {}

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.lines.push({ level, message, fields: { ...this.bound, ...fields } });
  }

  child(fields: LogFields): Logger {
    const child = new RecordingLogger({ ...this.bound, ...fields });
    // Share the buffer so a test reads one list whichever handle wrote to it.
    Object.defineProperty(child, "lines", { value: this.lines });
    return child;
  }

  /** Every line at `level` carrying `message`. */
  matching(level: LogLevel, message: string): readonly RecordedLog[] {
    return this.lines.filter((line) => line.level === level && line.message === message);
  }
}
