import { Global, Module, type Provider } from "@nestjs/common";
import { env } from "./env";

export const PRISMA_TOKEN = "PRISMA";

/**
 * Database provider — creates a Prisma client connected to the shared PostgreSQL.
 *
 * Dynamic import: at runtime, @platos/database exports PrismaClient from
 * the generated Prisma client. During dev typecheck, the generated client may
 * not exist yet — that's fine, this only runs at runtime.
 */
const prismaProvider: Provider = {
  provide: PRISMA_TOKEN,
  useFactory: async () => {
    // Try multiple Prisma client locations (monorepo dev vs Docker standalone)
    let PrismaClient: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      PrismaClient = require("@platos/database").PrismaClient;
    } catch {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        PrismaClient = require("@prisma/client").PrismaClient;
      } catch {
        throw new Error("Could not find Prisma client. Run 'prisma generate' first.");
      }
    }
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
