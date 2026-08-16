import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  Logger,
  Inject,
} from "@nestjs/common";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import * as crypto from "node:crypto";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import { ChannelPersistenceService } from "./channel-persistence.service";
import { ChannelRuntimeService } from "./channel-runtime.service";

/**
 * Connect v3 — marketplace channel-app OAuth V2 install dance (Slack first).
 *
 *   GET /api/v1/channels/oauth/:appId/install   — "Add to Slack" landing.
 *   GET /api/v1/channels/oauth/:appId/callback  — Slack's redirect_uri target.
 *
 * PUBLIC surface (ScopeGuard allowlists the `/api/v1/channels/oauth/` prefix —
 * see scope.guard.ts). There is no per-scope Platos session here: the caller is
 * a browser mid-install, not a Platos user. `appId` IS the key — the app is
 * loaded regardless of scope. Auth is IN this controller:
 *
 *   CSRF — `/install` mints a single-use 256-bit `state` nonce into Redis
 *          (`chanapp:oauth:state:<state>` = appId, TTL 600s) and passes it to
 *          Slack; `/callback` GETDELs it and requires it to equal THIS appId,
 *          so a code can't be replayed against a different app or after expiry.
 *
 *   RATE LIMIT — both endpoints are anonymous AND bypass RateLimitGuard
 *          (ScopeGuard allowlist → no request.scope → guard early-exits), and
 *          every /install writes a 600s-TTL state key to Redis. Without a
 *          limit that's an anonymous Redis memory-exhaustion vector. Per-IP
 *          Redis INCR bucket (default 30 req / 5 min, env
 *          PLATOS_CHANNEL_OAUTH_IP_LIMIT), mirroring the EOBD.89 public
 *          guest-token controller. Fails OPEN on a Redis blip (same policy).
 *
 * SECRETS never leak: app and installation rows carry Credential references;
 * only the credential envelope is decrypted for Slack calls, and OAuth grants
 * are encrypted into the referenced installation Credential before commit.
 * No secret/token is logged or rendered into HTML. Every Slack HTTP call is
 * bounded by a 10s AbortSignal.timeout.
 */
@Controller()
export class ChannelAppOAuthController {
  private readonly logger = new Logger(ChannelAppOAuthController.name);

