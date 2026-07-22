import {
  Controller,
  Get,
  Injectable,
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
import { ModuleRef } from "@nestjs/core";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { ConversationService } from "../memory/conversation.service";

/**
 * Connect v3 — Phase C hosted ACCOUNT LINKING (Sign in with Slack / OIDC).
 *
 * An installed marketplace app can require (or offer) that a Slack user attach a
 * VERIFIED EMAIL identity to the same canonical Platos end-user as their Slack
 * identity — zero developer code; the platform owns the whole choreography.
 *
 * SHAPE:
 *   linkStart(app, installation, {teamId, slackUserId, channel, threadTs})
 *     — INTERNAL. Called from the runtime (policy gate / `link` command) to mint
 *       a single-use nonce bound to (team, user, reply target) into Redis
 *       (`chanapp:link:<nonce>`, TTL 900s) and return the hosted-flow URL.
 *
 *   GET /api/v1/channels/link/:nonce
 *     — the user clicks the URL. Loads the nonce payload (NOT consumed yet),
 *       mints a SECOND fresh `oidcNonce` alongside it, and 302-redirects to the
 *       Slack SIWS authorize screen (`openid profile email`).
 *
 *   GET /api/v1/channels/link/callback?code&state
 *     — Slack's redirect target. GETDELs the nonce (single-use), exchanges the
 *       code, then — the mandated security design — does NOT trust the raw
 *       id_token JWT (no JWKS/crypto verify dep): it calls openid.connect.userInfo
 *       and treats THAT response as the authoritative claims. The id_token is
 *       base64-decoded ONLY to check its `nonce` equals the stored `oidcNonce`.
 *       It REQUIRES email_verified === true AND that the userInfo team_id/user_id
 *       EXACTLY match the nonce's (teamId, slackUserId) — i.e. the person who
 *       clicked in Slack is the person who authenticated (else 403 mismatch) —
 *       then attaches the verified slack + email identities to one canonical
 *       Platos person (link-not-merge) and fires a best-effort confirmation DM.
 *
 * PUBLIC surface: both GET routes are anonymous (the caller is a browser
 * mid-flow / Slack, not a Platos user). ScopeGuard allowlists the
 * `/api/v1/channels/link/` prefix; auth lives IN this slice (single-use nonce +
 * OIDC nonce binding + authoritative-claim match). Every Slack HTTP call is
 * bounded by a 10s AbortSignal.timeout; no token/secret is ever logged or
 * rendered into an HTML response. Per-IP rate limiting mirrors the OAuth
 * controller (anonymous surface, RateLimitGuard never sees it).
 *
 * SIWS redirect-URL requirement: `<publicOrigin>/api/v1/channels/link/callback`
 * must be registered in the Slack app's OAuth Redirect URLs (surfaced in the
 * management descriptions — item (6)).
 */

// ── nonce payload persisted in Redis (`chanapp:link:<nonce>`) ───────────────
interface LinkNoncePayload {
  appId: string;
  installationId: string;
  /**
   * The runtime's HANDLE team component: installation.teamId ?? enterpriseId.
   * For an Enterprise Grid ORG-LEVEL install this is the "E…" enterprise id —
   * it builds the identity handle (`<team>:<user>`) so the gate lookup stays
   * consistent, but it is NOT what SIWS userInfo returns as team_id.
   */
  teamId: string;
  slackUserId: string;
  /**
   * The originating WORKSPACE team id ("T…") from the verified event envelope.
   * SIWS userInfo's https://slack.com/team_id is always a workspace id, so the
   * callback matches against THIS (falling back to teamId when absent — for a
   * workspace-level install they are the same value).
   */
  eventTeamId?: string;
  replyChannel: string;
  replyThreadTs: string | null;
  /** Minted on the /:nonce redirect; bound into the SIWS authorize `nonce`. */
  oidcNonce?: string;
}

type CallbackResult =
  | { ok: true; email: string }
  | {
      ok: false;
      reason: "expired" | "config" | "slack" | "mismatch" | "attach" | "conflict";
    };

type RedirectResult =
  | { redirectUrl: string }
  | { error: "not_found" | "config" };

@Injectable()
export class ChannelLinkService {
  private readonly logger = new Logger(ChannelLinkService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    private readonly messageCrypto: MessageCryptoService,
    private readonly conversationService: ConversationService,
    // Phase D — used to lazily resolve ChannelRuntimeService so the
    // confirmation DM reads its bot token through the shared locked-refresh
    // seam (getFreshBotToken). ModuleRef is always container-provided.
    private readonly moduleRef: ModuleRef,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // INTERNAL — mint a link nonce + return the hosted-flow URL
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Mint a single-use 32-byte-hex nonce bound to (team, user, reply target),
   * persist it (`chanapp:link:<nonce>`, TTL 900s), and return the hosted URL
   * `<publicOrigin>/api/v1/channels/link/<nonce>`. Returns null when the public
   * origin is unset or Redis is unavailable (the caller then skips offering the
   * link rather than emitting a broken one). Never throws.
   */
  async linkStart(
    app: any,
    installation: any,
    coords: {
      teamId: string;
      slackUserId: string;
      channel: string;
      threadTs?: string | null;
      /** Originating workspace team id ("T…") from the event envelope — see LinkNoncePayload. */
      eventTeamId?: string | null;
    },
  ): Promise<string | null> {
    const appId = String(app?.id ?? "");
    const installationId = String(installation?.id ?? "");
    if (!appId || !installationId) return null;

    const origin = this.publicOrigin();
    if (!origin) {
      this.logger.error(
        `[chanapp-link] linkStart blocked — PLATOS_PUBLIC_BASE_URL unset app=${appId}`,
      );
      return null;
    }

    const nonce = crypto.randomBytes(32).toString("hex");
    const payload: LinkNoncePayload = {
      appId,
      installationId,
      teamId: String(coords.teamId ?? ""),
      slackUserId: String(coords.slackUserId ?? ""),
      eventTeamId: coords.eventTeamId ? String(coords.eventTeamId) : undefined,
      replyChannel: String(coords.channel ?? ""),
      replyThreadTs: coords.threadTs ? String(coords.threadTs) : null,
    };
    try {
      await this.redis.set(
        this.nonceKey(nonce),
        JSON.stringify(payload),
        "EX",
        900,
      );
    } catch {
      this.logger.error(`[chanapp-link] nonce persist failed app=${appId}`);
      return null;
    }
    return `${origin}/api/v1/channels/link/${nonce}`;
  }

  // ───────────────────────────────────────────────────────────────────────
  // /:nonce — load payload (NOT consumed), mint oidcNonce, build SIWS URL
  // ───────────────────────────────────────────────────────────────────────

  async buildAuthorizeRedirect(nonce: string): Promise<RedirectResult> {
    // Read WITHOUT consuming — the single-use GETDEL happens on /callback.
    let raw: string | null = null;
    try {
      raw = (await this.redis.get(this.nonceKey(nonce))) as string | null;
    } catch {
      raw = null;
    }
    if (!raw) return { error: "not_found" };

    let payload: LinkNoncePayload;
    try {
      payload = JSON.parse(raw) as LinkNoncePayload;
    } catch {
      return { error: "not_found" };
    }

    const app = await this.loadApp(payload.appId);
    if (!app) return { error: "config" };

    const origin = this.publicOrigin();
    if (!origin) return { error: "config" };

    // Fresh OIDC nonce, stored alongside the payload so /callback can bind the
    // returned id_token to THIS authorize request (anti-replay / anti-CSRF).
    const oidcNonce = crypto.randomBytes(32).toString("hex");
    payload.oidcNonce = oidcNonce;
    try {
      // Re-persist with the full 900s window so the user has time to complete
      // Slack auth; the single-use property is still enforced by the /callback
      // GETDEL, not by the TTL.
      await this.redis.set(
        this.nonceKey(nonce),
        JSON.stringify(payload),
        "EX",
        900,
      );
    } catch {
      this.logger.error(`[chanapp-link] oidcNonce persist failed app=${payload.appId}`);
      return { error: "config" };
    }

    // scope = openid profile email — SIWS returns verified email + team/user ids.
    const params = new URLSearchParams({
      response_type: "code",
      scope: "openid profile email",
      client_id: String(app.clientId ?? ""),
      state: nonce,
      nonce: oidcNonce,
      redirect_uri: this.callbackUrl(origin),
    });
    this.logger.log(`[chanapp-link] siws authorize redirect app=${payload.appId}`);
    return {
      redirectUrl: `https://slack.com/openid/connect/authorize?${params.toString()}`,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // /callback — exchange, userInfo-authoritative claims, attach, DM
  // ───────────────────────────────────────────────────────────────────────

  async completeCallback(code: string, state: string): Promise<CallbackResult> {
    // ── Single-use: atomically read + consume the nonce ───────────────────
    let raw: string | null = null;
    try {
      raw = (await (this.redis as any).getdel(this.nonceKey(state))) as
        | string
        | null;
    } catch {
      raw = null;
    }
    if (!raw) return { ok: false, reason: "expired" };

    let payload: LinkNoncePayload;
    try {
      payload = JSON.parse(raw) as LinkNoncePayload;
    } catch {
      return { ok: false, reason: "expired" };
    }
    const {
      appId,
      installationId,
      teamId,
      slackUserId,
      eventTeamId,
      replyChannel,
      replyThreadTs,
      oidcNonce,
    } = payload;

    const app = await this.loadApp(appId);
    if (!app) return { ok: false, reason: "config" };

    const origin = this.publicOrigin();
    if (!origin) return { ok: false, reason: "config" };

    let clientSecret: string;
    try {
      clientSecret = this.decryptSecretString(app.clientSecret);
    } catch {
      this.logger.error(`[chanapp-link] client_secret decrypt failed app=${appId}`);
      return { ok: false, reason: "config" };
    }

    // ── Token exchange (10s bound; secrets in the body, never the URL) ─────
    // redirect_uri MUST byte-match the one sent to /authorize.
    let tokenJson: any;
    try {
      const form = new URLSearchParams({
        code,
        client_id: String(app.clientId ?? ""),
        client_secret: clientSecret,
        redirect_uri: this.callbackUrl(origin),
      });
      const resp = await fetch("https://slack.com/api/openid.connect.token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      tokenJson = await resp.json();
    } catch {
      this.logger.error(`[chanapp-link] openid.connect.token failed app=${appId}`);
      return { ok: false, reason: "slack" };
    }
    if (
      !tokenJson?.ok ||
      typeof tokenJson.access_token !== "string" ||
      !tokenJson.access_token
    ) {
      this.logger.warn(
        `[chanapp-link] token exchange rejected app=${appId} error=${
          typeof tokenJson?.error === "string" ? tokenJson.error : "unknown_error"
        }`,
      );
      return { ok: false, reason: "slack" };
    }
    const accessToken = tokenJson.access_token as string;
    const idToken = typeof tokenJson.id_token === "string" ? tokenJson.id_token : "";

    // ── AUTHORITATIVE claims: openid.connect.userInfo (NOT the raw id_token) ─
    // The mandated security design: do not verify the unsigned JWT and do not
    // pull in a JWKS/crypto dep — trust the userInfo response reached with the
    // access token instead.
    let info: any;
    try {
      const resp = await fetch(
        "https://slack.com/api/openid.connect.userInfo",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      info = await resp.json();
    } catch {
      this.logger.error(`[chanapp-link] openid.connect.userInfo failed app=${appId}`);
      return { ok: false, reason: "slack" };
    }
    if (info?.ok === false) {
      this.logger.warn(
        `[chanapp-link] userInfo rejected app=${appId} error=${
          typeof info?.error === "string" ? info.error : "unknown_error"
        }`,
      );
      return { ok: false, reason: "slack" };
    }

    const email =
      typeof info?.email === "string" ? info.email.trim().toLowerCase() : "";
    const emailVerified =
      info?.email_verified === true || info?.email_verified === "true";
    const infoTeamId = String(info?.["https://slack.com/team_id"] ?? "");
    const infoUserId = String(info?.["https://slack.com/user_id"] ?? "");

    // ── The id_token's `nonce` must equal the stored oidcNonce (decode only) ─
    const tokenNonce = this.decodeJwtNonce(idToken);
    if (
      !oidcNonce ||
      !tokenNonce ||
      !this.constEq(String(tokenNonce), String(oidcNonce))
    ) {
      this.logger.warn(`[chanapp-link] oidc nonce mismatch app=${appId}`);
      return { ok: false, reason: "mismatch" };
    }

    // ── REQUIRE verified email AND that the authenticated Slack person is the
    //    exact person who clicked in Slack (team_id + user_id match). ────────
    if (!email || !emailVerified) {
      this.logger.warn(`[chanapp-link] email not verified app=${appId}`);
      return { ok: false, reason: "mismatch" };
    }
    // userInfo's team_id is always the user's WORKSPACE id ("T…"). For an
    // Enterprise Grid ORG-LEVEL install the handle team (payload.teamId) is the
    // "E…" enterprise id, which can never match — so compare against the event
    // envelope's workspace id when the runtime supplied it, falling back to the
    // handle team (identical for workspace-level installs). user_id stays an
    // exact match either way.
    const expectedTeamId = String(eventTeamId || teamId || "");
    if (
      infoTeamId !== expectedTeamId ||
      infoUserId !== String(slackUserId ?? "")
    ) {
      const enterpriseHint =
        !eventTeamId && String(teamId ?? "").startsWith("E")
          ? " (enterprise org-level install without eventTeamId — the runtime must pass the event envelope's workspace team_id or this can never match)"
          : "";
      this.logger.warn(
        `[chanapp-link] identity mismatch app=${appId}${enterpriseHint}`,
      );
      return { ok: false, reason: "mismatch" };
    }

    // ── Attach identity (link-not-merge) to the app OWNER's scope ──────────
    // resolveEndUser anchors on the existing VERIFIED slack identity (created on
    // the message path) and links the verified email onto that SAME canonical
    // person — unifying the slack person with any pre-existing email-keyed
    // person per the identity foundation's rules. NEVER maps by typed email.
    const handle = `${teamId}:${slackUserId}`;
    const scope = {
      organizationId: String(app.organizationId),
      projectId: String(app.projectId),
      environmentId: String(app.environmentId),
      userId: `slack:${handle}`,
      userIdentities: [
        { channel: "slack", handle, verified: true },
        { channel: "email", handle: email, verified: true },
      ],
    };
    let resolvedId: string | null = null;
    try {
      resolvedId = await this.conversationService.resolveEndUser(scope, {});
    } catch {
      resolvedId = null;
    }
    if (!resolvedId) {
      this.logger.error(`[chanapp-link] identity attach failed app=${appId}`);
      return { ok: false, reason: "attach" };
    }

    // ── VERIFY the email actually attached to the resolved person ──────────
    // resolveEndUser's step (c) silently SKIPS attaching a claim whose
    // (channel, handle) row already belongs to a DIFFERENT person
    // (link-not-merge) — but still returns resolvedId. Without this check a
    // P_slack/P_email split renders "Account linked" while the policy gate
    // (isSlackUserLinked: slack row → person → verified email row) keeps
    // withholding turns forever. Re-query the email row and require it to be
    // verified AND pointing at the resolved person; otherwise render an honest
    // failure instead of a success-but-still-gated loop.
    //
    // TODO(identity): decide the deliberate unification behavior for the
    // P_slack/P_email split — today neither anchor order can unify once both
    // persons exist (link-not-merge never re-points, never merges).
    let emailRow: { platosEndUserId: string; verified: boolean } | null = null;
    let emailRowLookupOk = false;
    try {
      emailRow = await this.prisma.platosEndUserIdentity.findUnique({
        where: {
          organizationId_projectId_environmentId_channel_handle: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            channel: "email",
            handle: email,
          },
        },
        select: { platosEndUserId: true, verified: true },
      });
      emailRowLookupOk = true;
    } catch {
      emailRow = null;
    }
    if (!emailRowLookupOk || !emailRow) {
      // DB blip or the attach itself failed — retryable, not a conflict.
      this.logger.error(
        `[chanapp-link] email identity verify-back failed app=${appId}`,
      );
      return { ok: false, reason: "attach" };
    }
    if (emailRow.platosEndUserId !== resolvedId) {
      // The email already belongs to a different canonical person — the
      // link-not-merge split. Log the split (redacted handle, never raw PII).
      this.logger.warn(
        `[chanapp-link] link conflict app=${appId} email=${this.redactHandle(
          email,
        )} attachedTo=${emailRow.platosEndUserId} resolved=${resolvedId} (link-not-merge split)`,
      );
      return { ok: false, reason: "conflict" };
    }
    if (emailRow.verified !== true) {
      // Same person but the row is unverified (e.g. flipped by the
      // tokens_revoked lifecycle). We JUST verified this email via SIWS for
      // this exact person — re-verify in place (no re-pointing involved).
      try {
        await this.prisma.platosEndUserIdentity.updateMany({
          where: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            channel: "email",
            handle: email,
            platosEndUserId: resolvedId,
          },
          data: { verified: true },
        });
      } catch {
        this.logger.error(
          `[chanapp-link] email re-verify failed app=${appId}`,
        );
        return { ok: false, reason: "attach" };
      }
    }

    this.logger.log(
      `[chanapp-link] account linked app=${appId} installation=${installationId}`,
    );

    // Best-effort confirmation DM — fire-and-forget so the success page renders
    // immediately (never blocks / fails the linking result).
    void this.postConfirmationDm(installationId, app, replyChannel, replyThreadTs, email);

    return { ok: true, email };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Confirmation DM (best-effort)
  // ───────────────────────────────────────────────────────────────────────

  private async postConfirmationDm(
    installationId: string,
    app: any,
    channel: string,
    threadTs: string | null,
    email: string,
  ): Promise<void> {
    try {
      if (!installationId || !channel) return;
      const installation =
        await this.prisma.platosChannelInstallation.findUnique({
          where: { id: String(installationId) },
        });
      if (!installation) return;
      // Phase D — read the bot token through ChannelRuntimeService's shared
      // locked-refresh seam so a rotating install's near-expiry token is
      // refreshed (under `chanapp:refresh:<installationId>`) BEFORE we post,
      // rather than decrypting a possibly-expired token here. Lazy `require`
      // (not a top-level import) because channel-runtime.service.ts already
      // imports THIS file for linkStart — a static back-import would form a
      // load-order cycle that breaks ChannelRuntimeService's own
      // @Inject(ChannelLinkService) design:paramtypes. Resolved via ModuleRef
      // (strict:false) since both providers live in the same module.
      let botToken: string | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ChannelRuntimeService: Runtime } = require("./channel-runtime.service");
        const runtime = this.moduleRef.get(Runtime, { strict: false });
        if (runtime) botToken = await runtime.getFreshBotToken(installation, app);
      } catch {
        botToken = null;
      }
      // Fallback: runtime not registered (e.g. a focused test module) or a
      // total decrypt failure — best-effort direct decrypt keeps the prior
      // behavior. A rotating token past expiry that also fails to refresh is
      // already handled inside getFreshBotToken (degrades to current token).
      if (!botToken) botToken = this.decryptSecretField(installation.botToken);
      if (!botToken) return;
      const body: Record<string, unknown> = {
        channel,
        text: `✅ Account linked — I now know you as ${email}`,
      };
      if (threadTs) body.thread_ts = threadTs;
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        /* non-JSON — treat as failure below */
      }
      if (!json?.ok) {
        this.logger.warn(
          `[chanapp-link] confirmation DM rejected error=${json?.error ?? res.status}`,
        );
      }
    } catch {
      this.logger.warn(
        `[chanapp-link] confirmation DM failed installation=${installationId}`,
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers (mirror channel-app-oauth.controller.ts / channel-runtime.service.ts)
  // ───────────────────────────────────────────────────────────────────────

  private nonceKey(nonce: string): string {
    return `chanapp:link:${nonce}`;
  }

  private callbackUrl(origin: string): string {
    return `${origin}/api/v1/channels/link/callback`;
  }

  private async loadApp(appId: string): Promise<any | null> {
    if (!appId) return null;
    try {
      return await this.prisma.platosChannelApp.findUnique({
        where: { id: String(appId) },
      });
    } catch {
      return null;
    }
  }

  /**
   * Base64-decode the id_token payload (segment 1) WITHOUT signature
   * verification and return its `nonce` claim — used ONLY to bind the token to
   * this authorize request. Deliberately no JWKS/crypto verify: the trusted
   * claims come from openid.connect.userInfo, not this JWT.
   */
  private decodeJwtNonce(idToken: string): string | null {
    try {
      const parts = String(idToken).split(".");
      if (parts.length < 2 || !parts[1]) return null;
      const json = Buffer.from(parts[1], "base64url").toString("utf8");
      const payload = JSON.parse(json);
      return typeof payload?.nonce === "string" ? payload.nonce : null;
    } catch {
      return null;
    }
  }

  /** PII-safe log form of an identity handle (mirrors ConversationService). */
  private redactHandle(handle: string): string {
    return `sha256:${crypto
      .createHash("sha256")
      .update(String(handle))
      .digest("hex")
      .slice(0, 12)}`;
  }

  private constEq(a: string, b: string): boolean {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    try {
      return crypto.timingSafeEqual(ab, bb);
    } catch {
      return false;
    }
  }

  /** Decrypt the app's ENCRYPTED clientSecret envelope → plaintext (fail-closed). */
  private decryptSecretString(stored: unknown): string {
    const parsed = JSON.parse(String(stored));
    const decrypted = this.messageCrypto.decryptJsonField(parsed);
    // On a key mismatch decryptJsonField returns its {__platos_enc,error}
    // envelope (an object) — treat anything non-string as a fail-closed error
    // rather than POSTing a broken secret to Slack.
    if (typeof decrypted !== "string" || !decrypted) {
      throw new Error("secret unavailable");
    }
    return decrypted;
  }

  /** Decrypt a single ENCRYPTED string column → plaintext, or null (best-effort). */
  private decryptSecretField(stored: unknown): string | null {
    if (typeof stored !== "string" || !stored) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch {
      return null;
    }
    const dec = this.messageCrypto.decryptJsonField(parsed);
    return typeof dec === "string" && dec ? dec : null;
  }

  /**
   * Public origin, backend-configured (never guessed client-side):
   * PLATOS_PUBLIC_BASE_URL wins; else derived from PLATOS_AGENT_PUBLIC_WS_URL
   * (wss://host → https://host); else null. Mirrors ChannelAppOAuthController.
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
}

/**
 * The HTTP surface for the hosted linking flow. Thin: rate-limit → delegate to
 * ChannelLinkService → render a self-contained HTML page (or 302). The static
 * `/callback` route is declared BEFORE the `/:nonce` route so Express matches it
 * first, and `/:nonce` additionally requires a 64-hex-char nonce (so "callback"
 * can never be mistaken for a nonce).
 */
@Controller()
export class ChannelLinkController {
  private readonly logger = new Logger(ChannelLinkController.name);

  private static readonly RL_WINDOW_SECONDS = 300;

  constructor(
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    private readonly linkService: ChannelLinkService,
  ) {}

  // ── GET /callback — declared first so it wins over /:nonce ────────────────
  @Get("api/v1/channels/link/callback")
  async callback(
    @Req() req: ExpressRequest,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    if (await this.rateLimited(req)) {
      this.sendPage(
        res,
        429,
        "Too many requests",
        "Too many attempts from your network. Please try again in a few minutes.",
      );
      return;
    }

    if (typeof code !== "string" || !code || typeof state !== "string" || !state) {
      this.sendPage(
        res,
        400,
        "Sign-in incomplete",
        "Slack did not return the information needed to finish linking. Please start again from Slack.",
      );
      return;
    }

    const result = await this.linkService.completeCallback(code, state);
    if (result.ok) {
      this.sendPage(
        res,
        200,
        "Account linked",
        `You're all set — your account is now linked as ${this.htmlEscape(
          result.email,
        )}. You can close this tab and return to Slack.`,
      );
      return;
    }

    switch (result.reason) {
      case "expired":
        this.sendPage(
          res,
          403,
          "Link expired",
          "This linking request has expired or was already used. Please start again from Slack.",
        );
        return;
      case "mismatch":
        this.sendPage(
          res,
          403,
          "Identity mismatch",
          "We couldn't verify that this Slack account matches the one that started linking. Please start again from Slack.",
        );
        return;
      case "slack":
        this.sendPage(
          res,
          502,
          "Couldn't reach Slack",
          "We couldn't complete the sign-in with Slack. Please try again.",
        );
        return;
      case "attach":
        this.sendPage(
          res,
          500,
          "Couldn't finish linking",
          "We verified your account but couldn't finish linking just now. Please try again.",
        );
        return;
      case "conflict":
        this.sendPage(
          res,
          409,
          "Email already linked",
          "This email address is already connected to a different account here, so we couldn't finish linking. Please contact the app owner to resolve it.",
        );
        return;
      case "config":
      default:
        this.sendPage(
          res,
          500,
          "Not configured",
          "This linking flow is not fully configured. Please contact the app owner.",
        );
        return;
    }
  }

  // ── GET /:nonce — redirect into Slack SIWS ────────────────────────────────
  @Get("api/v1/channels/link/:nonce")
  async redirect(
    @Req() req: ExpressRequest,
    @Param("nonce") nonce: string,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    if (await this.rateLimited(req)) {
      this.sendPage(
        res,
        429,
        "Too many requests",
        "Too many attempts from your network. Please try again in a few minutes.",
      );
      return;
    }

    // A nonce is 32 random bytes hex = 64 lowercase hex chars. This also rejects
    // the sibling static segment "callback" outright.
    if (!/^[a-f0-9]{64}$/.test(String(nonce))) {
      this.sendPage(
        res,
        404,
        "Link not found",
        "This link is no longer valid. Please start again from Slack.",
      );
      return;
    }

    const out = await this.linkService.buildAuthorizeRedirect(nonce);
    if ("redirectUrl" in out) {
      res.redirect(302, out.redirectUrl);
      return;
    }
    if (out.error === "not_found") {
      this.sendPage(
        res,
        403,
        "Link expired",
        "This linking request has expired or was already used. Please start again from Slack.",
      );
      return;
    }
    this.sendPage(
      res,
      500,
      "Not configured",
      "This linking flow is not fully configured. Please contact the app owner.",
    );
  }

  // ── Per-IP rate limit (mirrors ChannelAppOAuthController) ─────────────────
  // Anonymous surface; RateLimitGuard never sees it (no request.scope). Fixed
  // 5-min bucket, Redis INCR + first-hit EXPIRE. Fails OPEN on a Redis blip.
  private async rateLimited(req: ExpressRequest): Promise<boolean> {
    const limit =
      Number(process.env.PLATOS_CHANNEL_LINK_IP_LIMIT) > 0
        ? Number(process.env.PLATOS_CHANNEL_LINK_IP_LIMIT)
        : 30;
    const windowSeconds = ChannelLinkController.RL_WINDOW_SECONDS;
    const ip = this.clientIp(req);
    try {
      const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
      const key = `chanapp:link:rl:${ip}:${bucket}`;
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, windowSeconds).catch(() => undefined);
      }
      if (count > limit) {
        this.logger.warn(`[chanapp-link] rate limit exceeded ip=${ip}`);
        return true;
      }
      return false;
    } catch {
      return false; // Redis hiccup — fail open, same policy as the OAuth slice.
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

  // ── Self-contained, theme-neutral HTML responses (mirror the OAuth slice) ─
  private sendPage(
    res: ExpressResponse,
    status: number,
    heading: string,
    message: string,
  ): void {
    res.status(status).type("html").send(this.renderPage(heading, message));
  }

  private renderPage(heading: string, message: string): string {
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
