# Integrations audit (Theme R.5)

**Status:** Audit complete. The top-level `integrations/` directory was removed from the monorepo as part of Theme R.4 cleanup — no code inside was actively imported by `apps/webapp`, `apps/agent`, or any `packages/*` consumer.

## What was there

The upstream trigger.dev project shipped a `references/` and an `integrations/` folder containing sample tasks that demonstrated third-party APIs (OpenAI, Resend, Supabase, Stripe, etc.). These were example code, not runtime dependencies.

## What was removed

- `integrations/` — fully deleted
- `references/` — dropped from `pnpm-workspace.yaml` (Theme R.4) and also removed from disk

## What remains and why

- **`@trigger.dev/sdk`** — external published SDK used for durable task definitions and runtime operations.
- **`@platosdev/client`** (`packages/platos-client`) — Platos REST/WebSocket client surface.
- **`@platos/core`** (`packages/core`) — shared primitives. Retained, renamed from `@trigger.dev/core`.
- **Webhooks / OAuth infrastructure** (not in `integrations/`, lives in `apps/webapp/app/services/`) — retained because it's actively wired into the dashboard (e.g. Slack alerts, Resend email delivery).

## Future integrations path

Platos does not ship bundled third-party integrations. Instead, the [tool gateway](../tool-gateway.md) lets entities register any API as an MCP tool from their own backend via `@platos/platools`. This is the intended surface for integrations — the user codebase owns the integration, Platos just federates the contract.

## Decision

The inherited vendored build/SDK cluster was subsequently retired under WIN-253. The external Trigger SDK and protected Platos client remain the supported integration surfaces.
