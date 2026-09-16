// WIN-257 / WIN-284 — THE ORACLE SIDE OF THE TRANSPORT DIFFERENTIAL, EXECUTED
// WHERE THE ORACLE RUNS.
//
// The oracle is not a description of the webapp's behaviour; it is the webapp.
// Every step below imports a REAL route module from `apps/webapp/app/routes` —
// the same `loader` and `action` Remix invokes in production — or a real export
// of `apps/webapp/app/services/auth.server`, and calls it with a real `Request`
// against a real PostgreSQL. Nothing here re-implements a Prisma query, a
// membership rule or a cookie format. That is the whole point: a differential
// against a re-implementation compares two things the same author wrote.
//
// WHY IT IS A SEPARATE PROCESS, AND WHY IT LIVES HERE. `@remix-run/node`,
// `@platos/tenancy-database`'s generated client and the `~/*` path alias all
// resolve only inside `apps/webapp`. A driver anywhere else would have to
// re-create the module resolution the webapp ships with, which is the first step
// towards re-implementing the oracle rather than running it.
//
// AND WHY IT IS ONE STEP PER INVOCATION. The suite that calls this owns the
// sequencing, because it must dump BOTH databases with the SAME mechanism after
// each step. A driver that ran the whole script and dumped its own side would be
// two readers with two shapes, and every difference between them would look like
// drift.
//
// THIS FILE IS NOT A TEST. It is deliberately `.mts` and carries no `.test.`
// segment so `apps/webapp`'s own Vitest include pattern (`test/**/*.test.{ts,tsx}`)
// does not pick it up: it needs a database, and a suite that fails without one
// has no business in the package's default run.
//
// Run: tsx apps/webapp/test/differential-oracle.mts <request.json> <out.json>
//   request.json  { "step": "<id>", "params": { ... } }
//   out.json      { "status": number, "facts": {...}, "auth": {...}, "error": string|null }

import { readFileSync, writeFileSync } from "node:fs";

const ORIGIN = "http://oracle.differential.test";

interface OracleAnswer {
  readonly status: number;
  readonly facts: Record<string, unknown>;
  readonly auth: { principal: string | null; scopes: string[]; decision: "allow" | "deny"; reason: string | null };
  readonly setCookie: string | null;
  readonly error: string | null;
}

function requestWith(path: string, options: { cookie?: string; method?: string; form?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers["Cookie"] = options.cookie;
  let body: BodyInit | undefined;
  if (options.form !== undefined) {
    const form = new FormData();
    for (const [key, value] of Object.entries(options.form)) form.set(key, value);
    body = form;
  }
  return new Request(`${ORIGIN}${path}`, { method: options.method ?? "GET", headers, ...(body === undefined ? {} : { body }) });
}

/**
 * Runs a loader or action and reads its outcome the way Remix does.
 *
 * A Remix handler answers in three ways and all three are observable: it returns
 * a value, it returns a `Response` (`json`, `redirect`), or it THROWS one. A
 * driver that only handled the first two would report a thrown 403 as a crash,
 * which is the difference between "the oracle refused" and "the oracle broke".
 */
async function observe(run: () => Promise<unknown>): Promise<{ status: number; value: unknown; response: Response | null }> {
  try {
    const value = await run();
    if (value instanceof Response) return { status: value.status, value: await readBody(value), response: value };
    return { status: 200, value, response: null };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, value: await readBody(thrown), response: thrown };
    throw thrown;
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.clone().text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function allow(status: number): "allow" | "deny" {
  return status < 400 ? "allow" : "deny";
}

function reasonOf(status: number, value: unknown): string | null {
  if (status < 400) return null;
  if (typeof value === "string" && value !== "") return value;
  if (value !== null && typeof value === "object" && "error" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)["error"]);
  }
  return `status ${String(status)}`;
}

async function principalOf(cookie: string | undefined): Promise<{ principal: string | null; email: string | null }> {
  if (cookie === undefined) return { principal: null, email: null };
  const { optionalOperator } = await import("~/services/auth.server");
  const operator = await optionalOperator(requestWith("/", { cookie }));
  return operator === null ? { principal: null, email: null } : { principal: operator.userId, email: operator.email };
}

type Params = Record<string, string | string[] | undefined>;

