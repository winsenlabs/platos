# AI SDK v6 → v7 Upgrade — Plan & Decision Brief

_Status: researched, NOT yet built. Awaiting a go/no-go on the ESM re-platform (see §6)._

## 0. TL;DR

- Platos is **already on `ai@6.0.172`** (not v4/v5 as earlier assumed). The v6→v7 **code** changes are small and mostly codemod-automated (~1–2 hrs).
- **The real cost is not the code — it's that AI SDK v7 is ESM-only and requires Node 22+.** `apps/agent` (NestJS) is **CommonJS on Node 20**; converting it to ESM is a genuine mini-project with real risk to the whole runtime. `apps/webapp` (Remix) builds server-CJS — lower effort.
- **v7 may not be required at all.** v6 already exposes every primitive the Trigger Sessions migration needs (`toUIMessageStream`, `Output.object`, the `UIMessageChunk` shape). The deciding factor is whether Trigger v4.5's `chat.agent`/sessions expects a specific AI SDK version — and since the agent-loop task code is Platos-authored and Platos pins its own `ai` version there, v6 is very likely fine.
- **Recommendation:** do NOT smuggle an ESM re-platform into "an SDK bump." Either (A) stay on v6 for the Sessions work and schedule ESM+v7 as its own tested project later, or (B) commit to the ESM migration as a deliberate project up front. **There is no safe partial build** — v7 can't `require()` into a CJS runtime, so it's all-or-nothing.

## 1. Ground truth (current state)

| Package | Declared | Resolved | Where |
|---|---|---|---|
| `ai` | `^6.0.172` | 6.0.172 | agent, webapp, packages/core (dev) |
| `@ai-sdk/anthropic` | `^3.0.73` | 3.0.73 | agent |
| `@ai-sdk/openai` | `^3.0.55` | 3.0.55 | agent, webapp |
| `@ai-sdk/google` | `^3.0.66` | 3.0.66 | agent |
| `@ai-sdk/google-vertex` | `^4.0.113` | 4.0.113 | agent |
| `@ai-sdk/provider-utils` | `^4.0.25` | 4.0.25 | packages/core (dev) |

- **apps/agent** — CommonJS (`tsconfig.module=commonjs`, `nest build`, runtime `require()` e.g. `shared/database.provider.ts`). Node 20 (`node:20-slim`).
- **apps/webapp** — Remix `serverModuleFormat: "cjs"`, Node 20 (`node:20.20-bullseye-slim`). engines `>=18.19 || >=20.6`.
- **packages/core** — ESM (`type:module`, tshy dual build); uses `ai` for **types only** (devDep). No blocker.
- **Client:** Platos does NOT use `@ai-sdk/react`. It has its own `useAgentStream` protocol. No client-side AI SDK migration.

## 2. The AI SDK surface (what actually touches the SDK)

- **`apps/agent/src/agent-runtime/agent.service.ts`** — the main consumer:
  - `streamText` (5702) with `stopWhen: stepCountIs`, `allowSystemInMessages`, `onStepFinish`, `onFinish`, `abortSignal`.
  - `result.fullStream` switch (5800–5995): `text-delta`, `tool-call`, `finish-step`, `reasoning-delta`, `finish`, `source`, `file`, `tool-result`, `tool-error`, `tool-output-denied`, `abort`, `error`.
  - Usage parsing (5730–5761, 5906): `usage.inputTokenDetails.cacheReadTokens/cacheWriteTokens`, `usage.outputTokenDetails.reasoningTokens`, `finish` part `totalUsage`, + provider-metadata fallback chain.
  - Sub-agent `generateText` (4269) with usage summing (4290).
  - `streamObject` (5505) + `generateObject` retry (5567).
  - Anthropic `providerOptions.anthropic.cacheControl` (4253, 5198, 5419).
  - Model construction `resolveModel` (210–309): `createAnthropic/createOpenAI/createGoogleGenerativeAI/createVertex`.
- **`apps/agent/src/{evals,memory}/*.service.ts`** — `generateText` judge calls.
- **`apps/webapp/app/v3/*`** — `generateText`+`Output.object`+`tool`+`stepCountIs`+`experimental_telemetry` (aiRunFilter), `generateText` (aiQueryTitle), `generateObject` (humanToCron).
- **`packages/core/src/v3/types/tools.ts`** — `type Schema` only.

## 3. Code changes for v7 (the easy part — mostly codemod)

Run: `npx @ai-sdk/codemod v7` (per workspace that imports `ai`).

