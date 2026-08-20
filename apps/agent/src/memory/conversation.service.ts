import { randomUUID } from "crypto";
import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import {
  ObservabilityService,
  type ObservabilityTransaction,
} from "../observability/observability.service";
import { buildTurnProjection } from "../observability/turn-projection";
import { configureExternalTriggerSdk } from "../shared/external-trigger-config";
import {
  modelPriceSnapshotStepData,
  type CanonicalModelPriceSnapshot,
} from "@platos/tenancy-database";
import { assertSubjectNotErased } from "../privacy/erasure-register";
import { freshInputTokens, roundCents } from "../monitoring/usage-ledger";

export interface StoredMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  toolCalls: any[] | null;
  thinkingContent: string | null;
  responseJson: any | null;
  createdAt: Date;
  turnId?: string;
  revision?: number;
  replyCount?: number;
}

export interface Thread {
  id: string;
  agentId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  endUserId: string;
  title: string | null;
  status: string;
  turnCount: number;
  compactedSummary: string | null;
  compactedUpToTurnId: string | null;
  compactionState: string;
  tags: string[];
  pinnedAt: Date | null;
  archivedAt: Date | null;
  parentThreadId: string | null;
  clusterId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_TAG_LENGTH = 50;
export const MAX_TAGS_PER_THREAD = 20;
export const CONVERSATION_REVISION_NOT_SUPPORTED = {
  code: "conversation_revision_not_supported",
  statusCode: 409,
  message: "Conversation revisions are not supported by the current persistence schema.",
  retryable: false,
} as const;

export class ConversationRevisionNotSupportedError extends Error {
  readonly code = CONVERSATION_REVISION_NOT_SUPPORTED.code;
  readonly statusCode = CONVERSATION_REVISION_NOT_SUPPORTED.statusCode;
  readonly retryable = CONVERSATION_REVISION_NOT_SUPPORTED.retryable;

  constructor() {
    super(CONVERSATION_REVISION_NOT_SUPPORTED.message);
    this.name = "ConversationRevisionNotSupportedError";
  }
}

export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    throw new Error("tags must be an array of strings");
  }
  const out = Array.from(new Set(input.map((value) => value.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)).filter(Boolean)));
  if (out.length > MAX_TAGS_PER_THREAD) throw new Error(`too many tags (max ${MAX_TAGS_PER_THREAD})`);
  return out;
}

function statusForWrite(value: string | undefined): "ACTIVE" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "PENDING" | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (["ACTIVE", "SUCCEEDED", "FAILED", "CANCELLED", "PENDING"].includes(normalized)) return normalized as any;
  if (normalized === "ARCHIVED" || normalized === "COMPLETED") return "SUCCEEDED";
  throw new Error(`Unsupported thread status: ${value}`);
}

