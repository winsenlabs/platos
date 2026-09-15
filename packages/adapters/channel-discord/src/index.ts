// The `channel-discord` adapter's published surface.
//
// A CONSTRUCTOR AND ITS TYPES, and nothing else — the containment
// `channel-slack/src/index.ts` states for its own directory. `apps/core-api` is
// the only package permitted to import this one (boundary rule (j)), and it needs
// exactly these names to fill the `channel-discord` slot in `ADAPTER_BINDINGS`.
// The verifier, the normalizer, the rate-limit windows and the far side are
// implementation details whose only consumers are this package's own suites.
export { createChannelDiscordAdapter } from "./adapter.js";
export type {
  ChannelDiscordAdapter,
  ChannelDiscordOptions,
  DiscordFollowup,
  DiscordInteractionReply,
} from "./adapter.js";
