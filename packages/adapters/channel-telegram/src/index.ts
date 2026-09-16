// The `channel-telegram` adapter's published surface.
//
// A CONSTRUCTOR AND ITS TYPES, and nothing else — the containment
// `channel-slack/src/index.ts` states for its own directory and every channel
// directory since repeats. `apps/core-api` is the only package permitted to
// import this one (boundary rule (j)), and it needs exactly these names to fill
// the `channel-telegram` slot in `ADAPTER_BINDINGS`. The verifier, the
// constant-time comparison, the normalizer, the rate-limit windows and the far
// side are implementation details whose only consumers are this package's own
// suites.
export { createChannelTelegramAdapter } from "./adapter.js";
export type { ChannelTelegramAdapter, ChannelTelegramOptions } from "./adapter.js";
