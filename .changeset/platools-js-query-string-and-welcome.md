---
"@platosdev/platools-sdk": patch
---

Fix two transport-layer bugs in the TS SDK that have shipped since 0.2.0:

- `PlatoolsClient.websocketUrl()` raw-concatenated `/ws/sdk` to the URL,
  corrupting query strings: `wss://play.platos.dev/tools/sync?env=prod`
  became `…?env=prod/ws/sdk`, which the server parsed as `env="prod/ws/sdk"`
  and rejected with `could not resolve env for entity`. The suffix is now
  inserted before the query string (mirrors the fix already carried in
  fandesk's vendored Python SDK).

- `decodePlatformMessage` only accepted the legacy `welcome.org_id`
  field; the agent emits `welcome.organization_id` (plus `entity_id`,
  `environment_id`, `project_id`). The decoder now accepts either shape,
  exposes the canonical `organization_id`, keeps `org_id` as a
  back-compat alias, and surfaces the additional ids. Eliminates the
  `platools received malformed message` warn on every connect.

Regression tests added in `tests/transport.test.ts`.
