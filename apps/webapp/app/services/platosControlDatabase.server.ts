import { PrismaClient } from "@platos/tenancy-database";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

/**
 * Canonical Platos control-plane client. The dashboard's general `prisma`
 * client deliberately remains connected to the legacy resource database.
 */
export const platosControlDatabase = singleton(
  "platos-control-prisma",
  () => new PrismaClient({ datasourceUrl: env.PLATOS_CONTROL_DATABASE_URL })
);
