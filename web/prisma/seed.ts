import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient, PurchaseChannel } from "@prisma/client";
import { executeTransactionalVideoCostImport } from "../src/cli/import_video_cost";
import { PUBLIC_CONSTANTS } from "../src/domain/constants";
import {
  type GameViewAllocationInput,
  type TargetGameSnapshot,
  calculateMonthlySettlement,
  validateTargetGameEligible,
  verifySettlementInvariants,
} from "../src/domain/settlement";
import { createTranslator, resolveLocale } from "../src/i18n";
import {
  DRAND_QUICKNET_CONFIG,
  deriveTargetDrandRound,
  executeFairDraw,
} from "../src/lib/fair_draw";
import { type Logger, createStructuredLogger } from "../src/lib/logger";
import { createPrismaClient } from "../src/lib/prisma";
import {
  type SteamKeyCipher,
  createSteamKeyCipherFromEnv,
} from "../src/lib/steam_key_cipher";

export interface SeedDependencies {
  readonly prisma: PrismaClient;
  readonly cipher: SteamKeyCipher;
  readonly logger: Logger;
  readonly identityPepper: string;
  readonly localeRaw?: string | undefined;
}

function hashViewerIdentity(
  pepper: string,
  provider: string,
  accountId: string,
): string {
  return createHmac("sha256", pepper)
    .update(`${provider}:${accountId}`, "utf8")
    .digest("hex");
}

