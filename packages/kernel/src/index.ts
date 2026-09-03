// @platos/kernel — ADR M0.3 §4.
//
// The ONLY cross-cutting package. Port interfaces and pure value objects and
// nothing else: no service, no adapter, no vendor client, no business rule.
// `kernel-is-leaf` (scripts/arch/boundary-rules.mjs) enforces that it imports no
// context, no adapter and no infrastructure client, and
// scripts/arch/kernel-content.mjs enforces what it may contain.
export * from "./ports/index.js";
export * from "./vo/index.js";
