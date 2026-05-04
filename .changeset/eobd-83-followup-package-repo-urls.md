---
"@platos/build": patch
"@platos/core": patch
"@platos/python": patch
"@platos/redis-worker": patch
"@platos/rsc": patch
"@platos/schema-to-json": patch
"@platos/sdk": patch
---

EOBD.83 follow-up — sweep `repository.url` on every @platos/* package from the inherited `triggerdotdev/trigger.dev` URL to `platos-dev/platos`. The engine-layer `trigger.dev` CLI (packages/cli-v3) is deliberately left intact per BR/BGO scope rules. No runtime change.
