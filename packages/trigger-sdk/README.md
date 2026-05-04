<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/a45d1fa2-0ae8-4a39-4409-f4f934bfae00/public">
  <source media="(prefers-color-scheme: light)" srcset="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/3f5ad4c1-c4c8-4277-b622-290e7f37bd00/public">
  <img alt="Trigger.dev logo" src="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/a45d1fa2-0ae8-4a39-4409-f4f934bfae00/public">
</picture>

[![npm version](https://img.shields.io/npm/v/@trigger.dev/sdk.svg)](https://www.npmjs.com/package/@trigger.dev/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@trigger.dev/sdk.svg)](https://www.npmjs.com/package/@trigger.dev/sdk)
[![GitHub stars](https://img.shields.io/github/stars/triggerdotdev/trigger.dev?style=social)](https://github.com/triggerdotdev/trigger.dev)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Open Source](https://img.shields.io/badge/Open%20Source-%E2%9D%A4-red)](https://github.com/triggerdotdev/trigger.dev)

[Website](https://platos.dev) | [Issues](https://github.com/platos-dev/platos/issues) | [Docs](https://platos.dev/docs) | [Upstream (trigger.dev)](https://trigger.dev)

</div>

# `@platos/sdk` — TypeScript SDK for Platos

The Platos SDK is a TypeScript/JavaScript library that lets you define and trigger background tasks
from your Platos agents and apps. It is the rebrand of the upstream `@trigger.dev/sdk` for the Platos
fork — engine-layer behavior is unchanged; the entrypoints, task lifecycle, and `defineConfig` API all
match upstream.

## About Platos

Platos is an open-source agent runtime that pairs the [trigger.dev](https://trigger.dev) durable
task engine with a real-time agent service (streaming, tool orchestration, HITL approvals,
multi-tenant tool matrices). Apache 2.0, self-hostable via `docker compose`. See [platos.dev/docs](https://platos.dev/docs)
for the full product docs.

## Core features

- Task creation and execution
- CLI for development and deployment
- Build system with extensions
- Management API for runs, schedules, and environment variables

## Key Components:

- Tasks: Background jobs written in TypeScript/JavaScript
- CLI: Commands for login, init, dev, deploy
- Build Extensions: Customize builds (Prisma, Python, FFmpeg, etc.)
- Management API: Programmatic control over runs and resources

## Getting started

Platos is self-hostable — there is no managed cloud. The fastest path is the OSS quickstart:

1. Boot Platos with the bundled compose file: see the [self-hosting guide](https://platos.dev/docs/self-hosting).
2. Open the dashboard at `http://localhost:3030`, create a project, and follow the
   [quickstart guide](https://platos.dev/guides/quickstart) to write your first task.

## SDK documentation

For more information on the SDK, refer to the [SDK docs](https://platos.dev/docs/sdks). The
underlying engine is `trigger.dev` — see [trigger.dev/docs](https://trigger.dev/docs) for engine
internals.

## Support

If you have any questions, file an issue on the [Platos repo](https://github.com/platos-dev/platos/issues).
