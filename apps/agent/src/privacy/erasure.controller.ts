import { Controller, Post, Get, Param, Body, Req, Res, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  ErasureIdempotencyConflictError,
  ErasureService,
  ERASURE_POLICY_VERSION,
} from "./erasure.service";
import { PlatosMCPTokenService, type VerifiedToken } from "../mcp-platform/token.service";
import type { ErasureAuditActor } from "./erasure-audit";

/**
 * Hard-erasure API.
 *
 * Authenticated only by an admin-tier `plt_mcp_` control-plane credential.
 * Static deployment secrets are deliberately not accepted for irreversible
 * data destruction.
 *
 * The routes live under /api/v1/agent/admin/privacy/* so ScopeGuard's admin
 * allow-list can let the self-authenticating controller receive them. The
 * verified credential is organization-bound; subject discovery may span every
 * project/environment inside that organization.
 */
@Controller("api/v1/agent/admin/privacy")
export class ErasureController {
  private readonly logger = new Logger(ErasureController.name);

  constructor(
    private readonly erasure: ErasureService,
    private readonly credentials: PlatosMCPTokenService
  ) {}

  /** Verify the request's organization-bound admin control-plane credential. */
  private async authorized(req: Request): Promise<VerifiedToken | null> {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
    const verified = await this.credentials.verify(authorization.slice("Bearer ".length).trim());
    return verified?.tier === "admin" ? verified : null;
  }

  /**
   * The credential, reduced to what the audit trail needs.
   *
   * `mintedByUserId` is the point of this: the credential is a bearer secret
   * that can be shared, but it was minted by one named operator, and that is
   * the closest thing to a human answerable for an irreversible deletion. The
   * credential id is carried alongside so a rotated or revoked token can still
   * be traced back from the audit row.
   */
  private actor(credential: VerifiedToken): ErasureAuditActor {
    return {
      credentialId: credential.id,
      userId: credential.mintedByUserId ?? null,
      environmentId: credential.scope.environmentId,
      projectId: credential.scope.projectId,
    };
  }

  private deny(res: Response) {
    // No detail: distinguishing "wrong token" from "no token" helps an attacker
    // and helps nobody else.
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  /** Content-free discovery. Counts and scope ids only, never content. */
  @Get("subjects/:externalUserId/inventory")
  async inventory(
    @Req() req: Request,
    @Res() res: Response,
    @Param("externalUserId") externalUserId: string
  ) {
    const organizationId = String(req.query.organizationId ?? "");
    if (!organizationId) {
      return res.status(400).json({ error: "organizationId query param is required" });
    }
    const credential = await this.authorized(req);
    if (!credential || credential.scope.organizationId !== organizationId) return this.deny(res);
    const subject = await this.erasure.discoverSubject(externalUserId, organizationId);
    const inventory = await this.erasure.inventory(subject, organizationId);
    await this.erasure.auditInventoryRead({
      externalUserId,
      organizationId,
      subject,
      inventory,
      actor: this.actor(credential),
    });
    return res.json({
      resolvedEndUsers: subject.platosEndUserIds.length,
      resolvedLegacyIds: subject.legacyUserIds.length,
      scopes: subject.scopes,
      inventory,
      policyVersion: ERASURE_POLICY_VERSION,
    });
  }

  /**
   * Request an erasure. Idempotent on organization + `idempotencyKey`; reuse
   * for another subject is rejected rather than returning an existing receipt.
   */
  @Post("erasures")
  async create(
    @Req() req: Request,
    @Res() res: Response,
    @Body()
    body: {
      externalUserId?: string;
      organizationId?: string;
      idempotencyKey?: string;
      legalHoldPolicyId?: string | null;
    }
  ) {
    const { externalUserId, organizationId, idempotencyKey } = body ?? {};
    if (!externalUserId || !organizationId || !idempotencyKey) {
      return res.status(400).json({
        error: "externalUserId, organizationId and idempotencyKey are required",
      });
    }
    const credential = await this.authorized(req);
    if (!credential || credential.scope.organizationId !== organizationId) return this.deny(res);
    let receipt;
    try {
      receipt = await this.erasure.requestErasure({
        externalUserId,
        organizationId,
        idempotencyKey,
        legalHoldPolicyId: body.legalHoldPolicyId ?? null,
        actor: this.actor(credential),
      });
    } catch (error) {
      if (error instanceof ErasureIdempotencyConflictError) {
        return res.status(409).json({ error: "IDEMPOTENCY_KEY_CONFLICT" });
      }
      throw error;
    }
    // 200 rather than 201 on a repeat: the caller did not create anything.
    return res.status(receipt.attempts > 1 ? 200 : 201).json(receipt);
  }

  @Get("erasures/:operationId")
  async get(@Req() req: Request, @Res() res: Response, @Param("operationId") operationId: string) {
    const credential = await this.authorized(req);
    if (!credential) return this.deny(res);
    if (
      !(await this.erasure.operationBelongsToOrganization(
        operationId,
        credential.scope.organizationId
      ))
    ) {
      return this.deny(res);
    }
    const receipt = await this.erasure.getErasure(operationId);
    if (!receipt) return res.status(404).json({ error: "NOT_FOUND" });
    return res.json(receipt);
  }

  /**
   * Retry re-runs only the stores that did not settle.
   *
   * `externalUserId` is now OPTIONAL. Supplying it gives the pass the same
   * reach as the original — including the rows keyed by the legacy id — so its
   * verifications count. Omitting it resumes from the persisted locators
   * instead, which still deletes but cannot certify the legacy-keyed rows; the
   * receipt records that as `unknown` rather than pretending otherwise.
   */
  @Post("erasures/:operationId/retry")
  async retry(
    @Req() req: Request,
    @Res() res: Response,
    @Param("operationId") operationId: string,
    @Body() body: { externalUserId?: string }
  ) {
    const credential = await this.authorized(req);
    if (!credential) return this.deny(res);
    if (
      !(await this.erasure.operationBelongsToOrganization(
        operationId,
        credential.scope.organizationId
      ))
    ) {
      return this.deny(res);
    }
    const actor = this.actor(credential);
    const receipt = body?.externalUserId
      ? await this.erasure.retryErasureById(operationId, body.externalUserId, actor)
      : await this.erasure.resumeErasure(operationId, actor);
    if (!receipt) return res.status(404).json({ error: "NOT_FOUND" });
    if (receipt.status === "blocked_legal_hold") {
      return res.status(409).json(receipt);
    }
    return res.json(receipt);
  }

  /**
   * Drain the queue: re-drive every operation that is due, in this
   * organization.
   *
   * Exists so nothing has to be resumed by hand. It is a route rather than a
   * background task because the erasure module deliberately shares no state
   * with the agent runtime and schedules nothing of its own — a deployment
   * points a cron, a scheduler, or an operator at this, and the selection,
   * backoff and leasing that make it safe live in the service either way.
   */
  @Post("erasures/resume-due")
  async resumeDue(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { limit?: number }
  ) {
    const credential = await this.authorized(req);
    if (!credential) return this.deny(res);
    const resumed = await this.erasure.resumeDueErasures({
      organizationId: credential.scope.organizationId,
      limit: body?.limit,
      actor: this.actor(credential),
    });
    return res.json({ resumed: resumed.length, operations: resumed });
  }
}
