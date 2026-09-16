// The `channel-whatsapp` adapter's published surface.
//
// A CONSTRUCTOR AND ITS TYPES, and nothing else — the containment
// `channel-slack/src/index.ts` states for its own directory and
// `channel-discord/src/index.ts` repeats for its own. `apps/core-api` is the only
// package permitted to import this one (boundary rule (j)), and it needs exactly
// these names to fill the `channel-whatsapp` slot in `ADAPTER_BINDINGS`. The
// verifier, the HMAC, the normalizer, the rate-limit windows, the RFC 4231
// vectors and the far side are implementation details whose only consumers are
// this package's own suites.
export { createChannelWhatsAppAdapter } from "./adapter.js";
export type { ChannelWhatsAppAdapter, ChannelWhatsAppOptions } from "./adapter.js";
export type { WhatsAppSubscriptionRequest, WhatsAppSubscriptionSecret } from "./verify.js";