function publicStatus(value: string): string {
  return value.toLowerCase();
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    @Inject(PRISMA_TOKEN) public readonly prisma: ControlDatabaseClient,
    // Optional so every existing construction of this service — and every test
    // that does not care about analytics — keeps working. Absent means the same
    // thing as an unconfigured sink: the Turn commits and nothing is projected.
    @Optional() private readonly observability?: ObservabilityService,
  ) {}

  private environmentWhere(scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">) {
    return {
      environmentId: scope.environmentId,
      environment: {
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
    } as const;
  }

  private async resolveEndUserRow(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId" | "userIdentities">,
    opts?: { displayName?: string; email?: string },
  ): Promise<{ id: string; subject: string }> {
    const claims = Array.isArray(scope.userIdentities)
      ? scope.userIdentities.filter((claim) => claim && typeof claim.channel === "string" && typeof claim.handle === "string").slice(0, 8)
      : [];
    const externalIdentity = {
      issuer: "platos:external",
      channel: "external",
      subject: scope.userId.trim().slice(0, 256),
      verified: true,
    };
    const sessionIdentity = {
      issuer: "platos",
      channel: "session",
      subject: scope.userId.trim().slice(0, 256),
      verified: true,
    };
    const channelIdentities = [
      ...claims.filter((claim) => claim.verified === true).map((claim) => ({
        issuer: `channel:${claim.channel.trim().toLowerCase()}`,
        channel: claim.channel.trim().toLowerCase(),
        subject: claim.handle.trim().slice(0, 256),
        verified: true,
      })),
    ].filter((claim) => claim.subject.length > 0);
    if (!externalIdentity.subject) {
      throw new Error("Conversation persistence requires an authenticated external subject");
    }
    const candidates = [externalIdentity, sessionIdentity, ...channelIdentities];

    // Erasure barrier. A session token outlives the sweep that erased its
    // owner, so without this the next turn silently rebuilds the subject under
    // a fresh uuid the finished receipt cannot see. Checked against EVERY
    // candidate handle, not just the external id, because the person walks back
    // in through whichever one the caller presents. Throws when it cannot be
    // checked: refusing a turn is recoverable, resurrecting a subject is not.
    await assertSubjectNotErased(this.prisma, {
      organizationId: scope.organizationId,
      aliases: candidates.map((claim) => ({ channel: claim.channel, subject: claim.subject })),
    });

    let resolvedEndUserId: string | null = null;
    for (const claim of candidates) {
      const identity = await this.prisma.endUserIdentity.findFirst({
        where: {
          organizationId: scope.organizationId,
          issuer: claim.issuer,
          channel: claim.channel,
          subject: claim.subject,
          disabledAt: null,
          ...(claim.verified ? { verifiedAt: { not: null } } : {}),
        },
        select: { endUserId: true, subject: true },
      });
      if (identity) {
        resolvedEndUserId = identity.endUserId;
        break;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const racedExternal = await tx.endUserIdentity.findUnique({
        where: {
          organizationId_issuer_channel_subject: {
            organizationId: scope.organizationId,
            issuer: externalIdentity.issuer,
            channel: externalIdentity.channel,
            subject: externalIdentity.subject,
          },
        },
        select: { endUserId: true },
      });
      const endUserId = racedExternal?.endUserId ?? resolvedEndUserId ?? (await tx.endUser.create({
        data: { organizationId: scope.organizationId, displayName: opts?.displayName ?? null },
        select: { id: true },
      })).id;
      const profile = opts?.email ? { email: opts.email } : undefined;
      const verifiedAt = new Date();
      const canonical = await tx.endUserIdentity.upsert({
        where: {
          organizationId_issuer_channel_subject: {
            organizationId: scope.organizationId,
            issuer: externalIdentity.issuer,
            channel: externalIdentity.channel,
            subject: externalIdentity.subject,
          },
        },
        create: {
          endUserId,
          organizationId: scope.organizationId,
          issuer: externalIdentity.issuer,
          channel: externalIdentity.channel,
          subject: externalIdentity.subject,
          profile,
          verifiedAt,
        },
        update: { disabledAt: null, verifiedAt },
        select: { endUserId: true, subject: true },
      });
      await tx.endUserIdentity.upsert({
        where: {
          organizationId_issuer_channel_subject: {
            organizationId: scope.organizationId,
            issuer: sessionIdentity.issuer,
            channel: sessionIdentity.channel,
            subject: sessionIdentity.subject,
          },
        },
        create: {
          endUserId: canonical.endUserId,
          organizationId: scope.organizationId,
          issuer: sessionIdentity.issuer,
          channel: sessionIdentity.channel,
          subject: sessionIdentity.subject,
          verifiedAt,
        },
        update: { disabledAt: null, verifiedAt },
      });
      for (const claim of channelIdentities) {
        const existing = await tx.endUserIdentity.findUnique({
          where: {
            organizationId_issuer_channel_subject: {
              organizationId: scope.organizationId,
              issuer: claim.issuer,
              channel: claim.channel,
              subject: claim.subject,
            },
          },
          select: { endUserId: true },
        });
        if (!existing) {
          await tx.endUserIdentity.create({
            data: {
              endUserId: canonical.endUserId,
              organizationId: scope.organizationId,
              issuer: claim.issuer,
              channel: claim.channel,
              subject: claim.subject,
              verifiedAt,
            },
          });
        }
      }
      return { id: canonical.endUserId, subject: canonical.subject };
    });
  }

  async resolveEndUser(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId" | "userIdentities">,
    opts?: { displayName?: string; email?: string; incrementThreadCount?: boolean },
  ): Promise<string | null> {
    const row = await this.resolveEndUserRow(scope, opts);
    return row.id;
  }

  async enrichEndUser(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    externalUserId: string,
    meta: { displayName?: string | null; email?: string | null },
  ): Promise<void> {
    const identity = await this.prisma.endUserIdentity.findFirst({
      where: {
        organizationId: scope.organizationId,
        issuer: "platos:external",
        channel: "external",
        subject: externalUserId,
        disabledAt: null,
      },
      select: { id: true, endUserId: true, profile: true },
    });
    if (!identity) return;
    await this.prisma.$transaction([
      ...(meta.displayName ? [this.prisma.endUser.update({ where: { id: identity.endUserId }, data: { displayName: meta.displayName } })] : []),
      ...(meta.email ? [this.prisma.endUserIdentity.update({
        where: { id: identity.id },
        data: { profile: { ...objectValue(identity.profile), email: meta.email } },
      })] : []),
    ]);
  }

  private async projectThread(row: any, requestedUserId?: string): Promise<Thread> {
    const identities = row.endUser?.identities ?? [];
    const userId = identities.find((identity: any) => identity.subject === requestedUserId)?.subject
      ?? identities.find((identity: any) => identity.issuer === "platos:external" && identity.channel === "external")?.subject
      ?? identities.find((identity: any) => identity.issuer === "platos" && identity.channel === "session")?.subject
      ?? identities[0]?.subject
      ?? row.endUserId;
    return {
      id: row.id,
      agentId: row.agentId,
      organizationId: row.environment.project.organizationId,
      projectId: row.environment.projectId,
      environmentId: row.environmentId,
      userId,
      endUserId: row.endUserId,
      title: row.title,
      status: row.archivedAt ? "archived" : publicStatus(row.status),
      turnCount: row._count?.turns ?? 0,
      compactedSummary: row.summary,
      compactedUpToTurnId: row.compactedUpToTurnId,
      compactionState: row.compactionState,
      tags: row.tags ?? [],
      pinnedAt: row.pinnedAt,
      archivedAt: row.archivedAt,
      parentThreadId: row.parentThreadId,
      clusterId: row.clusterId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private threadInclude() {
    return {
      environment: { include: { project: true } },
      endUser: { include: { identities: { where: { disabledAt: null }, orderBy: { createdAt: "asc" as const } } } },
      _count: { select: { turns: true } },
    } as const;
  }

  async createThread(
    scope: RequestScope,
    agentId: string,
    title?: string,
    opts?: { displayName?: string; email?: string; parentThreadId?: string; singleEndUser?: boolean },
  ): Promise<Thread> {
    const binding = await this.prisma.agentBinding.findFirst({
      where: {
        agentId,
        ...this.environmentWhere(scope),
        agent: { projectId: scope.projectId },
      },
      select: { agentId: true, clusterId: true },
    });
    if (!binding) throw new Error("Agent not found or access denied");
    const endUser = opts?.parentThreadId
      ? await this.prisma.thread.findFirst({
          where: { id: opts.parentThreadId, ...this.environmentWhere(scope) },
          select: { endUserId: true },
        }).then((row) => row ? ({ id: row.endUserId, subject: scope.userId }) : null)
      : await this.resolveEndUserRow(scope, opts);
    if (!endUser) throw new Error("Parent thread not found or access denied");
    const row = await this.prisma.thread.create({
      data: {
        environmentId: scope.environmentId,
        agentId,
        endUserId: endUser.id,
        clusterId: binding.clusterId,
        parentThreadId: opts?.parentThreadId ?? null,
        title: title ?? null,
      },
      include: this.threadInclude(),
    });
    return this.projectThread(row, scope.userId);
  }

  private ownershipWhere(scope: RequestScope, allUsers = false) {
    if (allUsers) return {};
    const verifiedClaims = Array.isArray(scope.userIdentities)
      ? scope.userIdentities
          .filter((claim) => claim?.verified === true && typeof claim.channel === "string" && typeof claim.handle === "string")
          .slice(0, 8)
          .map((claim) => ({
            organizationId: scope.organizationId,
            issuer: `channel:${claim.channel.trim().toLowerCase()}`,
            channel: claim.channel.trim().toLowerCase(),
            subject: claim.handle.trim().slice(0, 256),
            disabledAt: null,
            verifiedAt: { not: null as Date | null },
          }))
      : [];
    return {
      endUser: {
        identities: {
          some: {
            OR: [
              {
                organizationId: scope.organizationId,
                issuer: "platos:external",
                channel: "external",
                subject: scope.userId,
                disabledAt: null,
                verifiedAt: { not: null as Date | null },
              },
              {
                organizationId: scope.organizationId,
                issuer: "platos",
                channel: "session",
                subject: scope.userId,
                disabledAt: null,
              },
              ...verifiedClaims,
            ],
          },
        },
      },
    };
  }

  async getThread(threadId: string, scope: RequestScope, options: { allUsers?: boolean } = {}): Promise<Thread | null> {
    const row = await this.prisma.thread.findFirst({
      where: {
        id: threadId,
        ...this.environmentWhere(scope),
        ...this.ownershipWhere(scope, options.allUsers),
        ...(scope.clusteringId ? { OR: [{ clusterId: scope.clusteringId }, { agentId: scope.agentId }] } : {}),
      },
      include: this.threadInclude(),
    });
    return row ? this.projectThread(row, scope.userId) : null;
  }

  async listThreadsForCluster(scope: RequestScope, clusterId: string, options: { limit?: number; offset?: number } = {}) {
    return this.listThreads({ ...scope, clusteringId: clusterId }, { limit: options.limit, offset: options.offset });
  }

  async listThreads(
    scope: RequestScope,
    options: { agentId?: string; status?: string; limit?: number; offset?: number; tag?: string; pinned?: boolean; archived?: boolean | "only"; allUsers?: boolean } = {},
  ): Promise<{ threads: Thread[]; total: number }> {
    const where: any = {
      ...this.environmentWhere(scope),
      ...this.ownershipWhere(scope, options.allUsers),
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.status ? { status: statusForWrite(options.status) } : {}),
      ...(options.tag ? { tags: { has: normalizeTags([options.tag])[0] } } : {}),
      ...(options.pinned ? { pinnedAt: { not: null } } : {}),
      ...(options.archived === "only" ? { archivedAt: { not: null } } : options.archived === true ? {} : { archivedAt: null }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.thread.findMany({
        where,
        include: this.threadInclude(),
        orderBy: [{ pinnedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
        take: options.limit ?? 20,
        skip: options.offset ?? 0,
      }),
      this.prisma.thread.count({ where }),
    ]);
    return { threads: await Promise.all(rows.map((row) => this.projectThread(row, scope.userId))), total };
  }

  async updateThread(threadId: string, scope: RequestScope, data: { title?: string; status?: string }): Promise<Thread> {
    await this.findScopedThread(threadId, scope);
    await this.prisma.thread.update({
      where: { id: threadId },
      data: { ...(data.title !== undefined ? { title: data.title } : {}), ...(data.status ? { status: statusForWrite(data.status) } : {}) },
    });
    return this.findScopedThread(threadId, scope);
  }

  async deleteThread(threadId: string, scope: RequestScope) {
    const now = new Date();
    const result = await this.prisma.thread.updateMany({
      where: { id: threadId, ...this.environmentWhere(scope), ...this.ownershipWhere(scope) },
      data: { archivedAt: now, status: "SUCCEEDED" },
    });
    return { archived: result.count > 0, archivedAt: result.count ? now.toISOString() : null };
  }

  async renameThread(threadId: string, scope: RequestScope, title: string | null) {
    const result = await this.prisma.thread.updateMany({
      where: { id: threadId, ...this.environmentWhere(scope), ...this.ownershipWhere(scope) }, data: { title },
    });
    if (!result.count) return null;
    const row = await this.prisma.thread.findUniqueOrThrow({ where: { id: threadId }, select: { updatedAt: true } });
    return { threadId, title, updatedAt: row.updatedAt.toISOString() };
  }

  private async findScopedThread(threadId: string, scope: RequestScope): Promise<Thread> {
    const thread = await this.getThread(threadId, scope);
    if (!thread) throw new Error("Thread not found or access denied");
    return thread;
  }

  async setThreadTags(threadId: string, scope: RequestScope, tags: unknown): Promise<Thread> {
    await this.findScopedThread(threadId, scope);
    await this.prisma.thread.update({ where: { id: threadId }, data: { tags: normalizeTags(tags) } });
    return this.findScopedThread(threadId, scope);
  }

  async togglePin(threadId: string, scope: RequestScope, pinned?: boolean): Promise<Thread> {
    const thread = await this.findScopedThread(threadId, scope);
    const shouldPin = typeof pinned === "boolean" ? pinned : thread.pinnedAt === null;
    await this.prisma.thread.update({ where: { id: threadId }, data: { pinnedAt: shouldPin ? new Date() : null } });
    return this.findScopedThread(threadId, scope);
  }

  async archiveThread(threadId: string, scope: RequestScope): Promise<Thread> {
    await this.findScopedThread(threadId, scope);
    await this.prisma.thread.update({ where: { id: threadId }, data: { archivedAt: new Date(), status: "SUCCEEDED" } });
    return this.findScopedThread(threadId, scope);
  }

  async unarchiveThread(threadId: string, scope: RequestScope): Promise<Thread> {
    await this.findScopedThread(threadId, scope);
    await this.prisma.thread.update({ where: { id: threadId }, data: { archivedAt: null, status: "ACTIVE" } });
    return this.findScopedThread(threadId, scope);
  }

  private async versionBucket(
    threadId: string,
    agentId: string,
    agentVersionId: string,
    bucket: string,
  ): Promise<"CANARY" | "CURRENT"> {
    const normalized = bucket.toUpperCase();
    if (normalized === "CANARY" || normalized === "CURRENT") return normalized;
    if (normalized === "LOCKED") {
      const prior = await this.prisma.turn.findFirst({
        where: { threadId, agentVersionId },
        orderBy: { sequence: "desc" },
        select: { versionBucket: true },
      });
      if (prior) return prior.versionBucket;
      const binding = await this.prisma.agentBinding.findFirst({
        where: { agentId, environmentId: (await this.prisma.thread.findUniqueOrThrow({
          where: { id: threadId },
          select: { environmentId: true },
        })).environmentId },
        select: { canaryAgentVersionId: true },
      });
      return binding?.canaryAgentVersionId === agentVersionId ? "CANARY" : "CURRENT";
    }
    throw new Error(`Unsupported AgentVersion bucket: ${bucket}`);
  }

  async storeMessage(
    threadId: string,
    scope: RequestScope,
    message: {
      role: "user" | "assistant" | "tool";
      content?: string;
      toolCalls?: any[];
      thinkingContent?: string;
      systemPromptOverride?: string | null;
      outputSchema?: any;
      threadReplyToId?: string | null;
      authorAgentId?: string | null;
      turnId?: string;
      agentVersionId?: string | null;
      versionBucket?: string;
      model?: string;
      usage?: { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; reasoningTokens?: number };
      costCents?: number;
      pricing?: CanonicalModelPriceSnapshot;
      /**
       * WIN-134 — further model calls this turn made on the user's behalf, one
       * Step each, priced at their OWN model's rates.
       *
       * A Turn has many Steps; that is the ledger's own vocabulary for "several
       * model calls, one unit of work". Sub-agent delegations used to reach the
       * Redis rollups and no Postgres row at all, which made the two ledgers
       * describe different money for the same window — and left
       * `reconcileFromPostgres` rebuilding a lost day permanently short, because
       * the missing dollars existed in no row it could read.
       *
       * They do NOT add to the task count: a turn that delegates three times is
       * one completed turn (see `isCompletedTask`).
       */
      additionalSteps?: Array<{
        model: string;
        provider?: string | null;
        startedAt: Date;
        completedAt: Date;
        inputTokens?: number;
        outputTokens?: number;
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
        reasoningTokens?: number;
        costCents: number;
        pricing: CanonicalModelPriceSnapshot;
      }>;
      latencyMs?: number;
      structuredOutput?: unknown;
      externalRuntimeId?: string | null;
      idempotencyKey?: string;
    },
  ): Promise<StoredMessage> {
    const thread = await this.findScopedThread(threadId, scope);
    if (message.role === "user") {
      if (!message.agentVersionId) throw new Error("Durable turn persistence requires selected AgentVersion");
      if (!message.versionBucket) throw new Error("Durable turn persistence requires selected version bucket");
      const selectedVersion = await this.prisma.agentVersion.findFirst({
        where: { id: message.agentVersionId, agentId: thread.agentId },
        select: { id: true },
      });
      if (!selectedVersion) throw new Error("Selected AgentVersion does not belong to the thread Agent");
      const versionBucket = await this.versionBucket(
        threadId,
        thread.agentId,
        message.agentVersionId,
        message.versionBucket,
      );
      const row = await this.prisma.$transaction(async (tx) => {
        const lockedThread = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM "Thread"
          WHERE id = ${threadId}::uuid
          FOR UPDATE
        `;
        if (!lockedThread.length) throw new Error("Thread not found or access denied");
        const latest = await tx.turn.findFirst({ where: { threadId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
        return tx.turn.create({
          data: {
            threadId,
            parentTurnId: message.threadReplyToId ?? null,
            agentVersionId: message.agentVersionId!,
            versionBucket,
            sequence: (latest?.sequence ?? 0) + 1,
            inputText: message.content ?? null,
            input: {
              ...(message.systemPromptOverride !== undefined ? { systemPromptOverride: message.systemPromptOverride } : {}),
              ...(message.outputSchema !== undefined ? { outputSchema: message.outputSchema } : {}),
              ...(message.authorAgentId ? { authorAgentId: message.authorAgentId } : {}),
              ...(message.threadReplyToId ? { replyToTurnId: message.threadReplyToId } : {}),
            },
            status: "ACTIVE",
            startedAt: new Date(),
            externalRuntimeId: message.externalRuntimeId ?? null,
            idempotencyKey: message.idempotencyKey ?? null,
          },
        });
      });
      return this.turnSideToMessage(row, "user");
    }

    if (message.role !== "assistant") throw new Error("Tool messages must be persisted as ToolCall rows on an assistant turn");
    const turnId = message.turnId;
    if (!turnId) throw new Error("Assistant persistence requires the open turn id");
    const usage = message.usage ?? {};
    if (message.costCents != null && !message.pricing) {
      throw new Error("Priced assistant persistence requires a canonical rate snapshot");
    }
    const calls = normalizeToolCalls(message.toolCalls ?? []);
    // Mint the ToolCall ids here rather than letting the database default them.
    // The projection needs each row's id, and a nested create does not return
    // its children without an `include` — an extra round trip, on the turn
    // commit path, to learn something we could simply have decided.
    const callIds = calls.map(() => randomUUID());
    const completedAt = new Date();
    const extraSteps = message.additionalSteps ?? [];
    // The Turn's cost is what the whole unit of work cost: this model call plus
    // every model call it made on the user's behalf. Rounded once, at the
    // ledger's precision, rather than per row.
    const turnCostCents =
      message.costCents == null && extraSteps.length === 0
        ? null
        : roundCents(
            (message.costCents ?? 0) +
              extraSteps.reduce((total, extra) => total + (extra.costCents ?? 0), 0),
          );
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.turn.findFirst({ where: { id: turnId, threadId, status: "ACTIVE" } });
      if (!current) throw new Error("Open turn not found or already finalized");
      const updated = await tx.turn.update({
        where: { id: turnId },
        data: {
          outputText: message.content ?? null,
          output: message.structuredOutput === undefined ? undefined : { structuredOutput: message.structuredOutput },
          thinkingContent: message.thinkingContent ?? null,
          status: "SUCCEEDED",
          costCents: turnCostCents,
          latencyMs: message.latencyMs ?? null,
          completedAt,
        },
      });
      const step = await tx.step.create({
        data: {
          turnId,
          sequence: 1,
          model: message.model ?? "unknown",
          status: "SUCCEEDED",
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
          reasoningTokens: usage.reasoningTokens ?? 0,
          costCents: message.costCents ?? null,
          ...(message.pricing ? modelPriceSnapshotStepData(message.pricing) : {}),
          latencyMs: message.latencyMs ?? null,
          startedAt: current.startedAt,
          completedAt,
          toolCalls: calls.length ? {
            create: calls.map((call, index) => ({
              id: callIds[index],
              sequence: index + 1,
              toolName: call.name,
              arguments: call.arguments as any,
              result: call.result as any,
              status: call.error ? "FAILED" : "SUCCEEDED",
              error: call.error,
              latencyMs: call.latencyMs,
              completedAt,
              startedAt: current.startedAt,
            })),
          } : undefined,
        },
      });
      // WIN-134 — one Step per further model call, numbered after the primary
      // one. No tool calls hang off them: the sub-agent's own tool calls are
      // its business, and the parent's are already on sequence 1.
      const extraRows: Array<{ id: string; sequence: number }> = [];
      for (const [index, extra] of extraSteps.entries()) {
        extraRows.push(
          await tx.step.create({
            data: {
              turnId,
              sequence: index + 2,
              model: extra.model,
              status: "SUCCEEDED",
              inputTokens: extra.inputTokens ?? 0,
              outputTokens: extra.outputTokens ?? 0,
              cacheCreationInputTokens: extra.cacheCreationInputTokens ?? 0,
              cacheReadInputTokens: extra.cacheReadInputTokens ?? 0,
              reasoningTokens: extra.reasoningTokens ?? 0,
              costCents: extra.costCents,
              ...modelPriceSnapshotStepData(extra.pricing),
              latencyMs: Math.max(0, extra.completedAt.getTime() - extra.startedAt.getTime()),
              startedAt: extra.startedAt,
              completedAt: extra.completedAt,
            },
          }),
        );
      }
      // WIN-133 — queue the analytical projection in the SAME transaction that
      // committed the Turn, its Step and its Tool Calls. Either both land or
      // neither does; there is no window where the ledger and the projection
      // disagree about whether this turn happened.
      await this.enqueueProjection(tx, scope, thread, {
        turn: {
          id: turnId,
          agentVersionId: current.agentVersionId,
          status: "completed",
          acceptedAt: current.startedAt ?? completedAt,
          completedAt,
          costCents: turnCostCents,
          traceId: scope.traceId ?? null,
          rootSpanId: scope.parentSpanId ?? null,
          externalRuntimeId: current.externalRuntimeId,
        },
        steps: [
          {
            id: step.id,
            sequence: step.sequence,
            model: step.model,
            provider: message.pricing?.provider ?? null,
            status: "completed",
            startedAt: current.startedAt ?? completedAt,
            completedAt,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            reasoningTokens: usage.reasoningTokens,
            costCents: message.costCents ?? null,
            modelPriceId: message.pricing?.modelPriceId ?? null,
            inputRate: message.pricing?.input.usdPerToken ?? null,
            outputRate: message.pricing?.output.usdPerToken ?? null,
            cacheReadRate: message.pricing?.cacheRead.usdPerToken ?? null,
            cacheWriteRate: message.pricing?.cacheWrite.usdPerToken ?? null,
            pricingSource: message.pricing?.input.source ?? null,
          },
          // The further model calls, projected on the same footing: their own
          // model, their own frozen rates, their own usage event. The analytical
          // store's per-model breakdown is only honest if they are here.
          ...extraSteps.map((extra, index) => ({
            id: extraRows[index].id,
            sequence: extraRows[index].sequence,
            model: extra.model,
            provider: extra.provider ?? extra.pricing.provider ?? null,
            status: "completed" as const,
            startedAt: extra.startedAt,
            completedAt: extra.completedAt,
            inputTokens: extra.inputTokens,
            outputTokens: extra.outputTokens,
            cacheReadInputTokens: extra.cacheReadInputTokens,
            cacheCreationInputTokens: extra.cacheCreationInputTokens,
            reasoningTokens: extra.reasoningTokens,
            costCents: extra.costCents,
            modelPriceId: extra.pricing.modelPriceId,
            inputRate: extra.pricing.input.usdPerToken,
            outputRate: extra.pricing.output.usdPerToken,
            cacheReadRate: extra.pricing.cacheRead.usdPerToken,
            cacheWriteRate: extra.pricing.cacheWrite.usdPerToken,
            pricingSource: extra.pricing.input.source,
          })),
        ],
        toolCalls: calls.map((call, index) => ({
          id: callIds[index],
          stepId: step.id,
          sequence: index + 1,
          toolName: call.name,
          // A tool that errored failed; the projection carries the class only,
          // and the argument and result payloads never leave Postgres.
          status: call.error ? ("failed" as const) : ("completed" as const),
          errorClass: call.error ? "ToolCallError" : null,
          startedAt: current.startedAt ?? completedAt,
          completedAt,
        })),
      });
      return { ...updated, steps: [{ ...step, toolCalls: calls }] };
    });
    return this.turnSideToMessage(row, "assistant");
  }

  /**
   * Queue one finalized Turn's projection.
   *
   * Best-effort by construction: a projection that cannot be queued must never
   * roll back a Turn that already happened, and the failure is logged rather
   * than swallowed. When no sink is configured this is a boolean and a return.
   */
  private async enqueueProjection(
    tx: ObservabilityTransaction,
    scope: RequestScope,
    thread: Thread,
    facts: {
      turn: {
        id: string;
        agentVersionId?: string | null;
        status: "completed" | "failed" | "cancelled";
        acceptedAt: Date;
        completedAt: Date;
        costCents?: number | null;
        errorClass?: string | null;
        traceId?: string | null;
        rootSpanId?: string | null;
        externalRuntimeId?: string | null;
      };
      steps: Parameters<typeof buildTurnProjection>[0]["steps"];
      toolCalls?: Parameters<typeof buildTurnProjection>[0]["toolCalls"];
    },
  ): Promise<void> {
    if (!this.observability?.isEnabled()) return;
    // Building the projection is inside the try as well as queueing it.
    // `buildTurnProjection` resolves the erasure salt, which throws in
    // production when it is unset — and that throw would otherwise land outside
    // enqueueTurnBestEffort's own guard and roll back a Turn that had already
    // happened. Nothing about analytics may cost a turn.
    try {
      const projection = buildTurnProjection({
        scope: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: scope.userId,
          // The SIGNED bag, not `scope.sessionContext` — that one has been
          // merged with the Thread row and with a base layer read out of the
          // Postgres `User` table by the time a turn finalizes. See the header
          // of turn-projection.ts.
          signedUserMeta: scope.signedUserMeta,
        },
        thread: { id: thread.id, agentId: thread.agentId, endUserId: thread.endUserId },
        turn: {
          ...facts.turn,
          // The vendor is a cross-reference, never a relationship: the id is
          // recorded, the vocabulary is not allowed any further in.
          runtimeProvider: facts.turn.externalRuntimeId ? "trigger" : null,
          runtimeRunId: facts.turn.externalRuntimeId ?? null,
        },
        steps: facts.steps,
        toolCalls: facts.toolCalls,
      });
      await this.observability.enqueueTurnBestEffort(tx, projection);
    } catch (err) {
      this.logger.error(
        `Failed to build the observability projection for turn ${facts.turn.id}` +
          ` (${err instanceof Error ? err.name : "Error"}); the Turn is unaffected`,
      );
    }
  }

  async failTurn(
    threadId: string,
    turnId: string,
    scope: RequestScope,
    error: unknown,
    model = "unknown",
  ): Promise<void> {
    const thread = await this.findScopedThread(threadId, scope);
    const detail = error instanceof Error ? error.message : String(error);
    const errorClass = error instanceof Error ? error.name : "Error";
    const completedAt = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const active = await tx.turn.findFirst({
        where: { id: turnId, threadId, status: "ACTIVE" },
        select: { id: true, startedAt: true, agentVersionId: true, externalRuntimeId: true },
      });
      if (!active) return { count: 0 };
      await tx.turn.update({
        where: { id: turnId },
        data: {
          status: "FAILED",
          completedAt,
          output: { error: detail.slice(0, 2000) },
          idempotencyKey: null,
        },
      });
      const step = await tx.step.upsert({
        where: { turnId_sequence: { turnId, sequence: 1 } },
        create: {
          turnId,
          sequence: 1,
          model,
          status: "FAILED",
          error: detail.slice(0, 2000),
          startedAt: active.startedAt,
          completedAt,
        },
        update: {
          status: "FAILED",
          error: detail.slice(0, 2000),
          completedAt,
        },
      });
      // A failed Turn that performed chargeable provider work still records
      // usage and cost. It is projected with status `failed`, which is what
      // keeps `billable_unit` zero for it while the money stays visible.
      await this.enqueueProjection(tx, scope, thread, {
        turn: {
          id: turnId,
          agentVersionId: active.agentVersionId,
          status: "failed",
          acceptedAt: active.startedAt ?? completedAt,
          completedAt,
          costCents: step.costCents === null ? null : Number(step.costCents),
          errorClass,
          traceId: scope.traceId ?? null,
          rootSpanId: scope.parentSpanId ?? null,
          externalRuntimeId: active.externalRuntimeId,
        },
        steps: [{
          id: step.id,
          sequence: step.sequence,
          model: step.model,
          status: "failed",
          startedAt: step.startedAt ?? completedAt,
          completedAt,
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
          cacheReadInputTokens: step.cacheReadInputTokens,
          cacheCreationInputTokens: step.cacheCreationInputTokens,
          reasoningTokens: step.reasoningTokens,
          costCents: step.costCents === null ? null : Number(step.costCents),
          modelPriceId: step.modelPriceId,
          inputRate: step.inputRate === null ? null : Number(step.inputRate),
          outputRate: step.outputRate === null ? null : Number(step.outputRate),
          cacheReadRate: step.cacheReadRate === null ? null : Number(step.cacheReadRate),
          cacheWriteRate: step.cacheWriteRate === null ? null : Number(step.cacheWriteRate),
          pricingSource: step.inputRateSource,
          errorClass,
          // The class, not the message: a provider error body can quote the
          // prompt that produced it.
          errorMessageRedacted: null,
        }],
      });
      return { count: 1 };
    });
    if (!result.count) this.logger.warn(`Failed to mark turn ${turnId} failed because it was not active`);
  }

  async findTurnByIdempotency(
    threadId: string,
    scope: RequestScope,
    idempotencyKey: string,
  ): Promise<any | null> {
    await this.findScopedThread(threadId, scope);
    return this.prisma.turn.findUnique({
      where: { threadId_idempotencyKey: { threadId, idempotencyKey } },
      select: {
        id: true,
        threadId: true,
        outputText: true,
        status: true,
        costCents: true,
      },
    });
  }

  private turnSideToMessage(turn: any, role: "user" | "assistant"): StoredMessage {
    const steps = turn.steps ?? [];
    const calls = steps.flatMap((step: any) => step.toolCalls ?? []).map((call: any) => ({
      name: call.toolName ?? call.name,
      params: call.arguments,
      result: unwrapToolResult(call.result),
      error: call.error,
    }));
    const usage = steps.reduce((total: any, step: any) => ({
      inputTokens: total.inputTokens + (step.inputTokens ?? 0),
      outputTokens: total.outputTokens + (step.outputTokens ?? 0),
      cacheCreationInputTokens: total.cacheCreationInputTokens + (step.cacheCreationInputTokens ?? 0),
      cacheReadInputTokens: total.cacheReadInputTokens + (step.cacheReadInputTokens ?? 0),
      reasoningTokens: total.reasoningTokens + (step.reasoningTokens ?? 0),
    }), { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 });
    return {
      id: turn.id,
      turnId: turn.id,
      threadId: turn.threadId,
      role,
      content: role === "user" ? turn.inputText : turn.outputText,
      toolCalls: role === "assistant" && calls.length ? calls : null,
      thinkingContent: role === "assistant" ? turn.thinkingContent : null,
      responseJson: role === "assistant" ? {
        model: steps.at(-1)?.model ?? null,
        usage,
        cost_cents: turn.costCents == null ? null : Number(turn.costCents),
        // WIN-134 — `Turn.costCents` has been the four-rate cache-aware figure
        // since WIN-125, so both names carry it. Emitting only the naive name
        // meant a consumer applying the "prefer cost_with_cache_cents" rule
        // took the fallback branch every time and could never tell a
        // cache-aware row from a legacy one.
        cost_with_cache_cents: turn.costCents == null ? null : Number(turn.costCents),
        no_cache_input_tokens: freshInputTokens(
          usage.inputTokens,
          usage.cacheReadInputTokens,
          usage.cacheCreationInputTokens,
        ),
        latency_ms: turn.latencyMs,
        version_id: turn.agentVersionId,
        version_bucket: String(turn.versionBucket).toLowerCase(),
        structured_output: objectValue(turn.output).structuredOutput ?? null,
      } : null,
      createdAt: role === "assistant" ? (turn.completedAt ?? turn.createdAt) : turn.createdAt,
    };
  }

  async getMessages(threadId: string, scope: RequestScope, options: { limit?: number; offset?: number; allUsers?: boolean } = {}) {
    const thread = await this.getThread(threadId, scope, { allUsers: options.allUsers });
    if (!thread) return { messages: [], total: 0 };
    const sides = (await this.prisma.turn.findMany({
      where: { threadId },
      select: { id: true, status: true },
      orderBy: { sequence: "asc" },
    })).flatMap((turn) => [
      { turnId: turn.id, role: "user" as const },
      ...(turn.status === "SUCCEEDED"
        ? [{ turnId: turn.id, role: "assistant" as const }]
        : []),
    ]);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const page = sides.slice(offset, offset + limit);
    const turnIds = Array.from(new Set(page.map((side) => side.turnId)));
    const turns = turnIds.length
      ? await this.prisma.turn.findMany({
          where: { id: { in: turnIds }, threadId },
          include: {
            steps: {
              include: { toolCalls: { orderBy: { sequence: "asc" } } },
              orderBy: { sequence: "asc" },
            },
          },
        })
      : [];
    const byId = new Map(turns.map((turn) => [turn.id, turn]));
    const messages = page.flatMap((side) => {
      const turn = byId.get(side.turnId);
      return turn ? [this.turnSideToMessage(turn, side.role)] : [];
    });
    return { messages, total: sides.length };
  }

  async loadHistory(threadId: string, scope: RequestScope, limit = 20, replyToMessageId?: string | null) {
    const thread = await this.getThread(threadId, scope);
    if (!thread) return [];
    const cursor = thread.compactedUpToTurnId
      ? await this.prisma.turn.findUnique({ where: { id: thread.compactedUpToTurnId }, select: { sequence: true } })
      : null;
    const turnLimit = Math.max(1, Math.ceil(limit / 2));
    const main = await this.prisma.turn.findMany({
      where: {
        threadId,
        status: "SUCCEEDED",
        ...(replyToMessageId ? { OR: [{ parentTurnId: null }, { parentTurnId: replyToMessageId }] } : { parentTurnId: null }),
        ...(cursor ? { sequence: { gt: cursor.sequence } } : {}),
      },
      // Anchored history normally returns every turn after the cursor. If the
      // emergency cap is reached, retain the newest complete turns instead of
      // permanently hiding the live tail behind the oldest post-cursor turns.
      orderBy: { sequence: "desc" },
      take: cursor ? Math.max(turnLimit * 4, turnLimit + 20) : turnLimit,
    });
    const ordered = main.reverse();
    const history = ordered.flatMap((turn) => [
      ...(turn.inputText ? [{ role: "user" as const, content: turn.inputText }] : []),
      ...(turn.outputText ? [{ role: "assistant" as const, content: turn.outputText }] : []),
    ]);
    if (!replyToMessageId) return history;
    const parent = await this.prisma.turn.findFirst({ where: { id: replyToMessageId, threadId }, select: { outputText: true, inputText: true } });
    return [
      ...history,
      { role: "user" as const, content: `[Sub-thread context: You are replying to this turn: "${parent?.outputText ?? parent?.inputText ?? ""}". Stay focused on this sub-topic.]` },
    ];
  }

  async getThreadReplies(threadId: string, messageId: string, scope: RequestScope): Promise<StoredMessage[]> {
    if (!await this.getThread(threadId, scope)) return [];
    const turns = await this.prisma.turn.findMany({ where: { threadId, parentTurnId: messageId }, include: { steps: { include: { toolCalls: true } } }, orderBy: { sequence: "asc" } });
    return turns.flatMap((turn) => [this.turnSideToMessage(turn, "user"), ...(turn.outputText ? [this.turnSideToMessage(turn, "assistant")] : [])]);
  }

  async batchGetReplyCounts(messageIds: string[], threadId: string, scope: RequestScope): Promise<Map<string, number>> {
    if (!messageIds.length || !await this.getThread(threadId, scope)) return new Map();
    const grouped = await this.prisma.turn.groupBy({ by: ["parentTurnId"], where: { threadId, parentTurnId: { in: messageIds } }, _count: true });
    return new Map(grouped.filter((row) => row.parentTurnId).map((row) => [row.parentTurnId!, row._count]));
  }

  async getOrCreateThread(scope: RequestScope, agentId: string, threadId?: string, opts?: { singleEndUser?: boolean }): Promise<Thread> {
    if (threadId) {
      const existing = await this.getThread(threadId, scope);
      if (existing) return existing;
    }
    return this.createThread(scope, agentId, undefined, opts);
  }

  async forkThread(threadId: string, scope: RequestScope, options: { upToMessageId: string; title?: string }): Promise<Thread> {
    const parent = await this.findScopedThread(threadId, scope);
    const upTo = await this.prisma.turn.findFirst({ where: { id: options.upToMessageId, threadId }, select: { sequence: true } });
    if (!upTo) throw new Error(`Turn ${options.upToMessageId} not found in thread ${threadId}`);
    const forkCount = await this.prisma.thread.count({ where: { parentThreadId: threadId, archivedAt: null, ...this.environmentWhere(scope) } });
    if (forkCount >= 10) throw new Error(`Thread ${threadId} already has ${forkCount} forks (max 10). Archive an existing fork first.`);
    const history = await this.prisma.turn.findMany({ where: { threadId, sequence: { lte: upTo.sequence } }, include: { steps: { include: { toolCalls: true } } }, orderBy: { sequence: "asc" } });
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.thread.create({ data: {
        environmentId: parent.environmentId, agentId: parent.agentId, endUserId: parent.endUserId,
        clusterId: parent.clusterId, parentThreadId: threadId, title: options.title ?? (parent.title ? `${parent.title} (fork)` : "Fork"),
        // A copied summary without a remapped cursor would overlap the cloned
        // live turns. Start the fork uncompacted and let its own cursor advance.
        summary: null,
      }});
      for (const turn of history) {
        await tx.turn.create({ data: {
          threadId: created.id, agentVersionId: turn.agentVersionId, versionBucket: turn.versionBucket,
          sequence: turn.sequence, inputText: turn.inputText, outputText: turn.outputText, input: turn.input as any,
          output: turn.output as any, thinkingContent: turn.thinkingContent, status: turn.status,
          externalRuntimeId: turn.externalRuntimeId, costCents: turn.costCents, latencyMs: turn.latencyMs,
          startedAt: turn.startedAt, completedAt: turn.completedAt, createdAt: turn.createdAt,
          steps: { create: turn.steps.map((step) => ({
            sequence: step.sequence, model: step.model, status: step.status, retryCount: step.retryCount,
            inputTokens: step.inputTokens, outputTokens: step.outputTokens,
            cacheCreationInputTokens: step.cacheCreationInputTokens, cacheReadInputTokens: step.cacheReadInputTokens,
            reasoningTokens: step.reasoningTokens, costCents: step.costCents, latencyMs: step.latencyMs,
            modelPriceId: step.modelPriceId,
            inputRate: step.inputRate, outputRate: step.outputRate,
            cacheReadRate: step.cacheReadRate, cacheWriteRate: step.cacheWriteRate,
            inputRateSource: step.inputRateSource, outputRateSource: step.outputRateSource,
            cacheReadRateSource: step.cacheReadRateSource, cacheWriteRateSource: step.cacheWriteRateSource,
            inputRateObservedAt: step.inputRateObservedAt, outputRateObservedAt: step.outputRateObservedAt,
            cacheReadRateObservedAt: step.cacheReadRateObservedAt, cacheWriteRateObservedAt: step.cacheWriteRateObservedAt,
            inputRateSourceRef: step.inputRateSourceRef, outputRateSourceRef: step.outputRateSourceRef,
            cacheReadRateSourceRef: step.cacheReadRateSourceRef, cacheWriteRateSourceRef: step.cacheWriteRateSourceRef,
            error: step.error, startedAt: step.startedAt, completedAt: step.completedAt, createdAt: step.createdAt,
            toolCalls: { create: step.toolCalls.map((call) => ({
              toolId: call.toolId, sequence: call.sequence, toolName: call.toolName, arguments: call.arguments as any,
              result: call.result as any, status: call.status, retryCount: call.retryCount, error: call.error,
              latencyMs: call.latencyMs, startedAt: call.startedAt, completedAt: call.completedAt, createdAt: call.createdAt,
            })) },
          })) },
        }});
      }
      return tx.thread.findUniqueOrThrow({ where: { id: created.id }, include: this.threadInclude() });
    });
    return this.projectThread(row, scope.userId);
  }

  async editAndRerun(threadId: string, messageId: string, scope: RequestScope, newContent: string): Promise<StoredMessage> {
    await this.findScopedThread(threadId, scope);
    // parentTurnId currently represents reply threads as well as carrying a
    // revision-shaped relation name. Without a distinct branch head and
    // revision state, rewriting this Turn would destroy normalized evidence.
    // Keep the endpoint fail-closed until the schema can represent revisions.
    void messageId;
    void newContent;
    throw new ConversationRevisionNotSupportedError();
  }

  async retryAssistantTurn(threadId: string, messageId: string, scope: RequestScope) {
    await this.findScopedThread(threadId, scope);
    void messageId;
    throw new ConversationRevisionNotSupportedError();
  }

  async listThreadArtifacts(threadId: string, scope: RequestScope, options?: { limit?: number }) {
    await this.findScopedThread(threadId, scope);
    const rows = await this.prisma.artifact.findMany({ where: { threadId, environmentId: scope.environmentId }, orderBy: [{ artifactKey: "asc" }, { revision: "desc" }] });
    const byKey = new Map<string, any>();
    for (const row of rows) {
      const current = byKey.get(row.artifactKey);
      if (current) current.revisionCount += 1;
      else byKey.set(row.artifactKey, { ...row, language: objectValue(row.metadata).language ?? null, revisionCount: 1 });
    }
    return Array.from(byKey.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, Math.max(1, Math.min(options?.limit ?? 100, 500)));
  }

  async reapChatSessions(): Promise<{ scanned: number; closed: number; skippedActive: number; errors: number }> {
    const sdk = (() => { try { return require("@trigger.dev/sdk"); } catch { return null; } })();
    if (configureExternalTriggerSdk(sdk).status !== "configured" || !sdk?.sessions?.list || !sdk?.sessions?.close) {
      return { scanned: 0, closed: 0, skippedActive: 0, errors: 0 };
    }
    const result = { scanned: 0, closed: 0, skippedActive: 0, errors: 0 };
    const sessions = await sdk.sessions.list({ taskIdentifier: "platos.chat.session", status: "ACTIVE", page: 1, perPage: 100 });
    for (const session of sessions?.data ?? []) {
      result.scanned += 1;
      try {
        const thread = await this.prisma.thread.findUnique({ where: { id: session.externalId }, select: { archivedAt: true, status: true } });
        if (!thread || thread.archivedAt || thread.status !== "ACTIVE") {
          await sdk.sessions.close(session.id);
          result.closed += 1;
        } else result.skippedActive += 1;
      } catch {
        result.errors += 1;
      }
    }
    return result;
  }
}

function normalizeToolCalls(events: any[]): Array<{ name: string; arguments: Record<string, unknown>; result: any; error: string | null; latencyMs: number | null }> {
  const calls: Array<{ name: string; arguments: Record<string, unknown>; result: any; error: string | null; latencyMs: number | null }> = [];
  for (const event of events) {
    if (event?.type === "call") {
      calls.push({ name: String(event.name ?? "unknown"), arguments: objectValue(event.params), result: null, error: null, latencyMs: null });
    } else if (event?.type === "result") {
      const call = [...calls].reverse().find((candidate) => candidate.name === String(event.name ?? "unknown") && candidate.result === null);
      if (call) call.result = normalizeToolResult(event.result);
      else calls.push({ name: String(event.name ?? "unknown"), arguments: {}, result: normalizeToolResult(event.result), error: null, latencyMs: null });
    }
  }
  return calls;
}

function normalizeToolResult(value: unknown): Record<string, unknown> | unknown[] | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value as Record<string, unknown> | unknown[];
  return { value };
}

function unwrapToolResult(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return (value as Record<string, unknown>).value;
  }
  return value;
}
