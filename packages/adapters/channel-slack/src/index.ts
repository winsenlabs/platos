// The `channel-slack` adapter's published surface.
//
// A TYPE AND A CONSTRUCTOR, and nothing else. `apps/core-api` is the only
// package permitted to import this one (boundary rule (j)), it needs exactly
// these two names to fill the `channel-slack` slot in `ADAPTER_BINDINGS`, and
// every other symbol in this directory — the vendor re-exports, the verifier,
// the normalizer, the failure classifier, the transport — is an implementation
// detail whose only consumer is this package's own suites.
//
// PUBLISHING MORE WOULD DEFEAT THE CONTAINMENT. `vendor.ts` re-exports the chat
// SDK for this directory's internal use; re-exporting it from here would put a
// vendor type on an entry point the composition root imports, which is exactly
// what ADR M0.3 §5.1(h) and the `chat-sdk-only` boundary rule exist to prevent.
export { createChannelSlackAdapter } from "./adapter.js";
export type { ChannelSlackAdapter, ChannelSlackOptions } from "./adapter.js";
