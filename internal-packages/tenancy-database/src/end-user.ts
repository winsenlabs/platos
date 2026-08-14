import {
  Prisma as EndUserPrisma,
  PrismaClient as GeneratedEndUserClient,
} from "../generated/end-user";

export type EndUserClient = Readonly<{
  endUser: GeneratedEndUserClient["endUser"];
  endUserIdentity: GeneratedEndUserClient["endUserIdentity"];
  endUserSession: GeneratedEndUserClient["endUserSession"];
  disconnect: () => Promise<void>;
}>;

/**
 * Creates the only client surface that data-plane request handlers should use.
 *
 * The generated schema contains no operator models or relations, and this
 * facade intentionally omits raw SQL and transaction escape hatches.
 */
export function createEndUserClient(
  options?: EndUserPrisma.Subset<
    EndUserPrisma.PrismaClientOptions,
    EndUserPrisma.PrismaClientOptions
  >
): EndUserClient {
  const client = new GeneratedEndUserClient(options);

  return Object.freeze({
    endUser: client.endUser,
    endUserIdentity: client.endUserIdentity,
    endUserSession: client.endUserSession,
    disconnect: () => client.$disconnect(),
  });
}
