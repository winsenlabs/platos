// ADR M0.3 §4/§13 kernel-hosted decoupling ports.
//
// This list is CLOSED at nine. An adapter-facing port belongs to the context
// whose capability it serves and is published from that context's
// `application/ports` — it does not move here because its implementation happens
// to live under `packages/adapters/` (ADR M0.3 §13). Only genuinely
// cross-cutting decoupling ports are kernel-hosted.
export * from "./clock.js";
export * from "./id-generator.js";
export * from "./logger.js";
export * from "./unit-of-work.js";
export * from "./outbox-writer.js";
export * from "./event-bus.js";
export * from "./durable-runtime.js";
export * from "./safety-event-sink.js";
export * from "./erasure-target.js";
