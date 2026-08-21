import { PrismaClient } from "@platos/tenancy-database";
import { env } from "~/env.server";

const globalForDatabase = globalThis as typeof globalThis & { platosDatabase?: PrismaClient };

export const database =
  globalForDatabase.platosDatabase ?? new PrismaClient({ datasourceUrl: env.DATABASE_URL });

if (env.NODE_ENV !== "production") globalForDatabase.platosDatabase = database;
