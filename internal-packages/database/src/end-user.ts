import {
  Prisma as EndUserPrisma,
  PrismaClient as GeneratedEndUserClient,
} from "../generated/end-user";

export const endUserDelegateNames = [
  "endUser",
  "endUserIdentity",
  "endUserSession",
  "thread",
  "turn",
  "step",
  "toolCall",
  "artifact",
  "messageAttachment",
  "agentApproval",
  "memory",
  "memoryEntity",
  "memoryRelationship",
  "messageRating",
] as const;

type EndUserDelegateName = (typeof endUserDelegateNames)[number];

export type EndUserClient = Readonly<
  Pick<GeneratedEndUserClient, EndUserDelegateName> & {
    disconnect: () => Promise<void>;
  }
>;

/**
 * Creates the only client surface that data-plane request handlers should use.
 *
 * The generated schema contains only subject-reachable data and relations. This
 * frozen facade additionally omits raw SQL, transactions, extension hooks, and
 * every operator/configuration delegate.
 */
export function createEndUserClient(
  options?: EndUserPrisma.Subset<
    EndUserPrisma.PrismaClientOptions,
    EndUserPrisma.PrismaClientOptions
  >
): EndUserClient {
  const client = new GeneratedEndUserClient(options);
  const delegates = Object.fromEntries(
    endUserDelegateNames.map((name) => [name, client[name]])
  ) as Pick<GeneratedEndUserClient, EndUserDelegateName>;

  return Object.freeze({
    ...delegates,
    disconnect: () => client.$disconnect(),
  });
}
