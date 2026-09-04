// The `conversations` domain barrel.
//
// Pure domain: every module here imports its own siblings and `@platos/kernel`
// and nothing else (ADR M0.3 §2, enforced by `domain-purity` in
// scripts/arch/boundary-rules.mjs). No framework, no store, no peer contract, no
// inference SDK — the last of which is not a matter of taste here but a rule,
// `inference-sdk-only`, that would make this package unbuildable if broken.
//
// WHAT LIVES HERE, IN THE ORDER A TURN MEETS IT:
//
//   identifiers / errors / events / work-status   the vocabulary.
//   policy                                        every ceiling and kill switch.
//   thread / thread-fork / thread-compaction      the conversation and its shape.
//   turn / step / step-usage / step-rates         the exchange and its cost.
//   turn-cost                                     the one place a turn's money
//                                                 is computed, from steps only.
//   transcript                                    stored turns to model history.
//   tool-catalogue / tool-result                  what a turn may call, and what
//                                                 comes back.
//   sub-agent                                     delegation and its three caps.
//   attachment / structured-output                what goes in, what must come out.
//   postman-execution                             the operator-launched run.

export * from "./identifiers.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./work-status.js";
export * from "./policy.js";
export * from "./thread.js";
export * from "./thread-fork.js";
export * from "./thread-compaction.js";
export * from "./turn.js";
export * from "./turn-cost.js";
export * from "./step.js";
export * from "./step-usage.js";
export * from "./step-rates.js";
export * from "./transcript.js";
export * from "./tool-catalogue.js";
export * from "./tool-result.js";
export * from "./sub-agent.js";
export * from "./attachment.js";
export * from "./structured-output.js";
export * from "./postman-execution.js";

/**
 * Retained from the generated skeleton so no sibling placeholder breaks.
 *
 * The "aggregate" this context hands out is a THREAD — the row a conversation
 * is, and the one every other row here hangs off.
 */
export type { Thread as ConversationsAggregate } from "./thread.js";
