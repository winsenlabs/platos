import { Global, Module, type Provider } from "@nestjs/common";
import {
  CredentialRootKeyRing,
  PlatosSecretStore,
  PrismaClient,
} from "@platos/tenancy-database";
import { env } from "./env";

export const PRISMA_TOKEN = "PRISMA";
export const PLATOS_SECRET_STORE_TOKEN = "PLATOS_SECRET_STORE";
export type ControlDatabaseClient = PrismaClient;

export interface CanonicalEnvironmentScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

/** Scope an Environment-owned model through its persisted canonical ancestry. */
export function environmentScopeWhere(scope: CanonicalEnvironmentScope) {
  return {
    environmentId: scope.environmentId,
    environment: {
      projectId: scope.projectId,
      project: { organizationId: scope.organizationId },
    },
  } as const;
}

/** The generated control client is the sole runtime persistence boundary. */
const prismaProvider: Provider<PrismaClient> = {
  provide: PRISMA_TOKEN,
  useFactory: async (): Promise<PrismaClient> => {
    const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    await prisma.$connect();
    console.log("[Platos] Database connected");
    return prisma;
  },
};

const platosSecretStoreProvider: Provider<PlatosSecretStore> = {
  provide: PLATOS_SECRET_STORE_TOKEN,
  inject: [PRISMA_TOKEN],
  useFactory: (prisma: PrismaClient) =>
    new PlatosSecretStore(
      prisma,
      new CredentialRootKeyRing({
        activeVersion: env.PLATOS_CREDENTIAL_ROOT_KEY_VERSION,
        keys: env.PLATOS_CREDENTIAL_ROOT_KEYS,
      }),
    ),
};

@Global()
@Module({
  providers: [prismaProvider, platosSecretStoreProvider],
  exports: [PRISMA_TOKEN, PLATOS_SECRET_STORE_TOKEN],
})
export class DatabaseModule {}
