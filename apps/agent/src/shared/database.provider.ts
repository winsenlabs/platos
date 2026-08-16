import { Global, Module, type Provider } from "@nestjs/common";
import { PrismaClient } from "@platos/tenancy-database";
import { env } from "./env";

export const PRISMA_TOKEN = "PRISMA";
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

/**
 * Database provider — creates a Prisma client connected to the shared PostgreSQL.
 *
 * The generated control-plane client is the sole runtime persistence boundary.
 */
const prismaProvider: Provider<PrismaClient> = {
  provide: PRISMA_TOKEN,
  useFactory: async (): Promise<PrismaClient> => {
    const prisma = new PrismaClient({
      datasourceUrl: env.DATABASE_URL,
    });
    await prisma.$connect();
    console.log("[Platos] Database connected");
    return prisma;
  },
};

@Global()
@Module({
  providers: [prismaProvider],
  exports: [PRISMA_TOKEN],
})
export class DatabaseModule {}