export async function runSeed(deps: SeedDependencies): Promise<void> {
  const { prisma, cipher, logger, identityPepper } = deps;
  const translator = createTranslator(resolveLocale(deps.localeRaw));

  // Idempotent cleanup in child-to-parent dependency order for dev seed repeatability
  await prisma.monthlyLotteryEntry.deleteMany();
  await prisma.steamKeyInventory.deleteMany();
  await prisma.settlementGameAllocation.deleteMany();
  await prisma.monthlySettlement.deleteMany();
  await prisma.videoCostLedger.deleteMany();
  await prisma.viewerUser.deleteMany();
  await prisma.indieGame.deleteMany();

  // 1. Register 3 approved independent third-party IndieGame titles
  const game1 = await prisma.indieGame.create({
    data: {
      title: "Abyssal Climb: Zero Grip",
      steamAppId: "2987650",
      storeUrl: "https://store.steampowered.com/app/2987650/",
      retailPriceJpy: 800,
      developerName: "Studio Kagerou Indie Works",
      developerContact: "contact@kagerou-indie.example",
      isOperatorAffiliated: false,
      isApproved: true,
    },
  });

  const game2 = await prisma.indieGame.create({
    data: {
      title: "Clockwork Lanterns",
      steamAppId: "3014200",
      storeUrl: "https://store.steampowered.com/app/3014200/",
      retailPriceJpy: 600,
      developerName: "Atelier Yomogi",
      developerContact: "hello@atelier-yomogi.example",
      isOperatorAffiliated: false,
      isApproved: true,
    },
  });

  const game3 = await prisma.indieGame.create({
    data: {
      title: "Starlight Tea House",
      steamAppId: "3108800",
      storeUrl: "https://store.steampowered.com/app/3108800/",
      retailPriceJpy: 1200,
      developerName: "Polaris Pixel Craft",
      developerContact: "support@polaris-pixel.example",
      isOperatorAffiliated: false,
      isApproved: true,
    },
  });

  const targetGames: readonly TargetGameSnapshot[] = [game1, game2, game3].map(
    (g) => {
      const snap: TargetGameSnapshot = {
        id: g.id,
        retailPriceJpy: g.retailPriceJpy,
        isOperatorAffiliated: g.isOperatorAffiliated,
        isApproved: g.isApproved,
      };
      validateTargetGameEligible(snap);
      return snap;
    },
  );

  // 2. Import 4 October videos through the intake domain (exercising engine JSON,
  //    2nd-episode auto-0-minute normalization, recording game receipt, & human-stream mode)
  const importedV1 = await executeTransactionalVideoCostImport({
    prisma,
    logger,
    localeRaw: deps.localeRaw,
    request: {
      mode: "engine_file",
      rawReport: {
        schemaVersion: "1.0",
        steamAppId: game1.steamAppId,
        videoTitle:
          "【原価公開】800円の激ムズ登山アクションで42分の苦労が1秒で溶けるAI実況 #1",
        generatedAt: "2026-10-05T09:30:00.000Z",
        isSyntheticContent: true,
        aiGeneration: {
          llmModelName: "claude-sonnet-4-20250514",
          inputTokens: 48200,
          outputTokens: 15100,
          inputRateUsdPer1M: "3.0000",
          outputRateUsdPer1M: "15.0000",
          usdJpyRate: "152.5000",
          llmCostJpy: "56.59",
          ttsCostJpy: "0.00",
          computeCostJpy: "5.81",
          totalGenerationCostJpy: "62.40",
        },
        recordingAcquisition: {
          recordingGameCostJpy: 0,
          recordingGameReceiptUrl: null,
        },
        footage: {
          footageSource: "HUMAN_PLAY",
          rawFootageSha256: "1".repeat(64),
          rawFootageSec: 3720,
          playRegionCode: "JP",
        },
      },
      postUpload: {
        youtubeVideoId: "zc_oct_vid_001",
        publishedAt: new Date("2026-10-05T10:00:00.000Z"),
        reviewRegionCode: "JP",
        contentIdStatus: "CLEAR",
        aiDisclosureAck: true,
      },
    },
  });

  // 2nd video of game1 in 2026-10 (new raw footage hash -> automatically normalized to playMinutes = 0)
  const importedV2 = await executeTransactionalVideoCostImport({
    prisma,
    logger,
    localeRaw: deps.localeRaw,
    request: {
      mode: "engine_file",
      rawReport: {
        schemaVersion: "1.0",
        steamAppId: game1.steamAppId,
        videoTitle:
          "【原価公開】物理演算の罠に絶叫するボケAIと冷徹に高度計算する毒舌AI #2",
        generatedAt: "2026-10-12T09:30:00.000Z",
        isSyntheticContent: true,
        aiGeneration: {
          llmModelName: "claude-sonnet-4-20250514",
          inputTokens: 56000,
          outputTokens: 17400,
          inputRateUsdPer1M: "3.0000",
          outputRateUsdPer1M: "15.0000",
          usdJpyRate: "152.5000",
          llmCostJpy: "65.42",
          ttsCostJpy: "0.00",
          computeCostJpy: "6.43",
          totalGenerationCostJpy: "71.85",
        },
        recordingAcquisition: {
          recordingGameCostJpy: 0,
          recordingGameReceiptUrl: null,
        },
        footage: {
          footageSource: "HUMAN_PLAY",
          rawFootageSha256: "2".repeat(64),
          rawFootageSec: 3400,
          playRegionCode: "JP",
        },
      },
      postUpload: {
        youtubeVideoId: "zc_oct_vid_002",
        publishedAt: new Date("2026-10-12T10:00:00.000Z"),
        reviewRegionCode: "JP",
        contentIdStatus: "CLEAR",
        aiDisclosureAck: true,
      },
    },
  });

  // Video 3: game2 (with recording game purchase receipt)
  const importedV3 = await executeTransactionalVideoCostImport({
    prisma,
    logger,
    localeRaw: deps.localeRaw,
    request: {
      mode: "engine_file",
      rawReport: {
        schemaVersion: "1.0",
        steamAppId: game2.steamAppId,
        videoTitle: "【原価公開】からくりランタンの迷宮を初見攻略するAI掛け合い実況",
        generatedAt: "2026-10-18T09:30:00.000Z",
        isSyntheticContent: true,
        aiGeneration: {
          llmModelName: "claude-sonnet-4-20250514",
          inputTokens: 40000,
          outputTokens: 12000,
          inputRateUsdPer1M: "3.0000",
          outputRateUsdPer1M: "15.0000",
          usdJpyRate: "152.5000",
          llmCostJpy: "45.75",
          ttsCostJpy: "0.00",
          computeCostJpy: "4.25",
          totalGenerationCostJpy: "50.00",
        },
        recordingAcquisition: {
          recordingGameCostJpy: 600,
          recordingGameReceiptUrl:
            "https://example.org/evidence/2026-10-rec-3014200.png",
        },
        footage: {
          footageSource: "HUMAN_PLAY",
          rawFootageSha256: "3".repeat(64),
          rawFootageSec: 3600,
          playRegionCode: "JP",
        },
      },
      postUpload: {
        youtubeVideoId: "zc_oct_vid_003",
        publishedAt: new Date("2026-10-18T10:00:00.000Z"),
        reviewRegionCode: "JP",
        contentIdStatus: "CLEAR",
        aiDisclosureAck: true,
      },
    },
  });

  // Video 4: game3 (human streamer mode — no AI engine, sub-retail view share -> 0 keys this month)
  const importedV4 = await executeTransactionalVideoCostImport({
    prisma,
    logger,
    localeRaw: deps.localeRaw,
    request: {
      mode: "human_stream",
      steamAppId: game3.steamAppId,
      videoTitle: "星明かりの茶房をのんびり初見プレイ実況",
      playRegionCode: "JP",
      rawFootageSha256: "4".repeat(64),
      rawFootageSec: 3900,
      postUpload: {
        youtubeVideoId: "zc_oct_vid_004",
        publishedAt: new Date("2026-10-25T10:00:00.000Z"),
        reviewRegionCode: "JP",
        contentIdStatus: "CLEAR",
        aiDisclosureAck: false,
      },
    },
  });

  // Snapshot month-end public YouTube view counts for 2026-10
  const snapshottedAt = new Date("2026-10-31T15:00:00.000Z");
  const viewSnapshots: ReadonlyArray<{ readonly id: number; readonly views: bigint }> = [
    { id: importedV1.id, views: 5000n },
    { id: importedV2.id, views: 3000n },
    { id: importedV3.id, views: 6000n },
    { id: importedV4.id, views: 1000n },
  ];
  for (const vs of viewSnapshots) {
    await prisma.videoCostLedger.update({
      where: { id: vs.id },
      data: {
        viewCountSnapshot: vs.views,
        viewCountSnapshottedAt: snapshottedAt,
      },
    });
  }

  const octVideos = await prisma.videoCostLedger.findMany({
    orderBy: { id: "asc" },
  });

  // 3. Create 8 verified viewer accounts (strict flat equality: 1 entry per user, no rank columns)
  const viewers = [];
  for (let i = 1; i <= 8; i++) {
    const user = await prisma.viewerUser.create({
      data: {
        authProvider: "google",
        authProviderId: hashViewerIdentity(
          identityPepper,
          "google",
          `seed-viewer-${i}`,
        ),
      },
    });
    viewers.push(user);
  }

  // 4. Settled reference month: 2026-10
  const octCutoff = new Date("2026-10-31T14:59:59.000Z"); // 2026-10-31 23:59:59 JST
  const octCommittedRound = deriveTargetDrandRound(
    octCutoff,
    DRAND_QUICKNET_CONFIG,
  );

  const gameViewInputs: GameViewAllocationInput[] = [
    { game: targetGames[0]!, publicViewCount: 8000n },
    { game: targetGames[1]!, publicViewCount: 6000n },
    { game: targetGames[2]!, publicViewCount: 1000n },
  ];

  const octCalc = calculateMonthlySettlement({
    carryOverFromPrevJpy: 0,
    grossAdRevenueJpy: 13500,
    videoGenerationCostsDecimalJpy: octVideos.map((v) =>
      v.totalGenerationCost.toFixed(2),
    ),
    recordingGameCostsJpy: octVideos.map((v) => v.recordingGameCostJpy),
    webHostingCostJpy: 1200,
    videoPlayLaborCostsDecimalJpy: octVideos.map((v) =>
      v.playLaborCostJpy.toFixed(2),
    ),
    videoReviewLaborCostsDecimalJpy: octVideos.map((v) =>
      v.reviewLaborCostJpy.toFixed(2),
    ),
    gameViewInputs,
    confirmedEntryCount: viewers.length,
  });

  const octSettlement = await prisma.monthlySettlement.create({
    data: {
      yearMonth: "2026-10",
      entryCutoffAt: octCutoff,
      drandChainHash: DRAND_QUICKNET_CONFIG.chainHash,
      committedDrandRound: octCommittedRound,
      carryOverFromPrevJpy: 0,
      grossAdRevenueJpy: 13500,
      webHostingCostJpy: 1200,
      totalInfraCostJpy: octCalc.totalInfraCostJpy,
      totalLaborCostJpy: octCalc.totalLaborCostJpy,
      paidLaborCostJpy: octCalc.paidLaborCostJpy,
      ownerProfitJpy: 0,
      netBuybackPoolJpy: octCalc.netBuybackPoolJpy,
      totalKeysPurchased: 0,
      totalSpentOnKeysJpy: 0,
      carryOverToNextJpy: 0,
      adRevenueEvidenceUrl: "https://example.org/evidence/2026-10-adsense.png",
      isSettled: false,
    },
  });

  const octEntries = [];
  for (const [idx, viewer] of viewers.entries()) {
    const entry = await prisma.monthlyLotteryEntry.create({
      data: {
        settlementId: octSettlement.id,
        userId: viewer.id,
        createdAt: new Date(`2026-10-${15 + idx}T12:00:00.000Z`),
      },
    });
    octEntries.push(entry);
  }

  // Create SettlementGameAllocation rows and encrypted SteamKeyInventory rows
  const createdKeys = [];
  for (const alloc of octCalc.allocations) {
    const allocRow = await prisma.settlementGameAllocation.create({
      data: {
        settlementId: octSettlement.id,
        gameId: alloc.gameId,
        publicViewCount: alloc.publicViewCount,
        allocatedBudgetJpy: alloc.allocatedBudgetJpy,
        unitRetailPriceJpy: alloc.unitRetailPriceJpy,
        keysPurchased: alloc.keysPurchased,
        spentJpy: alloc.spentJpy,
        remainderJpy: alloc.remainderJpy,
        purchaseChannel: PurchaseChannel.DIRECT_FROM_DEVELOPER,
        purchaseReceiptUrl:
          alloc.keysPurchased > 0
            ? `https://example.org/evidence/2026-10-game-${alloc.gameId}-invoice.png`
            : null,
      },
    });

    for (let k = 1; k <= alloc.keysPurchased; k++) {
      const plainKey = `ZCUT1-G${alloc.gameId}-${String(k).padStart(5, "0")}`;
      const keyRow = await prisma.steamKeyInventory.create({
        data: {
          settlementId: octSettlement.id,
          allocationId: allocRow.id,
          gameId: alloc.gameId,
          encryptedSteamKey: cipher.encrypt(plainKey),
          purchasePriceJpy: alloc.unitRetailPriceJpy,
          isDistributed: false,
        },
      });
      createdKeys.push(keyRow);
    }
  }

  // Sort keys deterministically by (gameId ASC, key.id ASC) and assign to ranked draw winners
  const sortedKeysForWinners = [...createdKeys].sort((a, b) =>
    a.gameId !== b.gameId ? a.gameId - b.gameId : a.id - b.id,
  );

  const samplePublicRandomSeed =
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const drawResult = executeFairDraw({
    publicRandomSeed: samplePublicRandomSeed,
    entryIds: octEntries.map((e) => e.id),
    maxAffordableKeys: octCalc.totalMaxAffordableKeys,
  });

  for (const [winnerIdx, winnerEntryId] of drawResult.winnerEntryIds.entries()) {
    const targetKey = sortedKeysForWinners[winnerIdx];
    if (!targetKey) {
      throw new Error("Missing seeded Steam key for ranked winner assignment");
    }
    await prisma.steamKeyInventory.update({
      where: { id: targetKey.id },
      data: { isDistributed: true },
    });
    await prisma.monthlyLotteryEntry.update({
      where: { id: winnerEntryId },
      data: {
        isWinner: true,
        wonSteamKeyId: targetKey.id,
      },
    });
  }

  const finalizedOct = await prisma.monthlySettlement.update({
    where: { id: octSettlement.id },
    data: {
      totalKeysPurchased: octCalc.totalKeysPurchased,
      totalSpentOnKeysJpy: octCalc.totalSpentOnKeysJpy,
      carryOverToNextJpy: octCalc.carryOverToNextJpy,
      entriesSnapshotHash: drawResult.entriesSnapshotHash,
      publicRandomSeed: samplePublicRandomSeed,
      drandSignature: "seed-sample-bls-signature-placeholder",
      isSettled: true,
      settledAt: new Date("2026-10-31T15:05:00.000Z"),
    },
    include: {
      allocations: true,
      entries: true,
      steamKeys: true,
    },
  });

  // 5. Verify all 5 cross-record invariants on the settled DB records
  verifySettlementInvariants({
    settlement: finalizedOct,
    previousSettlement: null,
    games: targetGames,
    allocations: finalizedOct.allocations,
    monthVideos: octVideos.map((v) => ({
      id: v.id,
      youtubeVideoId: v.youtubeVideoId,
      gameId: v.gameId,
      isSyntheticContent: v.isSyntheticContent,
      llmModelName: v.llmModelName,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      inputRateUsdPer1M: v.inputRateUsdPer1M.toFixed(4),
      outputRateUsdPer1M: v.outputRateUsdPer1M.toFixed(4),
      usdJpyRate: v.usdJpyRate.toFixed(4),
      llmCostDecimalJpy: v.llmCostJpy.toFixed(2),
      ttsCostDecimalJpy: v.ttsCostJpy.toFixed(2),
      computeCostDecimalJpy: v.computeCostJpy.toFixed(2),
      totalGenerationCostDecimalJpy: v.totalGenerationCost.toFixed(2),
      recordingGameCostJpy: v.recordingGameCostJpy,
      recordingGameReceiptUrl: v.recordingGameReceiptUrl,
      footageSource: v.footageSource,
      rawFootageSha256: v.rawFootageSha256,
      playRegionCode: v.playRegionCode,
      playMinutes: v.playMinutes,
      playLaborRateJpyPerHour: v.playLaborRateJpyPerHour,
      playLaborCostDecimalJpy: v.playLaborCostJpy.toFixed(2),
      reviewRegionCode: v.reviewRegionCode,
      reviewMinutes: v.reviewMinutes,
      reviewLaborRateJpyPerHour: v.reviewLaborRateJpyPerHour,
      reviewLaborCostDecimalJpy: v.reviewLaborCostJpy.toFixed(2),
      aiDisclosureSet: v.aiDisclosureSet,
      contentIdStatus: v.contentIdStatus,
      viewCountSnapshot: v.viewCountSnapshot,
      publishedAt: v.publishedAt,
    })),
    steamKeys: finalizedOct.steamKeys,
    entries: finalizedOct.entries,
    drandConfig: DRAND_QUICKNET_CONFIG,
    publicConstants: PUBLIC_CONSTANTS,
  });

  // 6. Active open month: 2026-11 (carrying over exact 1,596 JPY combined remainder from 2026-10)
  const novCutoff = new Date("2026-11-30T14:59:59.000Z"); // 2026-11-30 23:59:59 JST
  const novCommittedRound = deriveTargetDrandRound(
    novCutoff,
    DRAND_QUICKNET_CONFIG,
  );

  await prisma.monthlySettlement.create({
    data: {
      yearMonth: "2026-11",
      entryCutoffAt: novCutoff,
      drandChainHash: DRAND_QUICKNET_CONFIG.chainHash,
      committedDrandRound: novCommittedRound,
      carryOverFromPrevJpy: finalizedOct.carryOverToNextJpy,
      ownerProfitJpy: 0,
      netBuybackPoolJpy: finalizedOct.carryOverToNextJpy,
      isSettled: false,
    },
  });

  logger.info(translator.t("seed.completed", { yearMonth: "2026-10, 2026-11" }), {
    settledMonth: "2026-10",
    openMonth: "2026-11",
    octTotalInfraCostJpy: finalizedOct.totalInfraCostJpy,
    octTotalLaborCostJpy: finalizedOct.totalLaborCostJpy,
    octPaidLaborCostJpy: finalizedOct.paidLaborCostJpy,
    octNetBuybackPoolJpy: finalizedOct.netBuybackPoolJpy,
    octTotalKeysPurchased: finalizedOct.totalKeysPurchased,
    carryOverToNovJpy: finalizedOct.carryOverToNextJpy,
    novCommittedDrandRound: novCommittedRound.toString(),
  });
}

async function main(): Promise<void> {
  const logger = createStructuredLogger({ service: "zerocut-seed" });
  const prisma = createPrismaClient();
  const cipher = createSteamKeyCipherFromEnv(process.env);
  const identityPepper = process.env["AUTH_IDENTITY_PEPPER"] ?? "";
  if (!identityPepper) {
    throw new Error("AUTH_IDENTITY_PEPPER must be set to run seed");
  }

  try {
    await runSeed({
      prisma,
      cipher,
      logger,
      identityPepper,
      localeRaw: process.env["APP_LOCALE"],
    });
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err: unknown) => {
    const logger = createStructuredLogger({ service: "zerocut-seed" });
    logger.error("Seed execution failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
