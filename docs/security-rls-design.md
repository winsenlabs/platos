# Platos RLS backstop — design & rollout (audit item 16)

> **Status: NEEDS-HUMAN.** Designed 2026-07-17 (Opus) as part of the security hardening.
> Deliberately NOT auto-applied: two blockers require infra/sequencing decisions only a human can own.
> RLS is the audit's "optional but highest defense-in-depth" layer — it holds even when a handler forgets its scope `where`.

## The two blockers (why this can't be autopiloted)

1. **The app connects as the Postgres SUPERUSER** (`POSTGRES_USER=postgres`). Superusers bypass RLS unconditionally; `FORCE ROW LEVEL SECURITY` does not change that. RLS is 100% inert until `DATABASE_URL` is cut over to a dedicated non-superuser role. **The enforcing migration would pass CI and change nothing in prod** — the classic "RLS looks done but does nothing" trap.
2. **No per-request scope context exists** for a Prisma `$extends` to read — zero AsyncLocalStorage/CLS in the agent, and the client is one global singleton used by 53 files. An ALS layer must be built and wired from ScopeGuard + the WS handshake + every trigger task first.

Plus: 4 bypass clients (trigger task's own PrismaClient, webapp main+replica, testcontainers) and the admin cross-scope sweeps would break/return-partial under enforcing RLS if not handled, and 7 existing `$transaction` callers can't nest the GUC wrapper.

**Do NOT apply the enforcing migration or the role cutover in an automated loop.** Follow the rollout below, staying in log-only until `no_guc` warnings for legit paths are zero.

---

```
VERDICT: NEEDS-HUMAN

## SUMMARY
 RLS backstop (audit item 16) for Platos. Four reality checks ran; two are hard blockers that make the audit's "just add $extends + policies" plan silently do NOTHING as deployed today.

BLOCKER 1 — the app connects as the Postgres SUPERUSER. docker-compose.platos.yml (lines 286/342/397/537) builds DATABASE_URL as postgresql://${POSTGRES_USER:-postgres}:...@postgres:5432/..., and .env.example defaults POSTGRES_USER to `postgres` — the role that initialised the cluster, i.e. a SUPERUSER. Superusers (and BYPASSRLS roles) bypass RLS UNCONDITIONALLY. FORCE ROW LEVEL SECURITY does NOT change this — FORCE only makes policies apply to the table OWNER, never to a superuser. So with the current connection ENABLE RLS + policies are inert: enforcing filters nothing AND log-only observes nothing (USING clauses are never evaluated for a superuser). RLS cannot function until DATABASE_URL is switched to a dedicated non-superuser, non-BYPASSRLS role. That is an infra cutover, not a code change.

BLOCKER 2 — there is NO per-request scope context a $extends wrapper can read. Scope lives only on the Express request.scope object set by ScopeGuard (apps/agent/src/auth/scope.guard.ts). There is ZERO AsyncLocalStorage / nestjs-cls in apps/agent/src (grep = 0). The Prisma client is a single Global DI singleton (apps/agent/src/shared/database.provider.ts, PRISMA_TOKEN) with no request binding, consumed by 53 files. A $extends on that singleton has no way to know which tenant the current query belongs to. You must first build an ALS layer and populate it from ScopeGuard AND the WS handshake AND every trigger task.

Secondary findings:
(3) Connection-GUC pinning IS solvable here: DATABASE_URL points straight at postgres:5432 with NO pgbouncer (grep=0), so SET LOCAL / set_config(...,true) visibility is intact. The safe primitive is a sequential array $transaction([ set_config(...,true), query(args) ]) inside a $extends $allOperations hook — both run on one pinned connection, GUC is LOCAL and auto-resets at commit. Caveat: it does NOT compose with the 7 files that already call $transaction (interactive tx can't be nested) — those need the GUC set once at tx open.
(4) Bypass surfaces that break under enforcing RLS: trigger task apps/agent/src/trigger-tasks/platos-custom-task.ts:71 news up its OWN PrismaClient() outside DI (no wrapper → no GUC → every row filtered); webapp main+replica clients (apps/webapp/app/db.server.ts:121,245); testcontainers. Cross-scope admin sweeps in apps/agent/src/mcp-platform/tools/admin.ts (audit.cross_scope_tool_calls, budgets.rollup_org_wide, gdpr.export_user_everywhere, plus loadOrgScopes fan-out) deliberately read every project/env in an org — under a single-scope GUC they return PARTIAL data, not an error, so they must run as a BYPASSRLS role or set platos.bypass_rls.
(5) NOT every Platos* table is scoped: PlatosToolDefinition (schema.prisma:3672) is a GLOBAL catalog with NO org/project/env columns and is read via bare findMany() (tool-registry.service.ts:131). Blanket RLS on all Platos* tables would empty it. Policies must apply ONLY to tables with all three scope columns — the migrations below do this with an information_schema DO-loop, never a hardcoded list.

Verdict NEEDS-HUMAN: the log-only SQL migration is genuinely zero-risk to APPLY (inert under the current superuser connection and, even after cutover, uses PERMISSIVE always-true policies that never filter — only RAISE WARNING). But it OBSERVES nothing until a human owns two infra decisions outside a safe auto-loop: (a) provision the non-superuser app role + BYPASSRLS admin role and cut DATABASE_URL over, (b) build+wire the ALS scope context and audit the 4 bypass clients + 7 $transaction callers. The connection-GUC mechanic is solvable, but the superuser connection + absent request context mean an auto-applied wrapper would, the moment the role is switched, filter every un-wrapped path (trigger tasks, replica, sweeps) to empty in production. A human must sequence the cutover.

## ROLLOUT PLAN
 Ordered, each step gated on the previous. Steps 0-2 are human-owned infra decisions (why the verdict is NEEDS-HUMAN); steps 3+ are the observe->enforce loop.

STEP 0 (infra, human sign-off) — Provision roles. Apply 20260718000000_platos_rls_roles (set platos_app password via env substitution, never hardcoded). Creates platos_app (non-superuser, RLS applies) and platos_admin (BYPASSRLS). Nothing changes yet — app still connects as postgres. ZERO app impact.

STEP 1 (safe, inert) — Apply 20260718010000_platos_rls_log_only. While still connected as the superuser this is fully inert (policies not evaluated). Verifiable no-op. Only step safe to apply without observing behaviour.

STEP 2 (code, human-owned) — Build the ALS + wrapper. Land apps/agent/src/shared/rls-context.ts and prisma-rls.extension.ts; wire withRlsGuc() into database.provider.ts (PRISMA_TOKEN factory) and into the raw client in trigger-tasks/platos-custom-task.ts; wrap ScopeGuard.canActivate, the WS handshake, and every trigger task body in runWithScope(scope). Mark the 4 cross-scope admin sweeps in mcp-platform/tools/admin.ts as runWithScope({...,bypass:true}). Audit the 7 $transaction callers for the nesting caveat. Deploy while STILL on the postgres connection -> GUCs set but RLS not evaluated -> still inert; unit-test that set_config fires with the right tuple.

STEP 3 (OBSERVE — the observability step) — In STAGING only, cut DATABASE_URL over from postgres -> platos_app (and the admin-token worker -> platos_admin). NOW log-only policies evaluate. Set log_min_messages=warning. Drive real traffic (multi-turn chat, tool calls, memory, budgets, the admin sweeps). Grep Postgres logs for PLATOS_RLS_LOG: reason=no_guc rows reveal every un-wrapped query path (background clients, replica, missed runWithScope wrapping); reason=scope_mismatch rows reveal genuine cross-tenant leaks the backstop would catch. Iterate on step 2 until no_guc warnings for legitimate paths are gone. Never filters a row in this phase.

STEP 4 (ENFORCE, staging first) — Once staging logs are clean, apply 20260719010000_platos_rls_enforce in staging. Re-run the full traffic set. Confirm: normal queries succeed, the sweeps (as platos_admin) still return all scopes, a deliberately mis-scoped query returns empty. Only then repeat STEP 3 cutover + STEP 4 enforce in PRODUCTION during a low-traffic window.

ROLLBACK (fast, two independent levers):
  (a) FASTEST, no migration — revert DATABASE_URL back to the postgres superuser and redeploy. Superuser bypasses ALL RLS instantly; policies stay in place but do nothing. Un-breaks prod in one env change.
  (b) SQL — DO $$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'Platos%' LOOP EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t); END LOOP; END $$; disables enforcement while keeping the platos_app connection.
Prefer (a) in an incident — it is a config flip with no DB migration.

## RISKS
 Brutally honest failure modes:

1. SUPERUSER CONNECTION = SILENT NO-OP (the #1 way RLS does nothing). Confirmed: app connects as `postgres` (superuser). If someone ships log-only + enforcing WITHOUT the platos_app cutover, RLS is 100% inert and provides ZERO protection while looking done. The enforcing migration passes CI and changes nothing in prod. This is why STEP 0 role provisioning + DATABASE_URL cutover is mandatory and human-gated.

2. EVERY-ROW-EMPTY BREAKAGE on cutover. The moment DATABASE_URL switches to platos_app under ENFORCING policies, any query path that does NOT set a GUC returns EMPTY (fail-closed). Confirmed un-wrapped paths: trigger-tasks/platos-custom-task.ts:71 (news up its own PrismaClient outside DI), webapp main+replica clients (db.server.ts:121,245), testcontainers, any startup/health query before a request scope exists. If enforcing is applied before ALL of these are wrapped/bypassed, durable chat turns and background tasks silently return nothing -> total feature breakage. Mitigated ONLY by staying in log-only (step 3) until no_guc warnings are zero.

3. CROSS-SCOPE SWEEPS RETURN PARTIAL DATA (not an error). audit.cross_scope_tool_calls, budgets.rollup_org_wide, gdpr.export_user_everywhere and loadOrgScopes fan out across an org's projects/envs. Under a single-scope GUC they'd silently return ONLY the caller's scope — a correctness/compliance bug worse than a crash (a GDPR export that misses data). Must run as platos_admin (BYPASSRLS) AND set platos.bypass_rls=on. If either the role OR the bypass GUC is forgotten, exports/audits are quietly incomplete.

4. $transaction COMPOSITION. 7 agent files call $transaction. The array-transaction GUC wrapper cannot nest inside a caller's interactive $transaction — Prisma throws. Those call sites need the GUC set once at tx open on the interactive client instead. If missed, those flows 500 under the wrapper.

5. GLOBAL CATALOG EMPTIED. PlatosToolDefinition has no scope columns and is read via bare findMany(). The migrations correctly skip no-tuple tables via information_schema, but if a future H15-style migration ADDS nullable scope columns to it, the DO-loop would start applying RLS and empty the shared catalog. Re-verify the loop's table list after any scope-column migration.

6. PERF. Every read becomes a 1-statement transaction (extra BEGIN/COMMIT round trip) and the log-only USING function runs per-row on scans (the 1% random() throttle limits log volume but the function still executes). Measure p95 in staging before enforcing; a hot read path could regress.

7. PRISMA MIGRATE DRIFT. Roles/policies created outside prisma migrate can confuse migrate deploy/diff (Prisma doesn't model RLS/roles). Keep all of it in migration.sql files (as done) and never run migrate dev/reset against a DB with these roles without accounting for them.

Net: the log-only migration is genuinely zero-risk to APPLY, but it is also zero-VALUE until the superuser cutover — and that cutover is where the app can break to all-empty in production. A human must own the sequencing; do not auto-apply the enforcing step or the role cutover in a loop.


### FILE: internal-packages/database/prisma/migrations/20260718010000_platos_rls_log_only/migration.sql
WHY: DELIVERABLE A — LOG-ONLY, safe to apply first. Inert under the current superuser connection; even after the role cutover it NEVER blocks a row (PERMISSIVE, always returns true) — it only RAISE WARNINGs when the per-request GUC scope != the row's scope, or when no GUC is set (flagging every un-wrapped query path). Applied only to tables that actually have all three scope columns, via an information_schema DO-loop, so the global PlatosToolDefinition catalog is untouched. Plain-SQL migration-dir shape run by prisma migrate deploy.
----
-- Platos RLS backstop — PHASE 1: LOG-ONLY (audit item 16)
-- SAFE TO APPLY: never filters or blocks a row. Observes only.
-- NOTE: while the app still connects as the Postgres SUPERUSER, policies are
-- NOT evaluated at all (superusers bypass RLS) so this is fully inert. It
-- begins observing only once DATABASE_URL is switched to the non-superuser
-- platos_app role (see 20260718000000_platos_rls_roles).

CREATE SCHEMA IF NOT EXISTS platos_rls;

-- GUCs read (all missing_ok = true so an unset GUC yields NULL, not an error):
--   platos.org / platos.project / platos.env  — per-request scope tuple
--   platos.bypass_rls = 'on'                    — admin BYPASSRLS escape hatch
CREATE OR REPLACE FUNCTION platos_rls.log_and_pass(
  tbl text, row_org text, row_proj text, row_env text
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  g_org  text := current_setting('platos.org', true);
  g_proj text := current_setting('platos.project', true);
  g_env  text := current_setting('platos.env', true);
BEGIN
  IF current_setting('platos.bypass_rls', true) = 'on' THEN
    RETURN true;
  END IF;

  -- No GUC set → an un-wrapped query path. Under enforcing this row would be
  -- FILTERED. Log it (throttled so a full-table scan doesn't flood the log).
  IF g_org IS NULL OR g_org = '' THEN
    IF random() < 0.01 THEN
      RAISE WARNING 'PLATOS_RLS_LOG table=% reason=no_guc row_org=%', tbl, row_org;
    END IF;
    RETURN true;
  END IF;

  IF g_org  IS DISTINCT FROM row_org
     OR g_proj IS DISTINCT FROM row_proj
     OR g_env  IS DISTINCT FROM row_env THEN
    RAISE WARNING 'PLATOS_RLS_LOG table=% reason=scope_mismatch guc=%/%/% row=%/%/%',
      tbl, g_org, g_proj, g_env, row_org, row_proj, row_env;
    RETURN true;   -- LOG-ONLY: never block
  END IF;

  RETURN true;
END;
$fn$;

-- Apply ENABLE RLS + a PERMISSIVE always-true logging policy to EVERY public
-- table that has all three scope columns. Tables without the full tuple (e.g.
-- the global PlatosToolDefinition catalog) are skipped automatically.
DO $do$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('organizationId','projectId','environmentId')
    GROUP BY c.table_name
    HAVING count(DISTINCT c.column_name) = 3
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS platos_rls_logonly ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY platos_rls_logonly ON public.%I AS PERMISSIVE FOR ALL '
      || 'USING (platos_rls.log_and_pass(%L, "organizationId", "projectId", "environmentId")) '
      || 'WITH CHECK (true)', t, t);
    -- Do NOT FORCE here: postgres owns the tables; the non-owner platos_app role
    -- is already subject to RLS. FORCE would also subject admin sweeps run as
    -- the owner — we don't want that in log-only.
  END LOOP;
END;
$do$;



### FILE: internal-packages/database/prisma/migrations/20260718000000_platos_rls_roles/migration.sql
WHY: DELIVERABLE C (prerequisite) — provisions the non-superuser application role (platos_app) that DATABASE_URL must be switched to for RLS to have ANY effect, plus the BYPASSRLS admin role (platos_admin) for the cross-scope sweeps. This is BLOCKER 1; the DATABASE_URL cutover must be human-owned. Idempotent role creation.
----
-- Platos RLS backstop — role provisioning (audit item 16, BLOCKER 1 fix)
-- Run as the postgres superuser (migrations-init already connects as superuser).
--
-- RLS is BYPASSED for superusers and BYPASSRLS roles, UNCONDITIONALLY, even
-- under FORCE ROW LEVEL SECURITY. The app therefore MUST connect as a
-- non-superuser, non-BYPASSRLS role for any policy to take effect.
--
-- After this migration, a human must set the app password and cut DATABASE_URL
-- over from postgres -> platos_app (see rolloutPlan). Sweeps use platos_admin.

DO $do$
BEGIN
  -- Application role: LOGIN, NOT superuser, NOT BYPASSRLS. RLS applies to it.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platos_app') THEN
    CREATE ROLE platos_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  -- Admin sweep role: BYPASSRLS so cross-scope reads (audit.cross_scope_tool_calls,
  -- budgets.rollup_org_wide, gdpr.export_user_everywhere, loadOrgScopes fan-out)
  -- see every scope. Used ONLY by PLATOS_ADMIN_TOKEN paths.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platos_admin') THEN
    CREATE ROLE platos_admin LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END;
$do$;

-- Grants: platos_app + platos_admin need full DML on all current + future
-- tables/sequences, plus EXECUTE on the log helper.
GRANT USAGE ON SCHEMA public TO platos_app, platos_admin;
GRANT USAGE ON SCHEMA platos_rls TO platos_app, platos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platos_app, platos_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platos_app, platos_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA platos_rls TO platos_app, platos_admin;

-- Future objects created by later `prisma migrate deploy` runs (which run as
-- postgres) must auto-grant to the app roles, or new tables silently deny.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platos_app, platos_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO platos_app, platos_admin;

-- NOTE: set the platos_app password out-of-band (env-substituted) — do NOT
-- hardcode it here. e.g. ALTER ROLE platos_app PASSWORD :'PLATOS_APP_PASSWORD';



### FILE: internal-packages/database/prisma/migrations/20260719010000_platos_rls_enforce/migration.sql
WHY: DELIVERABLE C — the ENFORCING migration, shipped SEPARATELY and LATER, only after log-only observation is clean and the role cutover is done. Replaces the always-true log policy with a real scope-matching policy that fails CLOSED when the GUC is unset. Never auto-apply.
----
-- Platos RLS backstop — PHASE 2: ENFORCING (audit item 16)
-- DO NOT APPLY until: (1) platos_app role cutover is live, (2) log-only ran long
-- enough that PLATOS_RLS_LOG warnings for reason=no_guc / scope_mismatch have
-- dropped to zero in staging, (3) all bypass clients (trigger platos-custom-task,
-- webapp replica) are wrapped or explicitly set platos.bypass_rls.

DO $do$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('organizationId','projectId','environmentId')
    GROUP BY c.table_name
    HAVING count(DISTINCT c.column_name) = 3
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS platos_rls_logonly ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS platos_rls_enforce ON public.%I', t);
    -- Fail-closed: if any GUC is unset, current_setting returns NULL, the
    -- equality is NULL, the row is excluded. bypass_rls='on' short-circuits
    -- for admin sweeps (belt-and-suspenders alongside the BYPASSRLS role).
    EXECUTE format(
      'CREATE POLICY platos_rls_enforce ON public.%I AS PERMISSIVE FOR ALL '
      || 'USING ('
      || '  current_setting(''platos.bypass_rls'', true) = ''on'' OR ('
      || '    "organizationId" = current_setting(''platos.org'', true) AND '
      || '    "projectId"      = current_setting(''platos.project'', true) AND '
      || '    "environmentId"  = current_setting(''platos.env'', true))) '
      || 'WITH CHECK ('
      || '  current_setting(''platos.bypass_rls'', true) = ''on'' OR ('
      || '    "organizationId" = current_setting(''platos.org'', true) AND '
      || '    "projectId"      = current_setting(''platos.project'', true) AND '
      || '    "environmentId"  = current_setting(''platos.env'', true)))',
      t);
  END LOOP;
END;
$do$;



### FILE: apps/agent/src/shared/rls-context.ts
WHY: DELIVERABLE B (part 1) — the AsyncLocalStorage scope store that does not exist today (BLOCKER 2). ScopeGuard, the WS handshake, and every trigger task must run their work inside runWithScope(...) so the Prisma extension can read the current tenant. PROPOSAL — not wired; wiring is the human-owned step.
----
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * RLS scope context (audit item 16). The Prisma $extends wrapper reads the
 * current request's scope tuple from here to set the platos.org/project/env
 * GUCs on the same connection as each query.
 *
 * There is NO ambient request context in apps/agent today — scope lives only
 * on the Express request.scope. This ALS is the missing bridge. Every entry
 * point that owns a scope MUST wrap its work in runWithScope():
 *   - ScopeGuard.canActivate (HTTP)      — after it sets request.scope
 *   - connections.gateway handshake (WS) — where request.scope is stamped
 *   - trigger-tasks/*.ts                 — from payload.scope (these run OUTSIDE
 *                                          Nest DI and new up their own client)
 *   - admin sweeps                       — with { bypass: true }
 */
export interface RlsScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  /** set for PLATOS_ADMIN_TOKEN cross-scope sweeps — emits platos.bypass_rls=on */
  bypass?: boolean;
}

const als = new AsyncLocalStorage<RlsScope>();

export function runWithScope<T>(scope: RlsScope, fn: () => Promise<T> | T): Promise<T> | T {
  return als.run(scope, fn);
}

export function currentScope(): RlsScope | undefined {
  return als.getStore();
}



### FILE: apps/agent/src/shared/prisma-rls.extension.ts
WHY: DELIVERABLE B (part 2) — the $extends connection-GUC wrapper. Uses the sequential array $transaction([set_config(...,true), query]) pattern so the SET LOCAL GUC lands on the SAME pinned connection as the query and auto-resets at commit — valid here because there is NO pgbouncer (direct connection to postgres:5432). PROPOSAL — includes the composition caveat for the 7 existing $transaction callers.
----
import { currentScope } from "./rls-context";

/**
 * Wraps a base PrismaClient so every operation sets the platos.* GUCs on the
 * connection it runs on (audit item 16).
 *
 * WHY THE ARRAY $transaction: Prisma pools connections. A bare SET would leak
 * across pooled connections to the WRONG tenant. set_config(key, val, true) is
 * SET LOCAL — scoped to a transaction and auto-reset at commit. Passing
 * [setConfig, query(args)] to the SEQUENTIAL-array $transaction guarantees BOTH
 * run inside ONE transaction on ONE pinned connection. Safe here because
 * DATABASE_URL connects DIRECTLY to postgres:5432 (no pgbouncer txn-mode pooler,
 * which would break SET LOCAL visibility).
 *
 * CAVEATS (must be handled before enforcing):
 *  - Composition: the 7 files that call base.$transaction(interactive) will
 *    error if this hook tries to open a nested tx. Detect "already in a tx" and
 *    skip re-wrapping; those call sites must instead SET LOCAL once at tx open
 *    on the interactive tx client.
 *  - Bypass clients: apps/agent/src/trigger-tasks/platos-custom-task.ts news up
 *    its own PrismaClient OUTSIDE Nest DI — it must apply THIS extension too and
 *    call runWithScope(payload.scope). The webapp replica client likewise.
 *  - Perf: every read becomes a 1-statement transaction (extra round trip).
 *    Acceptable for a defense-in-depth backstop; measure in staging.
 */
export function withRlsGuc(base: any): any {
  return base.$extends({
    query: {
      async $allOperations({ args, query }: { args: any; query: (a: any) => Promise<any> }) {
        const s = currentScope();
        // No scope in context (e.g. a startup/health query): run un-wrapped.
        // Under LOG-ONLY this surfaces as a reason=no_guc warning — exactly the
        // signal we want. Under ENFORCING these paths must be given a scope or
        // explicit bypass before cutover.
        if (!s) return query(args);

        const org = s.organizationId;
        const proj = s.projectId;
        const env = s.environmentId;
        const bypass = s.bypass ? "on" : "off";

        const [, result] = await base.$transaction([
          base.$executeRaw`SELECT
            set_config('platos.org', ${org}, true),
            set_config('platos.project', ${proj}, true),
            set_config('platos.env', ${env}, true),
            set_config('platos.bypass_rls', ${bypass}, true)`,
          query(args),
        ]);
        return result;
      },
    },
  });
}

```
