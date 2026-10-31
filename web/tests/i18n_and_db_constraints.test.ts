import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SelfDealingProhibitedError } from "@/domain/errors";
import { createTranslator, resolveLocale } from "@/i18n";
import { messages } from "@/i18n/messages";
import { DRAND_QUICKNET_CONFIG, deriveTargetDrandRound } from "@/lib/fair_draw";
import { createPrismaClient } from "@/lib/prisma";

describe("i18n catalog & localized domain errors", () => {
  it("maintains strict 1-to-1 key parity between ja and en catalogs and interpolates parameters", () => {
    expect(Object.keys(messages.ja).sort()).toEqual(
      Object.keys(messages.en).sort(),
    );

    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale(undefined)).toBe("ja");

    const ja = createTranslator("ja");
    const en = createTranslator("en");

    expect(ja.t("ledger.negative_carry_over_notice", { deficitJpy: 1500 })).toContain(
      "1500円",
    );
    expect(en.t("ledger.negative_carry_over_notice", { deficitJpy: 1500 })).toContain(
      "1500 JPY",
    );
    expect(
      ja.t("ledger.zero_keys_allocation_notice", {
        allocatedJpy: 386,
        priceJpy: 1200,
      }),
    ).toContain("386円");

    const err = new SelfDealingProhibitedError(42);
    expect(err.toLocalizedMessage("ja")).toContain("gameId=42");
    expect(err.toLocalizedMessage("en")).toContain("gameId=42");
  });
});

