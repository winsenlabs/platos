import {
  Controller,
  Post,
  Param,
  Req,
  Res,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import * as crypto from "node:crypto";
import {
  ChannelDeliveryError,
  ChannelRuntimeService,
  type ChannelAppEventContext,
} from "./channel-runtime.service";
import { ChannelPersistenceService } from "./channel-persistence.service";

/**
 * Express request augmented with the raw body Buffer. `main.ts` boots the app
 * with `rawBody: true`, so `useBodyParser` stashes the exact received bytes
 * here — we HMAC these for the Slack signature, not the JSON-parsed body.
 */
type RawBodyExpressRequest = ExpressRequest & { rawBody?: Buffer };

/**
 * Connect v3 — the ONE Slack Events API request URL per marketplace app.
 *
 *   POST /api/v1/channels/apps/:appId/events
 *
 * PUBLIC surface (ScopeGuard allowlists the `/api/v1/channels/apps/` prefix —
 * see scope.guard.ts). The caller is Slack, not a Platos user, so there is no
 * per-scope session. Auth is IN this controller, over the RAW body:
 *
 *   Slack signature v2 — `x-slack-signature` must equal
 *     'v0=' + HMAC-SHA256(signingSecret, 'v0:' + <x-slack-request-timestamp>
 *     + ':' + rawBody), compared timing-safely, with a stale-timestamp reject
 *     (> 300s). The signing secret is the app's DECRYPTED `signingSecret`.
 *
 * ORDER (Slack's < 3s ack budget):
 *   load app → verify signature → url_verification fast-ack → encrypt + insert
 *   immutable inbox row → ACK 200 → leased same-process worker.
 *
 * DEDUPE: ChannelEventInbox has a durable `(appId,eventId)` unique key. Failed
 * or expired-leased rows are recovered by the periodic sweep; only completed
 * duplicates receive `x-slack-no-retry: 1`.
 *
 * UNINSTALL hygiene: `app_uninstalled` + `tokens_revoked` run through the same
 * durable worker and remain idempotent (SOFT revoke; never hard-delete).
 *
 * Logging: appId + event kind ONLY. Never message text, tokens, or secrets.
 */
@Controller()
export class ChannelAppEventsController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelAppEventsController.name);

  private static readonly MAX_SKEW_SECONDS = 300;
  private static readonly EVENT_LEASE_MS = 60_000;
  private readonly workerId = crypto.randomUUID();
  private readonly activeInbox = new Set<string>();
  private readonly activeAborts = new Map<string, AbortController>();
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(
    private readonly persistence: ChannelPersistenceService,
    private readonly runtime: ChannelRuntimeService,
  ) {}

  onModuleInit(): void {
    if (this.destroyed) return;
    void this.recoverChannelEvents();
    this.recoveryTimer = setInterval(() => void this.recoverChannelEvents(), 5_000);
    (this.recoveryTimer as any)?.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    for (const controller of this.activeAborts.values()) controller.abort();
    this.activeAborts.clear();
  }

  @Post("api/v1/channels/apps/:appId/events")
  async events(
    @Req() req: RawBodyExpressRequest,
    @Res() res: ExpressResponse,
    @Param("appId") appId: string,
  ): Promise<void> {
    // ── Load app ──────────────────────────────────────────────────────────
    const app = await this.loadApp(appId);
    if (!app) {
      // Opaque 404 — do not reveal whether the app id exists.
      res.status(404).json({ error: "not_found" });
      return;
    }

    // ── Verify the Slack v0 signature over the RAW body ───────────────────
    let signingSecret: string;
    try {
      signingSecret = this.requireSecretString(app.signingSecret);
    } catch {
      this.logger.error(`[chanapp] signing_secret decrypt failed app=${appId}`);
      res.status(500).json({ error: "app_unavailable" });
      return;
    }

    const rawBody = req.rawBody ?? Buffer.from("");
    const timestamp = this.firstHeader(req.headers["x-slack-request-timestamp"]);
    const signature = this.firstHeader(req.headers["x-slack-signature"]);
    if (!this.verifySlackSignature(signingSecret, rawBody, timestamp, signature)) {
      this.logger.warn(`[chanapp] slack signature rejected app=${appId}`);
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    // Body is now provider-verified — parse the exact bytes we HMAC'd.
    let envelope: any;
    try {
      envelope = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    // ── url_verification fast-ack ─────────────────────────────────────────
    if (
      envelope?.type === "url_verification" &&
      typeof envelope.challenge === "string"
    ) {
      this.logger.log(`[chanapp] slack url_verification fast-ack app=${appId}`);
      res.status(200).json({ challenge: envelope.challenge });
      return;
    }

    // ── Durable admission before ACK ─────────────────────────────────────
    const eventId =
      typeof envelope?.event_id === "string" ? envelope.event_id : null;
    const isRetry = this.firstHeader(req.headers["x-slack-retry-num"]) != null;
    if (!eventId) {
      res.status(400).json({ error: "event_id_required" });
      return;
    }
    let inbox: any;
    try {
      // Only the verified provider envelope is encrypted and stored. Signature,
      // timestamp, retry headers, and signing secret never enter the inbox.
      inbox = await this.persistence.enqueueChannelEvent(
        String(app.id),
        eventId,
        envelope,
      );
    } catch {
      this.logger.error(`[chanapp] durable event admission failed app=${appId}`);
      res.status(503).json({ error: "event_not_persisted" });
      return;
    }

    const terminal = inbox.status === "COMPLETED" || inbox.status === "DISCARDED";
    if (terminal && isRetry) {
      res.setHeader("x-slack-no-retry", "1");
    }
    res.status(200).json({ ok: true });
    if (!terminal) this.scheduleInbox(String(inbox.id));
  }

  private scheduleInbox(inboxId: string): void {
    if (this.destroyed || !inboxId || this.activeInbox.has(inboxId)) return;
    setImmediate(() => void this.processInbox(inboxId));
  }

  private async recoverChannelEvents(): Promise<void> {
    if (this.destroyed) return;
    try {
      const rows = await this.persistence.listRecoverableChannelEvents();
      if (this.destroyed) return;
      for (const row of rows) this.scheduleInbox(String(row.id));
    } catch {
      this.logger.error("[chanapp] event inbox recovery sweep failed");
    }
  }

  private async processInbox(inboxId: string): Promise<void> {
    if (this.destroyed || this.activeInbox.has(inboxId)) return;
    this.activeInbox.add(inboxId);
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const abortController = new AbortController();
    this.activeAborts.set(inboxId, abortController);
    let leaseGeneration = 0;
    try {
      const claimed = await this.persistence.claimChannelEvent(
        inboxId,
        this.workerId,
        ChannelAppEventsController.EVENT_LEASE_MS,
      );
      if (!claimed) return;
      if (abortController.signal.aborted) throw new Error("channel event worker shutting down");
      leaseGeneration = Number(claimed.leaseGeneration);
      let deliveryCompleted = !!claimed.deliveryCompletedAt;
      const renew = async () => {
        try {
          const held = await this.persistence.renewChannelEventLease(
            inboxId,
            this.workerId,
            leaseGeneration,
            ChannelAppEventsController.EVENT_LEASE_MS,
          );
          if (!held) abortController.abort();
        } catch {
          abortController.abort();
        }
      };
      heartbeat = setInterval(
        () => void renew(),
        ChannelAppEventsController.EVENT_LEASE_MS / 3,
      );
      (heartbeat as any)?.unref?.();

      const context: ChannelAppEventContext = {
        eventId: String(claimed.eventId),
        abortSignal: abortController.signal,
        persistedTurn: claimed.persistedTurn,
        onTurnCompleted: (turnId) =>
          this.persistence.recordChannelEventTurn(
            inboxId,
            this.workerId,
            leaseGeneration,
            turnId,
          ),
        onDeliveryCompleted: async () => {
          if (deliveryCompleted) return !abortController.signal.aborted;
          const recorded = await this.persistence.recordChannelEventDelivery(
            inboxId,
            this.workerId,
            leaseGeneration,
          );
          if (recorded) deliveryCompleted = true;
          return recorded;
        },
      };

      if (!deliveryCompleted) {
        const app = await this.persistence.loadApp(String(claimed.appId));
        if (abortController.signal.aborted) throw new Error("channel event lease lost");
        if (app) await this.processVerifiedEvent(app, claimed.envelope, context);
        if (!deliveryCompleted && !(await context.onDeliveryCompleted())) {
          throw new Error("channel event lease lost");
        }
      }
      if (abortController.signal.aborted) throw new Error("channel event lease lost");
      const completed = await this.persistence.completeChannelEvent(
        inboxId,
        this.workerId,
        leaseGeneration,
      );
      if (!completed) throw new Error("channel event lease lost");
    } catch (error) {
      this.logger.error(`[chanapp] durable event processing failed inbox=${inboxId}`);
      try {
        if (error instanceof ChannelDeliveryError && !error.retryable) {
          await this.persistence.discardChannelEvent(
            inboxId,
            this.workerId,
            leaseGeneration,
            error.code,
          );
        } else {
          await this.persistence.failChannelEvent(
            inboxId,
            this.workerId,
            leaseGeneration,
            5_000,
            error instanceof ChannelDeliveryError ? error.code : "PROCESSING_FAILED",
          );
        }
      } catch {
        // Lease expiry is the final recovery backstop.
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.activeAborts.delete(inboxId);
      this.activeInbox.delete(inboxId);
    }
  }

  private async processVerifiedEvent(
    app: any,
    envelope: any,
    context: ChannelAppEventContext,
  ): Promise<void> {
    const appId = String(app.id);
    const teamId =
      envelope?.team_id ??
      envelope?.team?.id ??
      envelope?.authorizations?.[0]?.team_id ??
      null;
    const enterpriseId =
      envelope?.enterprise_id ??
      envelope?.enterprise?.id ??
      envelope?.authorizations?.[0]?.enterprise_id ??
      null;
    const innerType =
      envelope?.type === "event_callback" ? envelope?.event?.type : null;

    if (innerType === "app_uninstalled") {
      await this.revokeInstallations(appId, teamId, enterpriseId);
      this.runtime.invalidateApp(appId);
      this.logger.log(`[chanapp] lifecycle app_uninstalled app=${appId}`);
      return;
    }

    if (innerType === "tokens_revoked") {
      const tokens = envelope?.event?.tokens;
      const botIds = Array.isArray(tokens?.bot)
        ? (tokens.bot as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const oauthIds = Array.isArray(tokens?.oauth)
        ? (tokens.oauth as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      if (botIds.length > 0 || (botIds.length === 0 && oauthIds.length === 0)) {
        await this.revokeInstallations(appId, teamId, enterpriseId);
        this.runtime.invalidateApp(appId);
      }
      if (oauthIds.length > 0) {
        await this.invalidateLinkedIdentities(app, teamId, enterpriseId, oauthIds);
        this.runtime.invalidateIdentityLinks();
      }
      return;
    }

    const installation = await this.findActiveInstallation(
      appId,
      teamId,
      enterpriseId,
    );
    if (!installation) throw new Error("active channel installation unavailable");
    await this.runtime.handleAppEvent(app, installation, envelope, context);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Installation lookup / lifecycle
  //
  // ORG-INSTALL (Enterprise Grid) ROUTING INVARIANT — Phase D consistency audit.
  // Every consumer that resolves an installation from an inbound envelope MUST
  // agree on this handle/routing convention, or a Grid org-install silently
  // misroutes turns or leaves a live token "active" forever:
  //
  //   • STORAGE: an Enterprise Grid ORG-level install is stored teamId=NULL,
  //     enterpriseId=<E…>, isEnterpriseInstall=true (oauth.v2.access returns
  //     team:null for an org grant). A classic workspace install is the mirror:
  //     teamId=<T…>, enterpriseId=NULL.
  //   • ROUTING: event / lifecycle envelopes ALWAYS carry the ORIGINATING
  //     WORKSPACE's team_id (a "T…", never null) even inside a Grid, so the
  //     exact (appId, teamId, enterpriseId) tuple can NEVER hit the org row.
  //     When the exact match misses AND we are inside a Grid (enterpriseId
  //     present AND teamId present), fall back to (teamId:null, enterpriseId,
  //     isEnterpriseInstall:true, status:active) — the org row.
  //     findActiveInstallation (resolve) and revokeInstallations (uninstall)
  //     both apply this exact fallback below.
  //   • HANDLE: the "team" component of a slack identity handle is
  //     `teamId ?? enterpriseId` EVERYWHERE, so an org-install's handle is
  //     `<enterpriseId>:<userId>`. The runtime stamps identities with that rule
  //     and keys its decrypted-token cache (appCacheKey) by it;
  //     invalidateLinkedIdentities cannot see the installation row, so it tries
  //     BOTH handle forms (workspace team first, then enterprise).
  //   • TOKEN REFRESH (Phase D): getFreshBotToken does NOT re-route — it keys off
  //     the already-resolved installation.id for both its Postgres write and its
  //     durable refresh claim, so it inherits whichever
  //     row findActiveInstallation selected (org or workspace) and cannot drift
  //     from this convention. (See channel-runtime.service.ts getFreshBotToken.)
  // ───────────────────────────────────────────────────────────────────────

  private async findActiveInstallation(
    appId: string,
    teamId: string | null,
    enterpriseId: string | null,
  ): Promise<any | null> {
    // Nullable discriminators compile to `IS NULL`; scope by status so a
    // revoked workspace can't resurrect a turn.
    return this.persistence.findActiveInstallation(appId, teamId, enterpriseId);
  }

  /**
   * SOFT-revoke every active installation for this (app, team, enterprise).
   * Idempotent: filtering on `status: "active"` means the second of the two
   * (unordered) lifecycle events updates zero rows, so `revokedAt` is stamped
   * once by whichever event arrives first. Never hard-deletes.
   */
  private async revokeInstallations(
    appId: string,
    teamId: string | null,
    enterpriseId: string | null,
  ): Promise<void> {
    await this.persistence.revokeInstallations(appId, teamId, enterpriseId);
  }

  /**
   * Phase C lifecycle — a USER (oauth) token was revoked (Sign-in-with-Slack
   * consent pulled / member deactivated). Do NOT revoke the installation;
   * instead invalidate that user's SIWS-linked EMAIL identities so the
   * verified-email trust no longer anchors resolution or passes the
   * `linking: required` gate.
   *
   * TRADEOFF (v1): we SET verified=false on the person's email identity rows
   * rather than DELETE the slack→email linkage. Deletion is destructive and
   * irreversible if the revoke was transient (e.g. a re-auth churn); flipping
   * `verified` is reversible — a subsequent re-link restores it — and is enough
   * to fail the trust gate. Scope is the app OWNER's (installations carry no
   * scope of their own). The slack handle is `<team>:<userId>` (team = teamId ??
   * enterpriseId), matching how the runtime attaches the identity. Per-user
   * isolation: one bad lookup never aborts the rest. No PII (handle/email) is
   * ever logged — only counts + appId.
   */
  private async invalidateLinkedIdentities(
    app: any,
    teamId: string | null,
    enterpriseId: string | null,
    userIds: string[],
  ): Promise<void> {
    // Candidate handle team components: the event carries the WORKSPACE team_id
    // even for Grid org-level installs, but the runtime stored the slack handle
    // with `installation.teamId ?? enterpriseId` — which is the ENTERPRISE id
    // for org-installs (teamId null). We don't have the installation here, so
    // try both forms (workspace team first, then enterprise) — same enterprise
    // fallback shape findActiveInstallation/revokeInstallations use.
    const teamCandidates = Array.from(
      new Set([teamId, enterpriseId].filter((t): t is string => !!t)),
    );
    const count = await this.persistence.disableLinkedEmails(
      app,
      teamCandidates,
      userIds.filter(Boolean),
    );
    if (count > 0) {
      this.logger.log(
        `[chanapp] tokens_revoked invalidated ${count} email identity(ies) app=${String(app.id)}`,
      );
    }
  }

  private async loadApp(appId: string): Promise<any | null> {
    if (!appId) return null;
    try {
      return await this.persistence.loadApp(appId);
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Slack signature verification
  // ───────────────────────────────────────────────────────────────────────

  /**
   * `x-slack-signature` = 'v0=' + HMAC-SHA256(signingSecret,
   * 'v0:' + <x-slack-request-timestamp> + ':' + rawBody). HMAC over the exact
   * bytes (not a re-encoded string), timing-safe compare, stale-timestamp
   * reject (> 300s) to blunt replay.
   */
  private verifySlackSignature(
    signingSecret: string,
    rawBody: Buffer,
    timestamp: string | undefined,
    signature: string | undefined,
  ): boolean {
    if (!signingSecret || !timestamp || !signature) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const nowSec = Date.now() / 1000;
    if (Math.abs(nowSec - ts) > ChannelAppEventsController.MAX_SKEW_SECONDS) {
      return false;
    }
    let expected: string;
    try {
      const hmac = crypto.createHmac("sha256", signingSecret);
      hmac.update(`v0:${timestamp}:`, "utf8");
      hmac.update(rawBody); // exact received bytes
      expected = `v0=${hmac.digest("hex")}`;
    } catch {
      return false;
    }
    return this.timingSafeEqual(expected, signature);
  }

  /** Constant-time string compare (guards the signature against a timing oracle). */
  private timingSafeEqual(a: string, b: string): boolean {
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

  // ───────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Decrypt the stored secret envelope → plain string. Mirrors
   * channel-runtime.service.ts decryptCredentials but for a scalar string
   * field. FAIL CLOSED: on a key mismatch decryptJsonField returns its
   * {__platos_enc,error} envelope (an object), so anything non-string throws
   * rather than verifying against a broken secret. Duplicated (not shared)
   * to keep this slice from touching a file outside its scope.
   */
  private requireSecretString(stored: unknown): string {
    if (typeof stored !== "string" || !stored) {
      throw new Error("secret unavailable");
    }
    return stored;
  }

  private firstHeader(v: string | string[] | undefined): string | undefined {
    if (v == null) return undefined;
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === "string" ? s : undefined;
  }
}