Codemod-handled renames that apply here:
- `fullStream` → `stream` (`rename-full-stream-to-stream`) — alias still works, but rename.
- `onFinish` → `onEnd`, `onStepFinish` → `onStepEnd` (agent 5717/5789; streamObject onFinish).
- `stepCountIs` → `isStepCount` (agent 5712; webapp aiRunFilter).
- `system` → `instructions` (sub-agent 4269; webapp services; humanToCron).
- `experimental_telemetry` → `telemetry` (webapp) — plus register OTel globally via `@ai-sdk/otel` (telemetry is now on-by-default).
- `replace-anthropic-cache-creation-input-tokens` — check `cacheWriteTokens` usage (agent 5747).

Manual verification after codemod (**cost-critical**, do NOT skip):
1. **`finish` stream part `totalUsage`** (agent.service.ts:5906) — confirm v7 still carries `totalUsage` on the stream `finish` part. If renamed, `inputTokens/outputTokens` → `undefined` → **cost silently becomes 0**. Add a real-turn assertion.
2. **`result.usage` semantic flip** — v7: `result.usage` = **all steps** (was final step); `result.finalStep.usage` = final. Audit the sub-agent usage summing (agent 4290) so it doesn't **double-count** now that `result.usage` is already the total.
3. **Anthropic cache field names** — confirm `usage.inputTokenDetails.cacheWriteTokens` is still the v7 field for cache-creation (vs a rename).
4. **Google provider** — confirm `createGoogleGenerativeAI` factory still valid (v7 renamed the `GoogleGenerativeAI` type → `Google`).
5. `allowSystemInMessages: true` (agent 5709) — still valid v7 opt-in; keep it (system prompt rides in `messages[]` for per-message cacheControl).

## 4. The real work (ESM + Node 22 — the hard part)

1. **Node 20 → 22:** `apps/agent/Dockerfile`, `apps/webapp/Dockerfile.platos`, `.nvmrc`, webapp `engines`. Rebuild + smoke.
2. **`apps/agent` CommonJS → ESM (the risk center):** add `"type":"module"`, `tsconfig module` → `nodenext`/`esnext`, replace runtime `require()` (`shared/database.provider.ts` + any others) with imports or `await import()`, verify `reflect-metadata` + Nest decorators + DI under ESM, fix `__dirname`→`import.meta.url`, and check every transitive dep has an ESM build. NestJS-on-ESM is doable but fiddly; this is where the schedule risk lives.
3. **`apps/webapp`:** flip Remix `serverModuleFormat: "cjs"` → `"esm"`; verify server bundle + Express boot.
4. **Provider bumps** (verify exact latest at build time): `@ai-sdk/anthropic ^4`, `@ai-sdk/openai ^4`, `@ai-sdk/google ^4`, `@ai-sdk/google-vertex ^5`, `@ai-sdk/provider-utils ^5`.
5. **Verify:** full Docker build (the real typecheck) + smoke every model path — Anthropic w/ prompt cache, OpenAI, Google, Vertex, reasoning model, structured output, sub-agent delegation — and confirm cost numbers land correctly (see §3 manual checks).

## 5. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| NestJS agent CJS→ESM destabilizes the runtime | **HIGH** | Own branch; full smoke of every entrypoint before merge |
| Cost accounting breaks silently (usage flip / finish `totalUsage`) | **MEDIUM** | Explicit real-turn token assertions pre/post |
| A transitive dep is CJS-only (no ESM build) | **MEDIUM** | Audit before starting; `await import()` interop as escape hatch |
| Node 22 behavior differences | **LOW-MED** | CI + smoke on 22 before prod |

## 6. Recommendation & the decision needed

**Is v7 actually required?** The only reason we wanted it was to unblock the Trigger Sessions migration — but Platos is on **v6, which already has `toUIMessageStream`, `Output.object`, and the `UIMessageChunk` shape**. The agent-loop task deployed to Trigger is Platos-authored and pins its own `ai` version, so v6 is very likely sufficient. **→ Confirm: does Trigger v4.5 `chat.agent`/sessions require AI SDK v7, or does v6 work?** That single answer decides everything.

- **If v6 works with Trigger (expected):** **stay on v6.** The Sessions migration proceeds unblocked. Do the ESM + Node-22 + v7 upgrade later as its own deliberate, tested project — or defer it until something actually forces it. Demote "v7 first" in the master plan.
- **If Trigger forces v7:** the ESM migration becomes mandatory and should be its **own first project** (own branch, full smoke), completed and verified **before** the Sessions work — not bundled into it.

**Either way: this is an ESM re-platform, not a codemod bump. Don't build it blind.**