describe("MySQL 8.0 single-row CHECK constraints & unique constraints", () => {
  const prisma = createPrismaClient();
  let mysqlAvailable = false;
  const createdSettlementIds: number[] = [];
  const createdUserIds: string[] = [];
  const createdGameIds: number[] = [];

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      mysqlAvailable = true;
    } catch (err: unknown) {
      if (process.env["CI"] === "true") {
        throw err;
      }
      mysqlAvailable = false;
    }
  });

  afterEach(async () => {
    if (!mysqlAvailable) return;
    if (createdSettlementIds.length > 0) {
      await prisma.monthlyLotteryEntry.deleteMany({
        where: { settlementId: { in: createdSettlementIds } },
      });
      await prisma.settlementGameAllocation.deleteMany({
        where: { settlementId: { in: createdSettlementIds } },
      });
      await prisma.monthlySettlement.deleteMany({
        where: { id: { in: createdSettlementIds } },
      });
      createdSettlementIds.length = 0;
    }
    if (createdUserIds.length > 0) {
      await prisma.viewerUser.deleteMany({
        where: { id: { in: createdUserIds } },
      });
      createdUserIds.length = 0;
    }
    if (createdGameIds.length > 0) {
      await prisma.indieGame.deleteMany({
        where: { id: { in: createdGameIds } },
      });
      createdGameIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("enforces chk_zero_owner_profit (ownerProfitJpy = 0) at the MySQL engine level", async (ctx) => {
    if (!mysqlAvailable) {
      ctx.skip();
      return;
    }

    const cutoff = new Date("2099-12-31T14:59:59.000Z");
    const round = deriveTargetDrandRound(cutoff, DRAND_QUICKNET_CONFIG);

    const validRow = await prisma.monthlySettlement.create({
      data: {
        yearMonth: "2099-09",
        entryCutoffAt: cutoff,
        drandChainHash: DRAND_QUICKNET_CONFIG.chainHash,
        committedDrandRound: round,
        ownerProfitJpy: 0,
      },
    });
    createdSettlementIds.push(validRow.id);

    await expect(
      prisma.monthlySettlement.create({
        data: {
          yearMonth: "2099-12",
          entryCutoffAt: cutoff,
          drandChainHash: DRAND_QUICKNET_CONFIG.chainHash,
          committedDrandRound: round,
          ownerProfitJpy: 1,
        },
      }),
    ).rejects.toThrow(/chk_zero_owner_profit/i);

    await expect(
      prisma.monthlySettlement.create({
        data: {
          yearMonth: "2099-11",
          entryCutoffAt: cutoff,
          drandChainHash: DRAND_QUICKNET_CONFIG.chainHash,
          committedDrandRound: round,
          ownerProfitJpy: -1,
        },
      }),
    ).rejects.toThrow(/chk_zero_owner_profit/i);
  });

  it("enforces chk_labor_cost_bounds (0 <= paidLaborCostJpy <= totalLaborCostJpy) at the MySQL engine level", async (ctx) => {
    if (!mysqlAvailable) {
      ctx.skip();
      return;
    }

    const cutoff = new Date("2099-08-31T14:59:59.000Z");
    const round = deriveTargetDrandRound(cutoff, DRAND_QUICKNET_CONFIG);

    const validRow = await prisma.monthlySettlement.create({
      data: {
        yearMonth: "2099-08",
        entryCutoffAt: cutoff,
        drandChainHash: DRAND_QUICKNET_CONFIG.chainHash,
        committedDrandRound: round,
        totalLaborCostJpy: 1760,
        paidLaborCostJpy: 1000,
        ownerProfitJpy: 0,
      },
    });
    createdSettlementIds.push(validRow.id);

    // paidLaborCostJpy > totalLaborCostJpy -> violates chk_labor_cost_bounds
    await expect(
      prisma.monthlySettlement.create({
        data: {
          yearMonth: "2099-07",
          entryCutoffAt: cutoff,
          drandChainHash: DRAND_QUICKNET_CONFIG.chainHash,
          committedDrandRound: round,
          totalLaborCostJpy: 1760,
          paidLaborCostJpy: 1761,
          ownerProfitJpy: 0,
        },
      }),
    ).rejects.toThrow(/chk_labor_cost_bounds/i);

    // negative paidLaborCostJpy -> violates chk_labor_cost_bounds
    await expect(
      prisma.monthlySettlement.create({
        data: {
          yearMonth: "2099-06",
          entryCutoffAt: cutoff,
          drandChainHash: DRAND_QUICKNET_CONFIG.chainHash,
          committedDrandRound: round,
          totalLaborCostJpy: 1760,
          paidLaborCostJpy: -1,
          ownerProfitJpy: 0,
        },
      }),
    ).rejects.toThrow(/chk_labor_cost_bounds/i);
  });

  it("enforces chk_allocation_row_bounds (spentJpy + remainderJpy = allocatedBudgetJpy & non-negative bounds) and unique constraints", async (ctx) => {
    if (!mysqlAvailable) {
      ctx.skip();
      return;
    }

    const game = await prisma.indieGame.create({
      data: {
        title: "Allocation Constraint Test Game",
        steamAppId: `test_alloc_${Date.now()}`,
        storeUrl: "https://store.steampowered.com/app/2/",
        retailPriceJpy: 600,
        developerName: "Solo Indie Dev",
        isOperatorAffiliated: false,
        isApproved: true,
      },
    });
    createdGameIds.push(game.id);

    const cutoff = new Date("2099-10-31T14:59:59.000Z");
    const settlement = await prisma.monthlySettlement.create({
      data: {
        yearMonth: "2099-10",
        entryCutoffAt: cutoff,
        drandChainHash: DRAND_QUICKNET_CONFIG.chainHash,
        committedDrandRound: deriveTargetDrandRound(
          cutoff,
          DRAND_QUICKNET_CONFIG,
        ),
        ownerProfitJpy: 0,
      },
    });
    createdSettlementIds.push(settlement.id);

    // spentJpy + remainderJpy != allocatedBudgetJpy -> violates chk_allocation_row_bounds
    await expect(
      prisma.settlementGameAllocation.create({
        data: {
          settlementId: settlement.id,
          gameId: game.id,
          publicViewCount: 1000n,
          allocatedBudgetJpy: 1500,
          unitRetailPriceJpy: 600,
          keysPurchased: 2,
          spentJpy: 1200,
          remainderJpy: 299, // 1200 + 299 = 1499 != 1500!
        },
      }),
    ).rejects.toThrow(/chk_allocation_row_bounds/i);

    // unitRetailPriceJpy = 0 -> violates chk_allocation_row_bounds
    await expect(
      prisma.settlementGameAllocation.create({
        data: {
          settlementId: settlement.id,
          gameId: game.id,
          publicViewCount: 1000n,
          allocatedBudgetJpy: 0,
          unitRetailPriceJpy: 0,
          keysPurchased: 0,
          spentJpy: 0,
          remainderJpy: 0,
        },
      }),
    ).rejects.toThrow(/chk_allocation_row_bounds/i);

    // Valid allocation row succeeds, then duplicate (settlementId, gameId) fails
    await prisma.settlementGameAllocation.create({
      data: {
        settlementId: settlement.id,
        gameId: game.id,
        publicViewCount: 1000n,
        allocatedBudgetJpy: 1500,
        unitRetailPriceJpy: 600,
        keysPurchased: 2,
        spentJpy: 1200,
        remainderJpy: 300,
      },
    });

    await expect(
      prisma.settlementGameAllocation.create({
        data: {
          settlementId: settlement.id,
          gameId: game.id,
          publicViewCount: 1000n,
          allocatedBudgetJpy: 1500,
          unitRetailPriceJpy: 600,
          keysPurchased: 2,
          spentJpy: 1200,
          remainderJpy: 300,
        },
      }),
    ).rejects.toThrow();

    // Unique 1-entry-per-user per settlement
    const user = await prisma.viewerUser.create({
      data: {
        authProvider: "google",
        authProviderId: `test_hash_${Date.now()}`,
      },
    });
    createdUserIds.push(user.id);

    await prisma.monthlyLotteryEntry.create({
      data: {
        settlementId: settlement.id,
        userId: user.id,
      },
    });

    await expect(
      prisma.monthlyLotteryEntry.create({
        data: {
          settlementId: settlement.id,
          userId: user.id,
        },
      }),
    ).rejects.toThrow();
  });
});
