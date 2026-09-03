// Driven ports this context needs, and the adapter-facing port it OWNS.
//
// `ChannelAdapter` is published from here rather than from the kernel: ADR M0.3
// §13 assigns it to `channels`, and `packages/adapters/channel-slack` has
// exactly one import edge, to this entrypoint. `ChannelsRepository` is the
// canonical-store port behind which this context's sole-writer ownership of
// `ChannelConnection`, `ChannelThread`, `ChannelApp`, `ChannelInstallation`,
// `ChannelAppThread` and `ChannelEventInbox` is realised.
//
// The three reader ports beside them — `ChannelCredentialReader`,
// `AgentDirectory` and `ChannelEventCipher` — exist because the §1 DAG grants
// `channels` only `tenancy`, `identity-access` and the kernel. Each is the
// narrow question this context needs answered by a context it may not import
// (reader-port inversion, ADR M0.3 §2), wired at the composition root.
//
// Implemented under `packages/adapters/*`, wired in `apps/core-api`, never
// imported by `domain/` (ADR M0.3 §2).
export * from "./channel-adapter.js";
export * from "./channels-repository.js";