const STEPS: Record<string, (params: Params) => Promise<OracleAnswer>> = {
  /**
   * The webapp's own sign-in, end to end, in the one configuration that runs it
   * without an outbound email provider: `BACKDOOR_PLATOS_DEV=1` makes the real
   * action issue AND consume the magic link itself and commit the session
   * cookie. Both halves — `operatorAuth.issueMagicLink` and
   * `operatorAuth.consumeMagicLink` — are the oracle's, and the token never
   * leaves the process, which is the behaviour V1 replaces with an emailed link.
   */
  "magic-link-login": async (params) => {
    const { action } = await import("~/routes/login._index/route");
    const seen = await observe(() =>
      action({ request: requestWith("/login", { method: "POST", form: { email: String(params["email"]) } }), params: {}, context: {} } as never),
    );
    const setCookie = seen.response?.headers.get("set-cookie") ?? null;
    const who = await principalOf(setCookie?.split(";")[0] ?? undefined);
    return {
      status: seen.status,
      facts: {
        signedIn: setCookie !== null,
        cookieName: setCookie === null ? null : (setCookie.split("=")[0] ?? null),
        redirectTo: seen.response?.headers.get("location") ?? null,
      },
      auth: { principal: who.principal, scopes: [], decision: allow(seen.status), reason: reasonOf(seen.status, seen.value) },
      setCookie,
      error: null,
    };
  },

  /**
   * "Who is this browser?", asked of the oracle the way every authenticated
   * webapp route asks it.
   */
  "identity-session": async (params) => {
    const cookie = params["cookie"] === undefined ? undefined : String(params["cookie"]);
    const who = await principalOf(cookie);
    const status = who.principal === null ? 401 : 200;
    return {
      status,
      facts: { authenticated: who.principal !== null, email: who.email },
      auth: { principal: who.principal, scopes: [], decision: allow(status), reason: status === 401 ? "no operator session" : null },
      setCookie: null,
      error: null,
    };
  },

  /**
   * The exchange V1 serves as `POST /bff/session`: a token the caller already
   * holds becomes a browser cookie. The oracle's two halves are
   * `operatorAuth.authorizeOperatorSession` and `commitOperatorSession`.
   */
  "session-exchange": async (params) => {
    const { operatorAuth, commitOperatorSession, readOperatorToken } = await import("~/services/auth.server");
    // The raw token is read back out of the oracle's OWN cookie, by the oracle's
    // own parser. A suite that handed the token in would have had to know the
    // Remix cookie encoding, which is one of the things this differential exists
    // to compare rather than to assume.
    const token = (await readOperatorToken(requestWith("/", { cookie: String(params["cookie"]) }))) ?? "";
    try {
      const authorization = await operatorAuth.authorizeOperatorSession(token);
      const header = await commitOperatorSession(token, new Date(String(params["expiresAt"])));
      return {
        status: 200,
        facts: { exchanged: true, cookieName: header.split("=")[0] ?? null },
        auth: { principal: authorization.effectiveUserId, scopes: [], decision: "allow", reason: null },
        setCookie: header,
        error: null,
      };
    } catch (error) {
      return {
        status: 401,
        facts: { exchanged: false, cookieName: null },
        auth: { principal: null, scopes: [], decision: "deny", reason: error instanceof Error ? error.message : String(error) },
        setCookie: null,
        error: null,
      };
    }
  },

  /**
   * WHICH ORGANIZATIONS CAN THIS OPERATOR SEE, asked of the oracle's real
   * membership gate.
   *
   * The webapp has no organization LIST route — its shell resolves one
   * organization at a time — so the set is built by asking the real
   * `_app.orgs.$organizationSlug._index` loader about every seeded slug and
   * keeping the ones it answered. That IS the oracle's answer to the question
   * V1's `GET /organizations` answers, computed from the gate the webapp really
   * runs rather than from a query written here.
   */
  "organization-list": async (params) => {
    const { loader } = await import("~/routes/_app.orgs.$organizationSlug._index/route");
    const cookie = String(params["cookie"]);
    const visible: { slug: string; name: string }[] = [];
    let denials = 0;
    for (const slug of params["slugs"] as string[]) {
      const seen = await observe(() =>
        loader({ request: requestWith(`/orgs/${slug}`, { cookie }), params: { organizationSlug: slug }, context: {} } as never),
      );
      if (seen.status >= 400) {
        denials += 1;
        continue;
      }
      const organization = (seen.value as { organization?: { slug: string; name: string } }).organization;
      if (organization !== undefined) visible.push({ slug: organization.slug, name: organization.name });
    }
    const who = await principalOf(cookie);
    // `denials` is counted and deliberately NOT projected. The candidate's
    // `GET /organizations` is one call that returns what the operator can see;
    // it never asks about an organization it cannot reach, so a refusal COUNT
    // has no counterpart on that side and comparing it would be comparing the
    // shape of the two drivers rather than the behaviour of the two systems.
    // The exclusion it measures is already visible: an organization the oracle
    // refused is one the list below does not contain.
    if (denials !== (params["slugs"] as string[]).length - visible.length) {
      throw new Error("the oracle admitted and refused a different number of organizations than it was asked about");
    }
    return {
      status: 200,
      facts: { organizations: visible.sort((left, right) => (left.slug < right.slug ? -1 : 1)) },
      auth: { principal: who.principal, scopes: [], decision: "allow", reason: null },
      setCookie: null,
      error: null,
    };
  },

  /** The projects the same loader returns, over the organizations it admits. */
  "project-list": async (params) => {
    const { loader } = await import("~/routes/_app.orgs.$organizationSlug._index/route");
    const cookie = String(params["cookie"]);
    const projects: { slug: string; name: string }[] = [];
    for (const slug of params["slugs"] as string[]) {
      const seen = await observe(() =>
        loader({ request: requestWith(`/orgs/${slug}`, { cookie }), params: { organizationSlug: slug }, context: {} } as never),
      );
      if (seen.status >= 400) continue;
      const organization = (seen.value as { organization?: { projects?: { slug: string; name: string }[] } }).organization;
      for (const project of organization?.projects ?? []) projects.push({ slug: project.slug, name: project.name });
    }
    const who = await principalOf(cookie);
    return {
      status: 200,
      facts: { projects: projects.sort((left, right) => (left.slug < right.slug ? -1 : 1)) },
      auth: { principal: who.principal, scopes: [], decision: "allow", reason: null },
      setCookie: null,
      error: null,
    };
  },

  "organization-create": async (params) => {
    const { action } = await import("~/routes/_app.orgs.new/route");
    const cookie = String(params["cookie"]);
    const seen = await observe(() =>
      action({
        request: requestWith("/orgs/new", { method: "POST", cookie, form: { name: String(params["name"]), slug: String(params["slug"]) } }),
        params: {},
        context: {},
      } as never),
    );
    const who = await principalOf(cookie);
    return {
      status: seen.status,
      facts: { created: seen.status < 400, redirectTo: seen.response?.headers.get("location") ?? null },
      auth: { principal: who.principal, scopes: [], decision: allow(seen.status), reason: reasonOf(seen.status, seen.value) },
      setCookie: null,
      error: null,
    };
  },

  "project-create": async (params) => {
    const { action } = await import("~/routes/_app.orgs.$organizationSlug_.projects.new/route");
    const cookie = String(params["cookie"]);
    const organizationSlug = String(params["organizationSlug"]);
    const seen = await observe(() =>
      action({
        request: requestWith(`/orgs/${organizationSlug}/projects/new`, {
          method: "POST",
          cookie,
          form: { name: String(params["name"]), slug: String(params["slug"]), environment: String(params["environment"]) },
        }),
        params: { organizationSlug },
        context: {},
      } as never),
    );
    const who = await principalOf(cookie);
    return {
      status: seen.status,
      facts: { created: seen.status < 400, redirectTo: seen.response?.headers.get("location") ?? null },
      auth: { principal: who.principal, scopes: [], decision: allow(seen.status), reason: reasonOf(seen.status, seen.value) },
      setCookie: null,
      error: null,
    };
  },

  /**
   * The end-user page. `EndUser` carries an `organizationId` and no environment,
   * so both sides are answering the same question about the same scope; the
   * route's own `requireEnvironmentScope` is what decides whether this operator
   * may ask it.
   */
  "end-user-page": async (params) => {
    const { loader } = await import(
      "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-accounts._index/route"
    );
    const cookie = String(params["cookie"]);
    const scope = {
      organizationSlug: String(params["organizationSlug"]),
      projectParam: String(params["projectSlug"]),
      envParam: String(params["environmentSlug"]),
    };
    const seen = await observe(() =>
      loader({
        request: requestWith(`/orgs/${scope.organizationSlug}/projects/${scope.projectParam}/env/${scope.envParam}/agent-accounts`, { cookie }),
        params: scope,
        context: {},
      } as never),
    );
    const panel = (seen.value as { panel?: { data?: { users?: { displayName: string | null }[]; total?: number } } }).panel;
    const who = await principalOf(cookie);
    return {
      status: seen.status,
      facts: {
        endUsers: (panel?.data?.users ?? []).map((user) => ({ displayName: user.displayName })),
        total: panel?.data?.total ?? null,
      },
      auth: { principal: who.principal, scopes: [], decision: allow(seen.status), reason: reasonOf(seen.status, seen.value) },
      setCookie: null,
      error: null,
    };
  },

  /**
   * `auth.server.requireEnvironmentScope` — the function V1 replaces with
   * `GET /environments/by-slugs`, called directly because it is the oracle: the
   * slug resolution, the archived filters and the `authorizeEnvironmentOperator`
   * grant all live in it.
   */
  "environment-by-slugs": async (params) => {
    const { requireEnvironmentScope } = await import("~/services/auth.server");
    const cookie = String(params["cookie"]);
    const access = params["access"] === undefined ? undefined : (String(params["access"]) as never);
    const seen = await observe(async () =>
      requireEnvironmentScope({
        request: requestWith("/scope", { cookie }),
        organizationSlug: String(params["organizationSlug"]),
        projectSlug: String(params["projectSlug"]),
        environmentSlug: String(params["environmentSlug"]),
        ...(access === undefined ? {} : { access }),
      }),
    );
    const resolved = seen.value as
      | { scope?: { organizationId: string }; authorization?: { organizationRole?: string; projectRole?: string | null } }
      | null;
    const who = await principalOf(cookie);
    return {
      status: seen.status,
      facts: {
        resolved: seen.status < 400,
        organizationRole: resolved?.authorization?.organizationRole ?? null,
        projectRole: resolved?.authorization?.projectRole ?? null,
      },
      auth: {
        principal: who.principal,
        scopes: resolved?.authorization?.organizationRole === undefined ? [] : [resolved.authorization.organizationRole],
        decision: allow(seen.status),
        reason: reasonOf(seen.status, seen.value),
      },
      setCookie: null,
      error: null,
    };
  },

  "environment-variable-set": async (params) => {
    const { action } = await import(
      "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route"
    );
    const cookie = String(params["cookie"]);
    const scope = {
      organizationSlug: String(params["organizationSlug"]),
      projectParam: String(params["projectSlug"]),
      envParam: String(params["environmentSlug"]),
    };
    const seen = await observe(() =>
      action({
        request: requestWith("/environment-variables/new", {
          method: "POST",
          cookie,
          form: { key: String(params["key"]), value: String(params["value"]) },
        }),
        params: scope,
        context: {},
      } as never),
    );
    const body = seen.value as { ok?: boolean } | null;
    const who = await principalOf(cookie);
    return {
      status: seen.status,
      facts: { written: body?.ok === true },
      auth: { principal: who.principal, scopes: [], decision: allow(seen.status), reason: reasonOf(seen.status, seen.value) },
      setCookie: null,
      error: null,
    };
  },

  "environment-variable-list": async (params) => {
    const { loader } = await import(
      "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route"
    );
    const cookie = String(params["cookie"]);
    const scope = {
      organizationSlug: String(params["organizationSlug"]),
      projectParam: String(params["projectSlug"]),
      envParam: String(params["environmentSlug"]),
    };
    const seen = await observe(() =>
      loader({ request: requestWith("/environment-variables", { cookie }), params: scope, context: {} } as never),
    );
    const panel = (seen.value as {
      panel?: { data?: { variables?: { key: string; kind: string; value: string | null; present: boolean }[] } };
    }).panel;
    const who = await principalOf(cookie);
    return {
      status: seen.status,
      facts: {
        variables: (panel?.data?.variables ?? [])
          .map((variable) => ({ key: variable.key, kind: variable.kind, plaintextVisible: variable.value !== null, present: variable.present }))
          .sort((left, right) => (left.key < right.key ? -1 : 1)),
      },
      auth: { principal: who.principal, scopes: [], decision: allow(seen.status), reason: reasonOf(seen.status, seen.value) },
      setCookie: null,
      error: null,
    };
  },

  "sign-out": async (params) => {
    const { action } = await import("~/routes/logout");
    const cookie = String(params["cookie"]);
    const before = await principalOf(cookie);
    const seen = await observe(() =>
      action({ request: requestWith("/logout", { method: "POST", cookie }), params: {}, context: {} } as never),
    );
    const cleared = seen.response?.headers.get("set-cookie") ?? null;
    const after = await principalOf(cookie);
    return {
      status: seen.status,
      facts: { endedSession: after.principal === null && before.principal !== null, cookieCleared: cleared !== null },
      auth: { principal: before.principal, scopes: [], decision: allow(seen.status), reason: reasonOf(seen.status, seen.value) },
      setCookie: cleared,
      error: null,
    };
  },
};

async function main(): Promise<void> {
  const [, , requestPath, outPath] = process.argv;
  if (requestPath === undefined || outPath === undefined) throw new Error("usage: differential-oracle.mts <request.json> <out.json>");
  const plan = JSON.parse(readFileSync(requestPath, "utf8")) as { step: string; params: Params };
  const step = STEPS[plan.step];
  if (step === undefined) throw new Error(`no oracle step named ${plan.step}; the suite and this driver disagree`);
  const answer = await step(plan.params ?? {});
  writeFileSync(outPath, `${JSON.stringify(answer, null, 2)}\n`);
}

await main();
process.exit(0);
