// The kernel ports, in memory, and the one that has a bug to avoid.
//
// THE UNIT OF WORK ROLLS BACK. That sentence is the whole reason this file has a
// header. A double whose `run` merely awaited its callback and returned the
// value has "nothing to roll back", so a use case that returned an error
// `Result` from inside a transaction still COMMITTED every write it had made —
// a live defect this programme shipped this week. This one takes a SNAPSHOT of
// the stores before the callback and restores it when the callback throws OR
// when it returns a `Result` that is not `ok`, which is the behaviour a real
// transaction has and the behaviour every use case here is written against.
//
// THE CLOCK IS FIXED AND ADVANCES ONLY WHEN A TEST SAYS SO. Latency, an expiry
// deadline and a compaction timestamp are all differences of two `now()` calls;
// a wall clock makes each of them a range rather than a number, and a range
// cannot be asserted exactly.
//
// THE ID GENERATOR IS A COUNTER. A random id makes a failing test unreproducible
// and makes an assertion about WHICH row was written impossible to write.

import type {
  Clock,
  DomainEventDraft,
  EventId,
  IdGenerator,
  JsonValue,
  LogFields,
  LogLevel,
  Logger,
  OutboxWriter,
  TransactionScope,
  Ulid,
  UnitOfWork,
  Uuid,
} from "@platos/kernel";

export class TestClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  set(at: Date): void {
    this.current = new Date(at);
  }
}

export class TestIds implements IdGenerator {
  private counter = 0;

  uuid(): Uuid {
    this.counter += 1;
    return `id-${this.counter}` as unknown as Uuid;
  }

  ulid(): Ulid {
    this.counter += 1;
    return `ulid-${this.counter}` as unknown as Ulid;
  }
}

/** What a transaction has to be able to undo. */
export interface Snapshottable {
  snapshot(): unknown;
  restore(state: unknown): void;
}

export class TestUnitOfWork implements UnitOfWork {
  /** How many transactions were opened. A pre-check refusal opens none. */
  transactions = 0;
  /** How many were rolled back. An error `Result` from inside counts. */
  rollbacks = 0;

  constructor(private readonly stores: readonly Snapshottable[] = []) {}

  async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
    this.transactions += 1;
    const before = this.stores.map((store) => store.snapshot());
    const rollBack = () => {
      this.rollbacks += 1;
      this.stores.forEach((store, index) => store.restore(before[index]));
    };

    let value: Value;
    try {
      value = await work({ transactionId: `txn-${this.transactions}` as never });
    } catch (error) {
      rollBack();
      throw error;
    }

    // A use case that returns an error `Result` from inside a transaction has
    // NOT succeeded, and a real transaction that committed it would leave the
    // writes it made behind. This is the case a naive double gets wrong.
    if (typeof value === "object" && value !== null && "ok" in value && value.ok === false) {
      rollBack();
    }
    return value;
  }
}

export class TestOutbox implements OutboxWriter {
  readonly appended: { name: string; payload: JsonValue; transactionId: string }[] = [];

  async append<Payload extends JsonValue>(
    event: DomainEventDraft<Payload>,
    transaction: TransactionScope,
  ): Promise<EventId> {
    this.appended.push({
      name: event.name,
      payload: event.payload,
      transactionId: String(transaction.transactionId),
    });
    return `event-${this.appended.length}` as unknown as EventId;
  }

  /** The names appended, in order. What a fan-out assertion reads. */
  names(): readonly string[] {
    return this.appended.map((entry) => entry.name);
  }
}

export class TestLogger implements Logger {
  readonly lines: { level: LogLevel; message: string; fields: LogFields }[] = [];

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.lines.push({ level, message, fields });
  }

  child(): Logger {
    return this;
  }
}
