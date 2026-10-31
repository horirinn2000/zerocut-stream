import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  zerocutPrisma?: PrismaClient;
};

export function createPrismaClient(datasourceUrl?: string): PrismaClient {
  if (datasourceUrl) {
    return new PrismaClient({
      datasourceUrl,
    });
  }
  return new PrismaClient();
}

export function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.zerocutPrisma) {
    globalForPrisma.zerocutPrisma = createPrismaClient();
  }
  return globalForPrisma.zerocutPrisma;
}
