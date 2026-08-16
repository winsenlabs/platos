import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const connect = vi.fn();
  const controlClient = { $connect: connect };
  const ControlPrismaClient = vi.fn(function (this: unknown) {
    return controlClient;
  });
  const LegacyPrismaClient = vi.fn(function (this: unknown) {
    throw new Error("legacy Prisma client must not be constructed");
  });
  return {
    connect,
    controlClient,
    ControlPrismaClient,
    LegacyPrismaClient,
  };
});

vi.mock("@platos/tenancy-database", () => ({
  PrismaClient: mocks.ControlPrismaClient,
}));

vi.mock("@platos/database", () => ({
  PrismaClient: mocks.LegacyPrismaClient,
}));

import { DatabaseModule, PRISMA_TOKEN } from "./database.provider";

describe("DatabaseModule runtime client boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
  });

  it("boots and connects the @platos/tenancy-database PrismaClient without a legacy fallback", async () => {
    const providers = Reflect.getMetadata("providers", DatabaseModule) as Array<{
      provide?: string;
      useFactory?: () => Promise<unknown>;
    }>;
    const provider = providers.find((candidate) => candidate.provide === PRISMA_TOKEN);

    expect(provider?.useFactory).toBeTypeOf("function");
    await expect(provider!.useFactory!()).resolves.toBe(mocks.controlClient);
    expect(mocks.ControlPrismaClient).toHaveBeenCalledOnce();
    expect(mocks.ControlPrismaClient).toHaveBeenCalledWith({
      datasourceUrl: expect.any(String),
    });
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.LegacyPrismaClient).not.toHaveBeenCalled();
  });
});
