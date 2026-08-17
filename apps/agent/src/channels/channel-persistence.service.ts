import { Injectable, Inject } from "@nestjs/common";
import { CredentialKind } from "@platos/database";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { MessageCryptoService } from "../monitoring/message-crypto.service";

export interface ChannelOwnerScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

export interface InstallationCoordinates {
  teamId: string | null;
  enterpriseId: string | null;
  isEnterpriseInstall: boolean;
}

interface ChannelCredentialPayload extends Record<string, unknown> {
  version?: number;
  kind?: string;
}

interface VerifiedIdentityInput {
  issuer: string;
  channel: string;
  subject: string;
  profile?: Record<string, unknown>;
}

/**
 * Clean Channel* persistence boundary.
 *
 * Channel rows contain only public configuration and Credential references.
 * The existing channel encryption envelope is retained until WIN-123 lands,
 * but ciphertext lives exclusively on Credential.encryptedReference. Every
 * scope returned here is derived from persisted Environment ancestry.
 */
@Injectable()
export class ChannelPersistenceService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly messageCrypto: MessageCryptoService
  ) {}

  async listApps(scope: ChannelOwnerScope): Promise<any[]> {
    await this.requireEnvironmentScope(scope);
    const rows = await this.prisma.channelApp.findMany({
      where: { environmentId: scope.environmentId },
      include: {
        credential: true,
        environment: { include: { project: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row: any) => this.normalizeApp(row));
  }

  async loadScopedApp(scope: ChannelOwnerScope, appId: string): Promise<any | null> {
    if (!(await this.environmentScopeMatches(scope))) return null;
    const row = await this.prisma.channelApp.findFirst({
      where: { id: appId, environmentId: scope.environmentId },
      include: {
        credential: true,
        environment: { include: { project: true } },
      },
    });
    return row ? this.normalizeApp(row) : null;
  }

  async createApp(
    scope: ChannelOwnerScope,
    data: {
      provider: string;
      displayName?: string;
      clientId: string;
      scopes?: string[];
      distribution: string;
      defaultAgentId?: string;
      agentRouting?: unknown;
      clientSecret: string;
      signingSecret: string;
      aiAppsSurface?: boolean;
      linking?: string;
      tokenRotation?: boolean;
    }
  ): Promise<any> {
    await this.requireEnvironmentScope(scope);
    const appId = await this.prisma.$transaction(async (tx: any) => {
      const app = await tx.channelApp.create({
        data: {
          environmentId: scope.environmentId,
          provider: data.provider,
          clientId: data.clientId,
          distribution: data.distribution,
          ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
          ...(data.scopes !== undefined ? { scopes: data.scopes } : {}),
          ...(data.defaultAgentId ? { defaultAgentId: data.defaultAgentId } : {}),
          ...(data.agentRouting !== undefined ? { agentRouting: data.agentRouting } : {}),
        },
        select: { id: true },
      });
      const credential = await tx.credential.create({
        data: {
          environmentId: scope.environmentId,
          kind: CredentialKind.CHANNEL_SECRET,
          name: `channel-app:${app.id}`,
          provider: data.provider,
          externalClientId: data.clientId,
          encryptedReference: this.encryptPayload({
            version: 1,
            kind: "channel-app",
            clientSecret: data.clientSecret,
            signingSecret: data.signingSecret,
            aiAppsSurface: data.aiAppsSurface ?? true,
            linking: data.linking ?? "none",
            tokenRotation: data.tokenRotation ?? false,
          }),
        },
        select: { id: true },
      });
      await tx.channelApp.update({
        where: { id: app.id },
        data: { credentialId: credential.id },
      });
      return app.id;
    });
    const app = await this.loadScopedApp(scope, appId);
    if (!app) throw new Error("channel app unavailable after write");
    return app;
  }

  async updateApp(
    scope: ChannelOwnerScope,
    appId: string,
    publicData: Record<string, unknown>,
    credentialData: Record<string, unknown>
  ): Promise<any | null> {
    const current = await this.loadScopedApp(scope, appId);
    if (!current) return null;
    await this.prisma.$transaction(async (tx: any) => {
      let credentialId = current.credentialId ?? null;
      if (Object.keys(credentialData).length > 0) {
        const payload: ChannelCredentialPayload = {
          ...this.payloadOf(current.credential, "channel-app", scope.environmentId),
          ...credentialData,
          version: 1,
          kind: "channel-app",
        };
        credentialId = await this.writeCredential(tx, {
          credentialId,
          environmentId: scope.environmentId,
          name: `channel-app:${appId}`,
          provider: String(publicData.provider ?? current.provider),
          externalClientId: String(publicData.clientId ?? current.clientId),
          payload,
        });
      }
      await tx.channelApp.update({
        where: { id: appId },
        data: {
          ...publicData,
          ...(credentialId !== current.credentialId ? { credentialId } : {}),
        },
      });
      if (
        Object.prototype.hasOwnProperty.call(publicData, "clientId") &&
        credentialId &&
        Object.keys(credentialData).length === 0
      ) {
        const updated = await tx.credential.updateMany({
          where: {
            id: credentialId,
            environmentId: scope.environmentId,
            kind: CredentialKind.CHANNEL_SECRET,
          },
          data: { externalClientId: String(publicData.clientId) },
        });
        if (updated.count !== 1) throw new Error("channel credential scope mismatch");
      }
    });
    return this.loadScopedApp(scope, appId);
  }

  async deleteApp(scope: ChannelOwnerScope, appId: string): Promise<boolean> {
    const current = await this.loadScopedApp(scope, appId);
    if (!current) return false;
    await this.prisma.$transaction(async (tx: any) => {
      const installations = await tx.channelInstallation.findMany({
        where: { appId },
        select: { credentialId: true },
      });
      await tx.channelApp.delete({ where: { id: appId } });
      const credentialIds = [
        current.credentialId,
        ...installations.map((row: any) => row.credentialId),
      ].filter((id: unknown): id is string => typeof id === "string");
      if (credentialIds.length > 0) {
        await tx.credential.deleteMany({
          where: { id: { in: credentialIds }, environmentId: scope.environmentId },
        });
      }
    });
    return true;
  }

  async listInstallations(scope: ChannelOwnerScope, appId: string): Promise<any[] | null> {
    const app = await this.loadScopedApp(scope, appId);
    if (!app) return null;
    const rows = await this.prisma.channelInstallation.findMany({
      where: { appId },
      include: {
        credential: true,
        app: {
          include: {
            credential: true,
            environment: { include: { project: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row: any) => this.normalizeInstallation(row));
  }

  async updateInstallationBinding(
    scope: ChannelOwnerScope,
    appId: string,
    installationId: string,
    data: Record<string, unknown>
  ): Promise<any | null> {
    if (!(await this.loadScopedApp(scope, appId))) return null;
    const current = await this.loadInstallation(installationId, appId);
    if (!current) return null;
    await this.prisma.channelInstallation.update({
      where: { id: installationId },
      data,
    });
    return this.loadInstallation(installationId, appId);
  }

  async revokeInstallation(
    scope: ChannelOwnerScope,
    appId: string,
    installationId: string
  ): Promise<any | null> {
    if (!(await this.loadScopedApp(scope, appId))) return null;
    const current = await this.loadInstallation(installationId, appId);
    if (!current) return null;
    const revokedAt = new Date();
    await this.prisma.$transaction(async (tx: any) => {
      await tx.channelInstallation.update({
        where: { id: installationId },
        data: { status: "revoked", revokedAt },
      });
      if (current.credentialId) {
        const updated = await tx.credential.updateMany({
          where: {
            id: current.credentialId,
            environmentId: scope.environmentId,
            kind: CredentialKind.CHANNEL_SECRET,
          },
          data: { revokedAt },
        });
        if (updated.count !== 1) throw new Error("channel credential scope mismatch");
      }
    });
    return this.loadInstallation(installationId, appId);
  }

  async listConnections(scope: ChannelOwnerScope): Promise<any[]> {
    await this.requireEnvironmentScope(scope);
    const rows = await this.prisma.channelConnection.findMany({
      where: { environmentId: scope.environmentId },
      include: {
        credential: true,
        entity: true,
        environment: { include: { project: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row: any) => this.normalizeConnection(row));
  }

  async loadScopedConnection(scope: ChannelOwnerScope, connectionId: string): Promise<any | null> {
    if (!(await this.environmentScopeMatches(scope))) return null;
    const row = await this.prisma.channelConnection.findFirst({
      where: { id: connectionId, environmentId: scope.environmentId },
      include: {
        credential: true,
        entity: true,
        environment: { include: { project: true } },
      },
    });
    return row ? this.normalizeConnection(row) : null;
  }

  async createConnection(
    scope: ChannelOwnerScope,
    data: {
      provider: string;
      displayName?: string;
      defaultAgentId: string;
      agentRouting?: unknown;
      credentials?: Record<string, unknown> | null;
      config?: Record<string, unknown> | null;
      webhookSecret: string;
    }
  ): Promise<any> {
    await this.requireEnvironmentScope(scope);
    const connectionId = await this.prisma.$transaction(async (tx: any) => {
      const connection = await tx.channelConnection.create({
        data: {
          environmentId: scope.environmentId,
          provider: data.provider,
          defaultAgentId: data.defaultAgentId,
          ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
          ...(data.agentRouting !== undefined ? { agentRouting: data.agentRouting } : {}),
        },
        select: { id: true },
      });
      const credential = await tx.credential.create({
        data: {
          environmentId: scope.environmentId,
          kind: CredentialKind.CHANNEL_SECRET,
          name: `channel-connection:${connection.id}`,
          provider: data.provider,
          encryptedReference: this.encryptPayload({
            version: 1,
            kind: "channel-connection",
            credentials: data.credentials ?? null,
            config: data.config ?? null,
            webhookSecret: data.webhookSecret,
          }),
        },
        select: { id: true },
      });
      await tx.channelConnection.update({
        where: { id: connection.id },
        data: { credentialId: credential.id },
      });
      return connection.id;
    });
    const connection = await this.loadScopedConnection(scope, connectionId);
    if (!connection) throw new Error("channel connection unavailable after write");
    return connection;
  }

  async updateConnection(
    scope: ChannelOwnerScope,
    connectionId: string,
    publicData: Record<string, unknown>,
    credentialData: Record<string, unknown>
  ): Promise<any | null> {
    const current = await this.loadScopedConnection(scope, connectionId);
    if (!current) return null;
    await this.prisma.$transaction(async (tx: any) => {
      let credentialId = current.credentialId ?? null;
      if (Object.keys(credentialData).length > 0) {
        const payload: ChannelCredentialPayload = {
          ...this.payloadOf(current.credential, "channel-connection", scope.environmentId),
          ...credentialData,
          version: 1,
          kind: "channel-connection",
        };
        credentialId = await this.writeCredential(tx, {
          credentialId,
          environmentId: scope.environmentId,
          name: `channel-connection:${connectionId}`,
          provider: String(current.provider),
          externalClientId: null,
          payload,
        });
      }
      await tx.channelConnection.update({
        where: { id: connectionId },
        data: {
          ...publicData,
          ...(credentialId !== current.credentialId ? { credentialId } : {}),
        },
      });
    });
    return this.loadScopedConnection(scope, connectionId);
  }

  async deleteConnection(scope: ChannelOwnerScope, connectionId: string): Promise<boolean> {
    const current = await this.loadScopedConnection(scope, connectionId);
    if (!current) return false;
    await this.prisma.$transaction(async (tx: any) => {
      await tx.channelConnection.delete({ where: { id: connectionId } });
      if (current.credentialId) {
        await tx.credential.deleteMany({
          where: { id: current.credentialId, environmentId: scope.environmentId },
        });
      }
    });
    return true;
  }

  async loadApp(appId: string): Promise<any | null> {
    if (!appId) return null;
    const row = await this.prisma.channelApp.findUnique({
      where: { id: appId },
      include: {
        credential: true,
        environment: { include: { project: true } },
      },
    });
    return row ? this.normalizeApp(row) : null;
  }

  async loadInstallation(installationId: string, expectedAppId?: string): Promise<any | null> {
    if (!installationId) return null;
    const row = await this.prisma.channelInstallation.findFirst({
      where: {
        id: installationId,
        ...(expectedAppId ? { appId: expectedAppId } : {}),
      },
      include: {
        credential: true,
        app: {
          include: {
            credential: true,
            environment: { include: { project: true } },
          },
        },
      },
    });
    return row ? this.normalizeInstallation(row) : null;
  }

  async findActiveInstallation(
    appId: string,
    teamId: string | null,
    enterpriseId: string | null
  ): Promise<any | null> {
    const exactKey = this.externalInstallationId(teamId, enterpriseId, false);
    if (exactKey) {
      const exact = await this.findInstallationByExternalId(appId, exactKey);
      if (exact) return exact;
    }
    if (teamId && enterpriseId) {
      const gridKey = this.externalInstallationId(null, enterpriseId, true);
      if (gridKey) return this.findInstallationByExternalId(appId, gridKey);
    }
    return null;
  }

  async revokeInstallations(
    appId: string,
    teamId: string | null,
    enterpriseId: string | null
  ): Promise<number> {
    const exactKey = this.externalInstallationId(teamId, enterpriseId, false);
    let count = exactKey ? await this.revokeByExternalInstallationId(appId, exactKey) : 0;
    if (count === 0 && teamId && enterpriseId) {
      const gridKey = this.externalInstallationId(null, enterpriseId, true);
      if (gridKey) count = await this.revokeByExternalInstallationId(appId, gridKey);
    }
    return count;
  }

  async loadConnection(connectionId: string): Promise<any | null> {
    if (!connectionId) return null;
    const row = await this.prisma.channelConnection.findUnique({
      where: { id: connectionId },
      include: {
        credential: true,
        entity: true,
        environment: { include: { project: true } },
      },
    });
    return row ? this.normalizeConnection(row) : null;
  }

  async listEnabledConnections(provider: string): Promise<any[]> {
    const rows = await this.prisma.channelConnection.findMany({
      where: { provider, enabled: true },
      include: {
        credential: true,
        entity: true,
        environment: { include: { project: true } },
      },
    });
    return rows.map((row: any) => this.normalizeConnection(row));
  }

  async upsertInstallationGrant(
    app: any,
    coordinates: InstallationCoordinates,
    grant: {
      botToken: string;
      refreshToken?: string | null;
      tokenExpiresAt?: Date | null;
      botUserId?: string | null;
      grantedScopes: string[];
      displayName?: string | null;
      installedByUserId?: string | null;
      defaultAgentId?: string | null;
      agentRouting?: unknown;
    }
  ): Promise<any> {
    const externalInstallationId = this.externalInstallationId(
      coordinates.teamId,
      coordinates.enterpriseId,
      coordinates.isEnterpriseInstall
    );
    if (!externalInstallationId) throw new Error("installation identity unavailable");
    const scope = this.scopeOf(app);
    const payload: ChannelCredentialPayload = {
      version: 1,
      kind: "channel-installation",
      botToken: grant.botToken,
      refreshToken: grant.refreshToken ?? null,
      tokenExpiresAt: grant.tokenExpiresAt?.toISOString() ?? null,
      botUserId: grant.botUserId ?? null,
      installedByUserId: grant.installedByUserId ?? null,
      teamId: coordinates.teamId,
      enterpriseId: coordinates.enterpriseId,
      isEnterpriseInstall: coordinates.isEnterpriseInstall,
    };
    const encryptedReference = this.encryptPayload(payload);
    const credentialName = `channel-installation:${app.id}:${externalInstallationId}`;

    const installationId = await this.prisma.$transaction(async (tx: any) => {
      const existing = await tx.channelInstallation.findUnique({
        where: {
          appId_externalInstallationId: {
            appId: String(app.id),
            externalInstallationId,
          },
        },
        select: { id: true, credentialId: true },
      });
      let credentialId = existing?.credentialId ?? null;
      if (credentialId) {
        const updated = await tx.credential.updateMany({
          where: {
            id: credentialId,
            environmentId: scope.environmentId,
            kind: CredentialKind.CHANNEL_SECRET,
          },
          data: {
            encryptedReference,
            provider: String(app.provider),
            externalClientId: externalInstallationId,
            expiresAt: grant.tokenExpiresAt ?? null,
            revokedAt: null,
          },
        });
        if (updated.count !== 1) throw new Error("installation credential scope mismatch");
      } else {
        const credential = await tx.credential.upsert({
          where: {
            environmentId_kind_name: {
              environmentId: scope.environmentId,
              kind: CredentialKind.CHANNEL_SECRET,
              name: credentialName,
            },
          },
          update: {
            encryptedReference,
            provider: String(app.provider),
            externalClientId: externalInstallationId,
            expiresAt: grant.tokenExpiresAt ?? null,
            revokedAt: null,
          },
          create: {
            environmentId: scope.environmentId,
            kind: CredentialKind.CHANNEL_SECRET,
            name: credentialName,
            provider: String(app.provider),
            externalClientId: externalInstallationId,
            encryptedReference,
            expiresAt: grant.tokenExpiresAt ?? null,
          },
        });
        credentialId = credential.id;
      }

      const installation = await tx.channelInstallation.upsert({
        where: {
          appId_externalInstallationId: {
            appId: String(app.id),
            externalInstallationId,
          },
        },
        update: {
          displayName: grant.displayName ?? null,
          credentialId,
          grantedScopes: grant.grantedScopes,
          status: "active",
          revokedAt: null,
          ...(grant.defaultAgentId !== undefined ? { defaultAgentId: grant.defaultAgentId } : {}),
          ...(grant.agentRouting !== undefined ? { agentRouting: grant.agentRouting } : {}),
        },
        create: {
          appId: String(app.id),
          externalInstallationId,
          displayName: grant.displayName ?? null,
          credentialId,
          grantedScopes: grant.grantedScopes,
          ...(grant.defaultAgentId !== undefined ? { defaultAgentId: grant.defaultAgentId } : {}),
          ...(grant.agentRouting !== undefined ? { agentRouting: grant.agentRouting } : {}),
          status: "active",
        },
        select: { id: true },
      });
      return installation.id;
    });

    const installed = await this.loadInstallation(installationId, String(app.id));
    if (!installed) throw new Error("installation unavailable after write");
    return installed;
  }

  async rotateInstallationGrant(
    installationId: string,
    appId: string,
    updates: { botToken: string; refreshToken: string; tokenExpiresAt?: Date | null }
  ): Promise<any | null> {
    const current = await this.loadInstallation(installationId, appId);
    if (!current?.credentialId) return null;
    const payload = this.installationPayload(current);
    const nextPayload: ChannelCredentialPayload = {
      ...payload,
      version: 1,
      kind: "channel-installation",
      botToken: updates.botToken,
      refreshToken: updates.refreshToken,
      tokenExpiresAt: updates.tokenExpiresAt?.toISOString() ?? payload.tokenExpiresAt ?? null,
    };
    const scope = this.scopeOf(current.app);
    const updated = await this.prisma.credential.updateMany({
      where: {
        id: current.credentialId,
        environmentId: scope.environmentId,
        kind: CredentialKind.CHANNEL_SECRET,
        revokedAt: null,
      },
      data: {
        encryptedReference: this.encryptPayload(nextPayload),
        expiresAt: updates.tokenExpiresAt ?? undefined,
      },
    });
    if (updated.count !== 1) return null;
    return this.loadInstallation(installationId, appId);
  }

  stampInstallationLastEvent(installationId: string): Promise<unknown> {
    return this.prisma.channelInstallation.updateMany({
      where: { id: installationId, status: "active" },
      data: { lastEventAt: new Date() },
    });
  }

  async resolveConnectionThread(input: {
    connection: any;
    provider: string;
    realm: string;
    authorSubject: string;
    channelThreadKey: string;
    agentId: string;
    singleEndUser: boolean;
  }): Promise<{ agentId: string; threadId: string; endUserId: string }> {
    const connection = await this.loadConnection(String(input.connection?.id ?? ""));
    if (!connection || connection.enabled !== true) {
      throw new Error("channel connection unavailable");
    }
    if (connection.provider !== input.provider) {
      throw new Error("channel provider mismatch");
    }
    const scope = this.scopeOf(connection);
    const realm =
      connection.provider === "slack"
        ? String(input.realm || connection.config?.team_id || "")
        : input.realm;
    const authorEndUserId = await this.resolveVerifiedIdentity(scope, {
      issuer: this.channelIssuer(input.provider, realm),
      channel: input.provider,
      subject: input.authorSubject,
      profile: { externalUserId: `${input.provider}:${realm}:${input.authorSubject}` },
    });
    const existing = await this.prisma.channelThread.findUnique({
      where: {
        connectionId_channelThreadKey: {
          connectionId: String(connection.id),
          channelThreadKey: input.channelThreadKey,
        },
      },
      include: { thread: true },
    });
    if (existing) {
      return {
        agentId: existing.thread.agentId,
        threadId: existing.threadId,
        endUserId: existing.thread.endUserId,
      };
    }
    await this.requireAgentBinding(scope, input.agentId);
    const threadEndUserId = input.singleEndUser ? authorEndUserId : null;
    return this.createConnectionThread({
      scope,
      connectionId: String(connection.id),
      channelThreadKey: input.channelThreadKey,
      agentId: input.agentId,
      endUserId: threadEndUserId,
      authorEndUserId,
      provider: input.provider,
      singleEndUser: input.singleEndUser,
    });
  }

  async resolveAppThread(input: {
    app: any;
    installation: any;
    realm: string;
    authorSubject: string;
    channelThreadKey: string;
    agentId: string;
    singleEndUser: boolean;
  }): Promise<{ agentId: string; threadId: string; endUserId: string }> {
    const canonicalInstallation = await this.loadInstallation(
      String(input.installation.id),
      String(input.app.id)
    );
    if (!canonicalInstallation || canonicalInstallation.status !== "active") {
      throw new Error("installation unavailable");
    }
    const app = canonicalInstallation.app;
    const scope = this.scopeOf(app);
    const realm = String(canonicalInstallation.teamId ?? canonicalInstallation.enterpriseId ?? "");
    const authorEndUserId = await this.resolveVerifiedIdentity(scope, {
      issuer: this.channelIssuer("slack", realm),
      channel: "slack",
      subject: input.authorSubject,
      profile: { externalUserId: `slack:${realm}:${input.authorSubject}` },
    });
    const existing = await this.prisma.channelAppThread.findUnique({
      where: {
        installationId_channelThreadKey: {
          installationId: canonicalInstallation.id,
          channelThreadKey: input.channelThreadKey,
        },
      },
      include: { thread: true },
    });
    if (existing) {
      return {
        agentId: existing.thread.agentId,
        threadId: existing.threadId,
        endUserId: existing.thread.endUserId,
      };
    }
    await this.requireAgentBinding(scope, input.agentId);
    const threadEndUserId = input.singleEndUser ? authorEndUserId : null;
    return this.createAppThread({
      scope,
      installationId: canonicalInstallation.id,
      channelThreadKey: input.channelThreadKey,
      agentId: input.agentId,
      endUserId: threadEndUserId,
      authorEndUserId,
      provider: "slack",
      singleEndUser: input.singleEndUser,
    });
  }

  async attachVerifiedEmail(input: {
    appId: string;
    installationId: string;
    realm: string;
    slackUserId: string;
    email: string;
  }): Promise<{ status: "linked"; endUserId: string } | { status: "missing" | "conflict" }> {
    const installation = await this.loadInstallation(input.installationId, input.appId);
    if (!installation || installation.status !== "active") return { status: "missing" };
    const scope = this.scopeOf(installation.app);
    const realm = String(installation.teamId ?? installation.enterpriseId ?? "");
    let slack = await this.findIdentity(scope.organizationId, {
      issuer: this.channelIssuer("slack", realm),
      channel: "slack",
      subject: input.slackUserId,
    });
    if (!slack) {
      await this.resolveVerifiedIdentity(scope, {
        issuer: this.channelIssuer("slack", realm),
        channel: "slack",
        subject: input.slackUserId,
        profile: {
          externalUserId: `slack:${realm}:${input.slackUserId}`,
        },
      });
      slack = await this.findIdentity(scope.organizationId, {
        issuer: this.channelIssuer("slack", realm),
        channel: "slack",
        subject: input.slackUserId,
      });
    }
    if (!slack || !slack.verifiedAt || slack.disabledAt) return { status: "missing" };
    const emailIdentity: VerifiedIdentityInput = {
      issuer: "email",
      channel: "email",
      subject: input.email.trim().toLowerCase(),
      profile: { email: input.email.trim().toLowerCase() },
    };
    const existing = await this.findIdentity(scope.organizationId, emailIdentity);
    if (existing && existing.endUserId !== slack.endUserId) {
      return { status: "conflict" };
    }
    if (existing) {
      await this.prisma.endUserIdentity.updateMany({
        where: {
          id: existing.id,
          endUserId: slack.endUserId,
          organizationId: scope.organizationId,
        },
        data: { verifiedAt: new Date(), disabledAt: null, profile: emailIdentity.profile },
      });
    } else {
      await this.prisma.endUserIdentity.create({
        data: {
          endUserId: slack.endUserId,
          organizationId: scope.organizationId,
          issuer: emailIdentity.issuer,
          channel: emailIdentity.channel,
          subject: emailIdentity.subject,
          profile: emailIdentity.profile,
          verifiedAt: new Date(),
        },
      });
    }
    return { status: "linked", endUserId: slack.endUserId };
  }

  async isSlackUserLinked(app: any, realm: string, slackUserId: string): Promise<boolean> {
    const scope = this.scopeOf(app);
    const slack = await this.findIdentity(scope.organizationId, {
      issuer: this.channelIssuer("slack", realm),
      channel: "slack",
      subject: slackUserId,
    });
    if (!slack || !slack.verifiedAt || slack.disabledAt) return false;
    const email = await this.prisma.endUserIdentity.findFirst({
      where: {
        organizationId: scope.organizationId,
        endUserId: slack.endUserId,
        channel: "email",
        verifiedAt: { not: null },
        disabledAt: null,
      },
      select: { id: true },
    });
    return !!email;
  }

  async unlinkSlackUserEmails(app: any, realm: string, slackUserId: string): Promise<number> {
    const scope = this.scopeOf(app);
    const slack = await this.findIdentity(scope.organizationId, {
      issuer: this.channelIssuer("slack", realm),
      channel: "slack",
      subject: slackUserId,
    });
    if (!slack) return 0;
    const deleted = await this.prisma.endUserIdentity.deleteMany({
      where: {
        organizationId: scope.organizationId,
        endUserId: slack.endUserId,
        channel: "email",
      },
    });
    return deleted.count;
  }

  async disableLinkedEmails(app: any, realms: string[], slackUserIds: string[]): Promise<number> {
    const scope = this.scopeOf(app);
    let count = 0;
    for (const slackUserId of slackUserIds) {
      for (const realm of realms) {
        const slack = await this.findIdentity(scope.organizationId, {
          issuer: this.channelIssuer("slack", realm),
          channel: "slack",
          subject: slackUserId,
        });
        if (!slack) continue;
        const disabled = await this.prisma.endUserIdentity.updateMany({
          where: {
            organizationId: scope.organizationId,
            endUserId: slack.endUserId,
            channel: "email",
            disabledAt: null,
          },
          data: { disabledAt: new Date() },
        });
        count += disabled.count;
        break;
      }
    }
    return count;
  }

  scopeOf(row: any): ChannelOwnerScope {
    const environment = row?.environment ?? row?.app?.environment;
    const project = environment?.project;
    if (!environment?.id || !project?.id || !project?.organizationId) {
      throw new Error("canonical channel ancestry unavailable");
    }
    return {
      organizationId: String(project.organizationId),
      projectId: String(project.id),
      environmentId: String(environment.id),
    };
  }

  installationPayload(installation: any): ChannelCredentialPayload {
    const environmentId = String(
      installation?.app?.environmentId ?? installation?.app?.environment?.id ?? ""
    );
    return this.payloadOf(installation?.credential, "channel-installation", environmentId);
  }

  private normalizeApp(row: any): any {
    const scope = this.scopeOf(row);
    const payload = this.payloadOf(row.credential, "channel-app", String(row.environmentId));
    return {
      ...row,
      ...scope,
      clientSecret: payload.clientSecret,
      signingSecret: payload.signingSecret,
      hasClientSecret: typeof payload.clientSecret === "string" && payload.clientSecret.length > 0,
      hasSigningSecret:
        typeof payload.signingSecret === "string" && payload.signingSecret.length > 0,
      linking: typeof payload.linking === "string" ? payload.linking : "none",
      aiAppsSurface: payload.aiAppsSurface !== false,
      tokenRotation: payload.tokenRotation === true,
      credentialRevision: this.credentialRevision(row.credential),
    };
  }

  private normalizeInstallation(row: any): any {
    const payload = this.payloadOf(
      row.credential,
      "channel-installation",
      String(row.app.environmentId)
    );
    const coordinates = this.coordinatesFrom(row.externalInstallationId, payload);
    return {
      ...row,
      app: this.normalizeApp(row.app),
      agentId: row.defaultAgentId,
      teamName: row.displayName,
      ...coordinates,
      botToken: payload.botToken,
      refreshToken: payload.refreshToken,
      hasBotToken: typeof payload.botToken === "string" && payload.botToken.length > 0,
      hasRefreshToken: typeof payload.refreshToken === "string" && payload.refreshToken.length > 0,
      tokenExpiresAt: payload.tokenExpiresAt,
      botUserId: payload.botUserId,
      installedByUserId: payload.installedByUserId,
      credentialRevision: this.credentialRevision(row.credential),
    };
  }

  private normalizeConnection(row: any): any {
    const scope = this.scopeOf(row);
    const payload = this.payloadOf(row.credential, "channel-connection", String(row.environmentId));
    return {
      ...row,
      ...scope,
      entityPk: row.entityId,
      agentId: row.defaultAgentId,
      credentials: payload.credentials ?? null,
      hasCredentials:
        !!payload.credentials &&
        typeof payload.credentials === "object" &&
        !Array.isArray(payload.credentials),
      config: payload.config ?? null,
      webhookSecret: payload.webhookSecret,
      credentialRevision: this.credentialRevision(row.credential),
    };
  }

  private async findInstallationByExternalId(
    appId: string,
    externalInstallationId: string
  ): Promise<any | null> {
    const row = await this.prisma.channelInstallation.findFirst({
      where: { appId, externalInstallationId, status: "active", revokedAt: null },
      include: {
        credential: true,
        app: {
          include: {
            credential: true,
            environment: { include: { project: true } },
          },
        },
      },
    });
    if (!row || row.credential?.revokedAt) return null;
    return this.normalizeInstallation(row);
  }

  private async revokeByExternalInstallationId(
    appId: string,
    externalInstallationId: string
  ): Promise<number> {
    return this.prisma.$transaction(async (tx: any) => {
      const rows = await tx.channelInstallation.findMany({
        where: { appId, externalInstallationId, status: "active" },
        select: { id: true, credentialId: true },
      });
      if (rows.length === 0) return 0;
      const revokedAt = new Date();
      const result = await tx.channelInstallation.updateMany({
        where: { id: { in: rows.map((row: any) => row.id) }, status: "active" },
        data: { status: "revoked", revokedAt },
      });
      const credentialIds = rows
        .map((row: any) => row.credentialId)
        .filter((id: unknown): id is string => typeof id === "string");
      if (credentialIds.length > 0) {
        await tx.credential.updateMany({
          where: { id: { in: credentialIds }, revokedAt: null },
          data: { revokedAt },
        });
      }
      return result.count;
    });
  }

  private externalInstallationId(
    teamId: string | null,
    enterpriseId: string | null,
    isEnterpriseInstall: boolean
  ): string | null {
    if (isEnterpriseInstall || (!teamId && enterpriseId)) {
      return enterpriseId ? `slack:enterprise:${enterpriseId}` : null;
    }
    return teamId ? `slack:team:${teamId}` : null;
  }

  private coordinatesFrom(
    externalInstallationId: string,
    payload: ChannelCredentialPayload
  ): InstallationCoordinates {
    const teamId = typeof payload.teamId === "string" ? payload.teamId : null;
    const enterpriseId = typeof payload.enterpriseId === "string" ? payload.enterpriseId : null;
    if (teamId || enterpriseId) {
      return {
        teamId,
        enterpriseId,
        isEnterpriseInstall: payload.isEnterpriseInstall === true,
      };
    }
    if (externalInstallationId.startsWith("slack:enterprise:")) {
      return {
        teamId: null,
        enterpriseId: externalInstallationId.slice("slack:enterprise:".length),
        isEnterpriseInstall: true,
      };
    }
    if (externalInstallationId.startsWith("slack:team:")) {
      return {
        teamId: externalInstallationId.slice("slack:team:".length),
        enterpriseId: null,
        isEnterpriseInstall: false,
      };
    }
    return { teamId: null, enterpriseId: null, isEnterpriseInstall: false };
  }

  private async resolveVerifiedIdentity(
    scope: ChannelOwnerScope,
    identity: VerifiedIdentityInput
  ): Promise<string> {
    const existing = await this.findIdentity(scope.organizationId, identity);
    if (existing) {
      await this.prisma.endUserIdentity.updateMany({
        where: {
          id: existing.id,
          endUserId: existing.endUserId,
          organizationId: scope.organizationId,
        },
        data: {
          verifiedAt: existing.verifiedAt ?? new Date(),
          disabledAt: null,
          ...(identity.profile ? { profile: identity.profile } : {}),
        },
      });
      return existing.endUserId;
    }
    try {
      return await this.prisma.$transaction(async (tx: any) => {
        const endUser = await tx.endUser.create({
          data: { organizationId: scope.organizationId },
          select: { id: true },
        });
        await tx.endUserIdentity.create({
          data: {
            endUserId: endUser.id,
            organizationId: scope.organizationId,
            issuer: identity.issuer,
            channel: identity.channel,
            subject: identity.subject,
            profile: identity.profile,
            verifiedAt: new Date(),
          },
        });
        return endUser.id;
      });
    } catch {
      const raced = await this.findIdentity(scope.organizationId, identity);
      if (raced?.endUserId) return raced.endUserId;
      throw new Error("channel identity resolution failed");
    }
  }

  private findIdentity(
    organizationId: string,
    identity: Pick<VerifiedIdentityInput, "issuer" | "channel" | "subject">
  ): Promise<any | null> {
    return this.prisma.endUserIdentity.findUnique({
      where: {
        organizationId_issuer_channel_subject: {
          organizationId,
          issuer: identity.issuer,
          channel: identity.channel,
          subject: identity.subject,
        },
      },
    });
  }

  private channelIssuer(provider: string, realm: string): string {
    return `channel:${provider}:${realm || "global"}`;
  }

  private async requireEnvironmentScope(scope: ChannelOwnerScope): Promise<void> {
    if (!(await this.environmentScopeMatches(scope))) {
      throw new Error("canonical channel scope unavailable");
    }
  }

  private async environmentScopeMatches(scope: ChannelOwnerScope): Promise<boolean> {
    const environment = await this.prisma.environment.findUnique({
      where: { id: scope.environmentId },
      include: { project: true },
    });
    return !!(
      environment &&
      String(environment.projectId) === scope.projectId &&
      String(environment.project?.id) === scope.projectId &&
      String(environment.project?.organizationId) === scope.organizationId
    );
  }

  private async writeCredential(
    tx: any,
    input: {
      credentialId: string | null;
      environmentId: string;
      name: string;
      provider: string;
      externalClientId: string | null;
      payload: ChannelCredentialPayload;
    }
  ): Promise<string> {
    const encryptedReference = this.encryptPayload(input.payload);
    if (input.credentialId) {
      const updated = await tx.credential.updateMany({
        where: {
          id: input.credentialId,
          environmentId: input.environmentId,
          kind: CredentialKind.CHANNEL_SECRET,
        },
        data: {
          encryptedReference,
          provider: input.provider,
          externalClientId: input.externalClientId,
          revokedAt: null,
        },
      });
      if (updated.count !== 1) throw new Error("channel credential scope mismatch");
      return input.credentialId;
    }
    const credential = await tx.credential.upsert({
      where: {
        environmentId_kind_name: {
          environmentId: input.environmentId,
          kind: CredentialKind.CHANNEL_SECRET,
          name: input.name,
        },
      },
      update: {
        encryptedReference,
        provider: input.provider,
        externalClientId: input.externalClientId,
        revokedAt: null,
      },
      create: {
        environmentId: input.environmentId,
        kind: CredentialKind.CHANNEL_SECRET,
        name: input.name,
        provider: input.provider,
        externalClientId: input.externalClientId,
        encryptedReference,
      },
      select: { id: true },
    });
    return credential.id;
  }

  private async requireAgentBinding(scope: ChannelOwnerScope, agentId: string): Promise<void> {
    const binding = await this.prisma.agentBinding.findFirst({
      where: {
        agentId,
        environmentId: scope.environmentId,
        agent: { projectId: scope.projectId },
        environment: {
          project: { id: scope.projectId, organizationId: scope.organizationId },
        },
      },
      select: { id: true },
    });
    if (!binding) throw new Error("agent binding unavailable");
  }

  private async createConnectionThread(input: {
    scope: ChannelOwnerScope;
    connectionId: string;
    channelThreadKey: string;
    agentId: string;
    endUserId: string | null;
    authorEndUserId: string;
    provider: string;
    singleEndUser: boolean;
  }): Promise<{ agentId: string; threadId: string; endUserId: string }> {
    try {
      const created = await this.prisma.channelThread.create({
        data: {
          connectionId: input.connectionId,
          channelThreadKey: input.channelThreadKey,
          thread: {
            create: {
              environmentId: input.scope.environmentId,
              agentId: input.agentId,
              ...(input.endUserId
                ? { endUserId: input.endUserId }
                : {
                    endUser: {
                      create: { organizationId: input.scope.organizationId },
                    },
                  }),
              sessionContext: this.threadContext(input),
            },
          },
        },
        include: { thread: true },
      });
      return {
        agentId: created.thread.agentId,
        threadId: created.threadId,
        endUserId: created.thread.endUserId,
      };
    } catch {
      const raced = await this.prisma.channelThread.findUnique({
        where: {
          connectionId_channelThreadKey: {
            connectionId: input.connectionId,
            channelThreadKey: input.channelThreadKey,
          },
        },
        include: { thread: true },
      });
      if (!raced) throw new Error("channel thread creation failed");
      return {
        agentId: raced.thread.agentId,
        threadId: raced.threadId,
        endUserId: raced.thread.endUserId,
      };
    }
  }

  private async createAppThread(input: {
    scope: ChannelOwnerScope;
    installationId: string;
    channelThreadKey: string;
    agentId: string;
    endUserId: string | null;
    authorEndUserId: string;
    provider: string;
    singleEndUser: boolean;
  }): Promise<{ agentId: string; threadId: string; endUserId: string }> {
    try {
      const created = await this.prisma.channelAppThread.create({
        data: {
          installationId: input.installationId,
          channelThreadKey: input.channelThreadKey,
          thread: {
            create: {
              environmentId: input.scope.environmentId,
              agentId: input.agentId,
              ...(input.endUserId
                ? { endUserId: input.endUserId }
                : {
                    endUser: {
                      create: { organizationId: input.scope.organizationId },
                    },
                  }),
              sessionContext: this.threadContext(input),
            },
          },
        },
        include: { thread: true },
      });
      return {
        agentId: created.thread.agentId,
        threadId: created.threadId,
        endUserId: created.thread.endUserId,
      };
    } catch {
      const raced = await this.prisma.channelAppThread.findUnique({
        where: {
          installationId_channelThreadKey: {
            installationId: input.installationId,
            channelThreadKey: input.channelThreadKey,
          },
        },
        include: { thread: true },
      });
      if (!raced) throw new Error("channel app thread creation failed");
      return {
        agentId: raced.thread.agentId,
        threadId: raced.threadId,
        endUserId: raced.thread.endUserId,
      };
    }
  }

  private threadContext(input: {
    provider: string;
    channelThreadKey: string;
    authorEndUserId: string;
    singleEndUser: boolean;
    connectionId?: string;
    installationId?: string;
  }): Record<string, unknown> {
    return {
      channel: {
        provider: input.provider,
        channelThreadKey: input.channelThreadKey,
        connectionId: input.connectionId ?? null,
        installationId: input.installationId ?? null,
      },
      authorEndUserId: input.authorEndUserId,
      singleEndUser: input.singleEndUser,
    };
  }

  private payloadOf(
    credential: any,
    expectedKind: string,
    expectedEnvironmentId: string
  ): ChannelCredentialPayload {
    if (!credential || credential.revokedAt || !credential.encryptedReference) return {};
    if (!expectedEnvironmentId || String(credential.environmentId) !== expectedEnvironmentId) {
      throw new Error("channel credential scope mismatch");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(credential.encryptedReference));
    } catch {
      throw new Error("channel credential unavailable");
    }
    const decrypted = this.messageCrypto.decryptJsonField(parsed);
    if (!decrypted || typeof decrypted !== "object" || Array.isArray(decrypted)) {
      throw new Error("channel credential unavailable");
    }
    const payload = decrypted as ChannelCredentialPayload;
    if (payload.__platos_enc !== undefined) throw new Error("channel credential unavailable");
    if (payload.kind && payload.kind !== expectedKind) {
      throw new Error("channel credential kind mismatch");
    }
    return payload;
  }

  private encryptPayload(payload: ChannelCredentialPayload): string {
    return JSON.stringify(this.messageCrypto.encryptJsonField(payload));
  }

  private credentialRevision(credential: any): string {
    if (!credential?.id) return "none";
    const updatedAt = credential.updatedAt ? new Date(credential.updatedAt).getTime() : 0;
    return `${credential.id}:${updatedAt}`;
  }
}
