// ADR M0.3 §4/§13 kernel-hosted decoupling ports.
//
// This list is CLOSED at TEN. An adapter-facing port belongs to the context
// whose capability it serves and is published from that context's
// `application/ports` — it does not move here because its implementation happens
// to live under `packages/adapters/` (ADR M0.3 §13). Only genuinely
// cross-cutting decoupling ports are kernel-hosted.
//
// It was nine until WIN-260 (M2.5). `CorrelationSource` is the tenth, and it
// earns the place on the test the other nine pass: it belongs to NO context.
// Every context produces work a request identifier must follow, none of them
// decides anything with it, and the two ends that must agree — the process edge
// that mints it and the adapters that carry it to the store — are on opposite
// sides of the whole system. A port owned by any one context would have made the
// other sixteen depend on that context to be traceable.
export * from "./clock.js";
export * from "./id-generator.js";
export * from "./logger.js";
export * from "./unit-of-work.js";
export * from "./outbox-writer.js";
export * from "./event-bus.js";
export * from "./durable-runtime.js";
export * from "./safety-event-sink.js";
export * from "./erasure-target.js";
export * from "./correlation.js";