  constructor(
    private readonly persistence: ChannelPersistenceService,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    private readonly runtime: ChannelRuntimeService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // GET /install — mint state, redirect to Slack's authorize screen
  // ───────────────────────────────────────────────────────────────────────
  @Get("api/v1/channels/oauth/:appId/install")
  async install(
    @Req() req: ExpressRequest,
    @Param("appId") appId: string,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    // Per-IP limit BEFORE any DB load or Redis state write — this surface is
    // anonymous and RateLimitGuard never sees it (no request.scope).
    if (await this.rateLimited(req)) {
      this.sendPage(
        res,
        429,
        "Too many requests",
        "Too many installation attempts from your network. Please try again in a few minutes.",
      );
      return;
    }

    const app = await this.loadApp(appId);
    if (!app) {
      this.sendPage(
        res,
        404,
        "Install link not found",
        "This install link is no longer valid. Please start again from your Platos dashboard.",
      );
      return;
    }

    const origin = this.publicOrigin();
    if (!origin) {
      // Without a public base URL we cannot build the redirect_uri Slack
      // requires (and pre-registered). Fail loudly rather than send Slack a
      // relative/blank redirect.
      this.logger.error(
        `[chanapp] install blocked — PLATOS_PUBLIC_BASE_URL unset app=${appId}`,
      );
      this.sendPage(
        res,
        500,
        "Not configured",
        "This Platos deployment is missing its public base URL, so the Slack install cannot start. Ask your administrator to set PLATOS_PUBLIC_BASE_URL.",
      );
      return;
    }

    const state = crypto.randomBytes(32).toString("hex");
    try {
      await this.redis.set(this.stateKey(state), String(app.id), "EX", 600);
    } catch {
      this.logger.error(`[chanapp] install state persist failed app=${appId}`);
      this.sendPage(
        res,
        503,
        "Please try again",
        "We couldn't start the installation just now. Please try again in a moment.",
      );
      return;
    }

    const redirectUri = this.callbackUrl(origin, String(app.id));
    const scopes = Array.isArray(app.scopes) ? app.scopes.join(",") : "";
    const params = new URLSearchParams({
      client_id: String(app.clientId ?? ""),
      scope: scopes,
      state,
      redirect_uri: redirectUri,
    });

    this.logger.log(`[chanapp] oauth install redirect app=${appId}`);
    res.redirect(302, `https://slack.com/oauth/v2/authorize?${params.toString()}`);
  }

  // ───────────────────────────────────────────────────────────────────────
  // GET /callback — verify state, exchange code, upsert installation
  // ───────────────────────────────────────────────────────────────────────
  @Get("api/v1/channels/oauth/:appId/callback")
  async callback(
    @Req() req: ExpressRequest,
    @Param("appId") appId: string,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    // Same anonymous surface as /install — limit before doing any work.
    // (Returning 429 without consuming the state nonce is fine: it simply
    // expires on its 600s TTL.)
    if (await this.rateLimited(req)) {
      this.sendPage(
        res,
        429,
        "Too many requests",
        "Too many installation attempts from your network. Please try again in a few minutes.",
      );
      return;
    }

    // ── CSRF: single-use state must exist AND belong to THIS app ───────────
    let storedAppId: string | null = null;
    if (typeof state === "string" && state) {
      try {
        // GETDEL — atomically read + consume so a state can never be replayed.
        storedAppId = (await (this.redis as any).getdel(this.stateKey(state))) as
          | string
          | null;
      } catch {
        storedAppId = null;
      }
    }
    if (!storedAppId || storedAppId !== appId) {
      this.logger.warn(`[chanapp] oauth callback state mismatch app=${appId}`);
      this.sendPage(
        res,
        403,
        "Install expired",
        "This install link has expired or was already used. Please start again from your Platos dashboard.",
      );
      return;
    }

    if (typeof code !== "string" || !code) {
      this.sendPage(
        res,
        400,
        "Install incomplete",
        "Slack did not return an authorization code. Please try installing again.",
      );
      return;
    }

    const app = await this.loadApp(appId);
    if (!app) {
      this.sendPage(
        res,
        404,
        "App not found",
        "This app no longer exists. Please start again from your Platos dashboard.",
      );
      return;
    }

    const origin = this.publicOrigin();
    if (!origin) {
      this.logger.error(
        `[chanapp] callback blocked — PLATOS_PUBLIC_BASE_URL unset app=${appId}`,
      );
      this.sendPage(
        res,
        500,
        "Not configured",
        "This Platos deployment is missing its public base URL. Ask your administrator to set PLATOS_PUBLIC_BASE_URL.",
      );
      return;
    }

    // The redirect_uri MUST byte-match the one sent to /authorize.
    const redirectUri = this.callbackUrl(origin, String(app.id));

    let clientSecret: string;
    try {
      clientSecret = this.requireSecretString(app.clientSecret);
    } catch {
      this.logger.error(`[chanapp] client_secret decrypt failed app=${appId}`);
      this.sendPage(
        res,
        500,
        "Configuration error",
        "This app's credentials could not be read. Please contact the app owner.",
      );
      return;
    }

    // ── Exchange the code (10s bound; secrets in the body, never the URL) ──
    let json: any;
    try {
      const form = new URLSearchParams({
        code,
        client_id: String(app.clientId ?? ""),
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      });
      const resp = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      json = await resp.json();
    } catch {
      this.logger.error(`[chanapp] oauth.v2.access request failed app=${appId}`);
      this.sendPage(
        res,
        502,
        "Couldn't reach Slack",
        "We couldn't reach Slack to finish the installation. Please try again.",
      );
      return;
    }

    if (!json?.ok) {
      // Surface ONLY the Slack error code — never any request secret.
      const slackError =
        typeof json?.error === "string" ? json.error : "unknown_error";
      this.logger.warn(
        `[chanapp] oauth.v2.access rejected app=${appId} error=${slackError}`,
      );
      this.sendPage(
        res,
        400,
        "Slack declined the install",
        `Slack rejected the installation (code: ${this.htmlEscape(slackError)}). Please try again.`,
      );
      return;
    }

    // ── Extract the grant + persist the installation ──────────────────────
    const botToken = typeof json.access_token === "string" ? json.access_token : "";
    if (!botToken) {
      this.logger.error(`[chanapp] oauth grant missing bot token app=${appId}`);
      this.sendPage(
        res,
        502,
        "Install incomplete",
        "Slack did not return a usable bot token. Please try again.",
      );
      return;
    }

    const teamId = json.team?.id ?? null;
    const enterpriseId = json.enterprise?.id ?? null;
    const teamName = json.team?.name ?? json.enterprise?.name ?? null;
    const botUserId =
      typeof json.bot_user_id === "string" ? json.bot_user_id : null;
    const grantedScopes =
      typeof json.scope === "string"
        ? json.scope.split(",").map((s: string) => s.trim()).filter(Boolean)
        : [];
    const isEnterpriseInstall = json.is_enterprise_install === true;
    const installedByUserId =
      typeof json.authed_user?.id === "string" ? json.authed_user.id : null;
    // Token rotation (Phase D) — Slack only returns these when the app has
    // rotation enabled. Store forward-compatibly rather than silently dropping.
    const refreshToken =
      typeof json.refresh_token === "string" && json.refresh_token
        ? json.refresh_token
        : null;
    const tokenExpiresAt =
      typeof json.expires_in === "number" && json.expires_in > 0
        ? new Date(Date.now() + json.expires_in * 1000)
        : null;

    try {
      await this.persistence.upsertInstallationGrant(app, {
        teamId,
        enterpriseId,
        isEnterpriseInstall,
      }, {
        botToken,
        botUserId,
        grantedScopes,
        displayName: teamName,
        installedByUserId,
        refreshToken,
        tokenExpiresAt,
      });
      this.runtime.invalidateApp(String(app.id));
    } catch {
      this.logger.error(`[chanapp] installation upsert failed app=${appId}`);
      this.sendPage(
        res,
        500,
        "Couldn't save the install",
        "The installation authorized with Slack but we couldn't save it. Please try again.",
      );
      return;
    }

    this.logger.log(
      `[chanapp] installed app=${appId} enterpriseInstall=${isEnterpriseInstall}`,
    );
    const appName = this.appName(app);
    const workspace =
      typeof teamName === "string" && teamName ? teamName : "your workspace";
    this.sendPage(
      res,
      200,
      `${appName} installed`,
      `${this.htmlEscape(appName)} was installed to ${this.htmlEscape(
        workspace,
      )}. You can close this tab and message the bot in Slack.`,
    );
  }

  private async loadApp(appId: string): Promise<any | null> {
    if (!appId) return null;
    try {
      return await this.persistence.loadApp(appId);
    } catch {
      return null;
    }
  }

  private appName(app: any): string {
    const name = typeof app?.displayName === "string" ? app.displayName.trim() : "";
    return name || "The app";
  }

  private stateKey(state: string): string {
    return `chanapp:oauth:state:${state}`;
  }

  // ── Per-IP rate limit (mirrors public-guest-token.controller.ts) ─────────
  // Fixed 5-min bucket, Redis INCR + first-hit EXPIRE. Fails OPEN on a Redis
  // error — consistent with the EOBD.89 guest-token policy (a degraded Redis
  // shouldn't take down legitimate installs; the state write below would fail
  // closed anyway).
  private static readonly RL_WINDOW_SECONDS = 300;

  private async rateLimited(req: ExpressRequest): Promise<boolean> {
    const limit =
      Number(process.env.PLATOS_CHANNEL_OAUTH_IP_LIMIT) > 0
        ? Number(process.env.PLATOS_CHANNEL_OAUTH_IP_LIMIT)
        : 30;
    const windowSeconds = ChannelAppOAuthController.RL_WINDOW_SECONDS;
    const ip = this.clientIp(req);
    try {
      const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
      const key = `chanapp:oauth:rl:${ip}:${bucket}`;
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, windowSeconds).catch(() => undefined);
      }
      if (count > limit) {
        this.logger.warn(`[chanapp] oauth rate limit exceeded ip=${ip}`);
        return true;
      }
      return false;
    } catch {
      return false; // Redis hiccup — fail open, same policy as EOBD.12/89.
    }
  }

  private clientIp(req: ExpressRequest): string {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    if (Array.isArray(xff) && xff.length > 0) {
      const first = xff[0]?.trim();
      if (first) return first;
    }
    return req.socket?.remoteAddress || "unknown";
  }

  private callbackUrl(origin: string, appId: string): string {
    return `${origin}/api/v1/channels/oauth/${appId}/callback`;
  }

  private requireSecretString(stored: unknown): string {
    if (typeof stored !== "string" || !stored) {
      throw new Error("secret unavailable");
    }
    return stored;
  }

  /**
   * Public origin, backend-configured (never guessed client-side):
   * PLATOS_PUBLIC_BASE_URL wins; else derived from PLATOS_AGENT_PUBLIC_WS_URL
   * (wss://host → https://host); else null. Mirrors
   * ChannelsController.publicOrigin() — kept local to avoid touching a shared
   * file outside this slice.
   */
  private publicOrigin(): string | null {
    const explicit = (process.env.PLATOS_PUBLIC_BASE_URL || "")
      .trim()
      .replace(/\/+$/, "");
    if (explicit) return explicit;
    const ws = (process.env.PLATOS_AGENT_PUBLIC_WS_URL || "")
      .trim()
      .replace(/\/+$/, "");
    if (ws.startsWith("wss://")) return `https://${ws.slice(6)}`;
    if (ws.startsWith("ws://")) return `http://${ws.slice(5)}`;
    return null;
  }

  // ── Minimal, self-contained, theme-neutral HTML responses ────────────────
  private sendPage(
    res: ExpressResponse,
    status: number,
    heading: string,
    message: string,
  ): void {
    res.status(status).type("html").send(this.renderPage(heading, message));
  }

  private renderPage(heading: string, message: string): string {
    // Fully self-contained (inline CSS, no external resources). Dynamic values
    // are HTML-escaped by the callers that interpolate app/team/error strings.
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${this.htmlEscape(heading)}</title>
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; height:100%; }
  body {
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display:flex; align-items:center; justify-content:center; min-height:100%;
    background:#f5f6f8; color:#1f2430; padding:24px;
  }
  .card {
    max-width:440px; width:100%; background:#fff; border-radius:14px;
    box-shadow:0 8px 30px rgba(0,0,0,.08); padding:32px; text-align:center;
  }
  h1 { font-size:20px; margin:0 0 12px; }
  p { margin:0; color:#5b6472; }
  @media (prefers-color-scheme: dark) {
    body { background:#0f1115; color:#e6e8ec; }
    .card { background:#171a21; box-shadow:0 8px 30px rgba(0,0,0,.5); }
    p { color:#a4adba; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${this.htmlEscape(heading)}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
  }

  private htmlEscape(s: string): string {
    return String(s).replace(/[&<>"']/g, (c) =>
      c === "&"
        ? "&amp;"
        : c === "<"
          ? "&lt;"
          : c === ">"
            ? "&gt;"
            : c === '"'
              ? "&quot;"
              : "&#39;",
    );
  }
}
