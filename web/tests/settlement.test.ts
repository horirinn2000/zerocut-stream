import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_CONSTANTS,
  parsePublicConstants,
  resolveActiveRegionalLaborRateJpy,
} from "@/domain/constants";
import {
  DomainValidationError,
  InvariantViolationError,
  SelfDealingProhibitedError,
} from "@/domain/errors";
import {
  type AllocationAuditRecord,
  type SettlementAuditContext,
  type SteamKeyAuditRecord,
  type TargetGameSnapshot,
  type VideoCostAuditRecord,
  allocatePoolByPublicViews,
  calculateMonthlySettlement,
  computeFixedMinutesLaborCostSen,
  computeLlmCostSenFromTokens,
  formatSenToDecimalJpy,
  getYearMonthInJst,
  parseDecimalJpyToSen,
  sumInfraCostFloorJpy,
  sumLaborCostFloorJpy,
  validateTargetGameEligible,
  verifySettlementInvariants,
} from "@/domain/settlement";
import {
  DRAND_QUICKNET_CONFIG,
  deriveTargetDrandRound,
  executeFairDraw,
} from "@/lib/fair_draw";

const SEED_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const GAME_A: TargetGameSnapshot = {
  id: 10,
  retailPriceJpy: 1000,
  isOperatorAffiliated: false,
  isApproved: true,
};

const GAME_B: TargetGameSnapshot = {
  id: 20,
  retailPriceJpy: 500,
  isOperatorAffiliated: false,
  isApproved: true,
};

function buildValidMultiGameAuditContext(): SettlementAuditContext {
  const cutoff = new Date("2026-11-30T14:59:59.000Z"); // 2026-11-30 23:59:59 JST
  const committedRound = deriveTargetDrandRound(cutoff, DRAND_QUICKNET_CONFIG);
  const entryIds = [101, 102, 103, 104, 105];

  // Videos in 2026-11:
  // v1: GAME_A initial AI video (48200 in, 15100 out -> llm 56.59 + comp 3.41 = 60.00), recCost 1000 w/ receipt, play 60m (1320), review 20m (440), views 6000
  // v2: GAME_A 2nd clip (SECONDARY_CLIP, play 0m, review 20m (440), gen 40.99 [llm 0, tts 20.00, comp 20.99]), views 2000 -> GAME_A total views = 8000
  // v3: GAME_B human streamer video (isSyntheticContent=false, llmModelName=null, gen 0.00, play 60m (1320), review 20m (440)), views 2000 -> GAME_B total views = 2000
  // Total cash infra: floor(60.00 + 40.99 + 0.00 + 1000 [rec] + 1000 [hosting]) = floor(2100.99) = 2100 JPY
  // Total accrued labor: play (1320 + 0 + 1320 = 2640) + review (440 * 3 = 1320) = 3960 JPY
  // Carry-over in: 200 JPY, Gross Ad: 9360 JPY
  // Balance after infra: 200 + 9360 - 2100 = 7460 JPY
  // Paid labor: min(3960, 7460) = 3960 JPY -> netBuybackPoolJpy = 7460 - 3960 = 3500 JPY
  // View share 8000 : 2000 (80% : 20% of 3500):
  //   GAME_A (1000 JPY): allocated = 2800 -> 2 keys (spent 2000, rem 800)
  //   GAME_B (500 JPY):  allocated = 700  -> 1 key  (spent 500,  rem 200)
  // Total keys = 3 (entries = 5 >= 3), totalSpent = 2500, carryOverToNext = 1000 JPY
  const monthVideos: VideoCostAuditRecord[] = [
    {
      id: 1,
      youtubeVideoId: "yt_nov_game_a_1",
      gameId: GAME_A.id,
      isSyntheticContent: true,
      llmModelName: "claude-sonnet-4-20250514",
      inputTokens: 48200,
      outputTokens: 15100,
      inputRateUsdPer1M: "3.0000",
      outputRateUsdPer1M: "15.0000",
      usdJpyRate: "152.5000",
      llmCostDecimalJpy: "56.59",
      ttsCostDecimalJpy: "0.00",
      computeCostDecimalJpy: "3.41",
      totalGenerationCostDecimalJpy: "60.00",
      recordingGameCostJpy: 1000,
      recordingGameReceiptUrl: "https://example.org/receipts/game-a.png",
      footageSource: "HUMAN_PLAY",
      rawFootageSha256: "a".repeat(64),
      playRegionCode: "JP",
      playMinutes: 60,
      playLaborRateJpyPerHour: 1320,
      playLaborCostDecimalJpy: "1320.00",
      reviewRegionCode: "JP",
      reviewMinutes: 20,
      reviewLaborRateJpyPerHour: 1320,
      reviewLaborCostDecimalJpy: "440.00",
      aiDisclosureSet: true,
      contentIdStatus: "CLEAR",
      viewCountSnapshot: 6000n,
      publishedAt: new Date("2026-11-02T10:00:00.000Z"),
    },
    {
      id: 2,
      youtubeVideoId: "yt_nov_game_a_2",
      gameId: GAME_A.id,
      isSyntheticContent: true,
      llmModelName: null, // Non-LLM synthetic TTS/edited video
      inputTokens: 0,
      outputTokens: 0,
      inputRateUsdPer1M: "0.0000",
      outputRateUsdPer1M: "0.0000",
      usdJpyRate: "0.0000",
      llmCostDecimalJpy: "0.00",
      ttsCostDecimalJpy: "20.00",
      computeCostDecimalJpy: "20.99",
      totalGenerationCostDecimalJpy: "40.99",
      recordingGameCostJpy: 0,
      recordingGameReceiptUrl: null,
      footageSource: "SECONDARY_CLIP",
      rawFootageSha256: "b".repeat(64),
      playRegionCode: "JP",
      playMinutes: 0,
      playLaborRateJpyPerHour: 0,
      playLaborCostDecimalJpy: "0.00",
      reviewRegionCode: "JP",
      reviewMinutes: 20,
      reviewLaborRateJpyPerHour: 1320,
      reviewLaborCostDecimalJpy: "440.00",
      aiDisclosureSet: true,
      contentIdStatus: "CLAIMED_REVENUE_REDIRECTED",
      viewCountSnapshot: 2000n,
      publishedAt: new Date("2026-11-10T10:00:00.000Z"),
    },
    {
      id: 3,
      youtubeVideoId: "yt_nov_game_b_human",
      gameId: GAME_B.id,
      isSyntheticContent: false,
      llmModelName: null, // Pure human streamer episode
      inputTokens: 0,
      outputTokens: 0,
      inputRateUsdPer1M: "0.0000",
      outputRateUsdPer1M: "0.0000",
      usdJpyRate: "0.0000",
      llmCostDecimalJpy: "0.00",
      ttsCostDecimalJpy: "0.00",
      computeCostDecimalJpy: "0.00",
      totalGenerationCostDecimalJpy: "0.00",
      recordingGameCostJpy: 0,
      recordingGameReceiptUrl: null,
      footageSource: "HUMAN_PLAY",
      rawFootageSha256: "c".repeat(64),
      playRegionCode: "JP",
      playMinutes: 60,
      playLaborRateJpyPerHour: 1320,
      playLaborCostDecimalJpy: "1320.00",
      reviewRegionCode: "JP",
      reviewMinutes: 20,
      reviewLaborRateJpyPerHour: 1320,
      reviewLaborCostDecimalJpy: "440.00",
      aiDisclosureSet: false,
      contentIdStatus: "CLEAR",
      viewCountSnapshot: 2000n,
      publishedAt: new Date("2026-11-20T10:00:00.000Z"),
    },
  ];

  const allocations: AllocationAuditRecord[] = [
    {
      id: 11,
      settlementId: 1,
      gameId: GAME_A.id,
      publicViewCount: 8000n,
      allocatedBudgetJpy: 2800,
      unitRetailPriceJpy: 1000,
      keysPurchased: 2,
      spentJpy: 2000,
      remainderJpy: 800,
    },
    {
      id: 12,
      settlementId: 1,
      gameId: GAME_B.id,
      publicViewCount: 2000n,
      allocatedBudgetJpy: 700,
      unitRetailPriceJpy: 500,
      keysPurchased: 1,
      spentJpy: 500,
      remainderJpy: 200,
    },
  ];

  // Distributed keys ordered by (gameId ASC, key.id ASC): 501 (G10), 502 (G10), 601 (G20)
  const steamKeys: SteamKeyAuditRecord[] = [
    {
      id: 501,
      settlementId: 1,
      allocationId: 11,
      gameId: GAME_A.id,
      purchasePriceJpy: 1000,
      isDistributed: true,
    },
    {
      id: 502,
      settlementId: 1,
      allocationId: 11,
      gameId: GAME_A.id,
      purchasePriceJpy: 1000,
      isDistributed: true,
    },
    {
      id: 503,
      settlementId: 1,
      allocationId: 11,
      gameId: GAME_A.id,
      purchasePriceJpy: 1000,
      isDistributed: false,
    },
    {
      id: 601,
      settlementId: 1,
      allocationId: 12,
      gameId: GAME_B.id,
      purchasePriceJpy: 500,
      isDistributed: true,
    },
  ];

  const draw = executeFairDraw({
    publicRandomSeed: SEED_HEX,
    entryIds,
    maxAffordableKeys: 3,
  });

  const sortedDistKeys = [steamKeys[0]!, steamKeys[1]!, steamKeys[3]!];
  const winnerKeyByEntryId = new Map<number, number>();
  draw.winnerEntryIds.forEach((winnerEntryId, rankIdx) => {
    winnerKeyByEntryId.set(winnerEntryId, sortedDistKeys[rankIdx]!.id);
  });

  const entries = entryIds.map((id) => {
    const assignedKeyId = winnerKeyByEntryId.get(id) ?? null;
    return {
      id,
      settlementId: 1,
      isWinner: assignedKeyId !== null,
      wonSteamKeyId: assignedKeyId,
      createdAt: new Date("2026-11-15T00:00:00.000Z"),
    };
  });

  return {
    settlement: {
      id: 1,
      yearMonth: "2026-11",
      entryCutoffAt: cutoff,
      drandChainHash: DRAND_QUICKNET_CONFIG.chainHash,
      committedDrandRound: committedRound,
      carryOverFromPrevJpy: 200,
      grossAdRevenueJpy: 9360,
      webHostingCostJpy: 1000,
      totalInfraCostJpy: 2100,
      totalLaborCostJpy: 3960,
      paidLaborCostJpy: 3960,
      ownerProfitJpy: 0,
      netBuybackPoolJpy: 3500,
      totalKeysPurchased: 3,
      totalSpentOnKeysJpy: 2500,
      carryOverToNextJpy: 1000,
      entriesSnapshotHash: draw.entriesSnapshotHash,
      publicRandomSeed: SEED_HEX,
    },
    previousSettlement: {
      yearMonth: "2026-10",
      carryOverToNextJpy: 200,
    },
    games: [GAME_A, GAME_B],
    allocations,
    monthVideos,
    steamKeys,
    entries,
    drandConfig: DRAND_QUICKNET_CONFIG,
    publicConstants: PUBLIC_CONSTANTS,
  };
}

describe("public_constants & exact 1-sen BigInt arithmetic", () => {
  it("keeps web/src/domain/public_constants.json and docs/public_constants.json strictly identical and enforces schema invariants", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const webBundledPath = resolve(testDir, "../src/domain/public_constants.json");
    const docsCanonicalPath = resolve(testDir, "../../docs/public_constants.json");

    const webRaw = readFileSync(webBundledPath, "utf8").replace(/\r\n/g, "\n").trim();
    const docsRaw = readFileSync(docsCanonicalPath, "utf8").replace(/\r\n/g, "\n").trim();

    expect(webRaw).toBe(docsRaw);
    expect(JSON.parse(webRaw)).toEqual(JSON.parse(docsRaw));

    expect(PUBLIC_CONSTANTS.playMinutesPerVideo).toBe(60);
    expect(PUBLIC_CONSTANTS.reviewMinutesPerVideo).toBe(20);
    expect(PUBLIC_CONSTANTS.allowedHistoricalPlayMinutesPerVideo).toContain(60);
    expect(PUBLIC_CONSTANTS.allowedHistoricalReviewMinutesPerVideo).toContain(20);
    expect(resolveActiveRegionalLaborRateJpy("jp")).toBe(1320);
    expect(() => resolveActiveRegionalLaborRateJpy("XX")).toThrow(
      DomainValidationError,
    );

    const rawObj = JSON.parse(webRaw) as Record<string, unknown>;
    expect(() =>
      parsePublicConstants({
        ...rawObj,
        playMinutesPerVideo: 90,
        allowedHistoricalPlayMinutesPerVideo: [60],
      }),
    ).toThrow();
    expect(() =>
      parsePublicConstants({
        ...rawObj,
        reviewMinutesPerVideo: 30,
        allowedHistoricalReviewMinutesPerVideo: [20],
      }),
    ).toThrow();
  });

  it("computes exact BigInt sen for LLM tokens, fixed-minute labor, and floor sums", () => {
    expect(parseDecimalJpyToSen("68.5")).toBe(6850n);
    expect(
      computeLlmCostSenFromTokens({
        inputTokens: 48200,
        outputTokens: 15100,
        inputRateUsdPer1M: "3.0000",
        outputRateUsdPer1M: "15.0000",
        usdJpyRate: "152.5000",
      }),
    ).toBe(5659n);

    expect(
      formatSenToDecimalJpy(computeFixedMinutesLaborCostSen(60, 1320)),
    ).toBe("1320.00");
    expect(
      formatSenToDecimalJpy(computeFixedMinutesLaborCostSen(20, 1320)),
    ).toBe("440.00");
    // Sub-sen fraction (20 * 1000 * 100 / 60 = 33333.33... sen) floors in favor of viewers
    expect(
      formatSenToDecimalJpy(computeFixedMinutesLaborCostSen(20, 1000)),
    ).toBe("333.33");

    expect(sumInfraCostFloorJpy(["0.33", "0.33", "0.33"], 100, [500])).toBe(
      600,
    );
    expect(sumLaborCostFloorJpy(["333.33", "333.33"], ["333.33"])).toBe(999);
  });

  it("evaluates VideoCostLedger month strictly in Asia/Tokyo (UTC+09:00)", () => {
    expect(getYearMonthInJst(new Date("2026-10-31T14:59:59.999Z"))).toBe(
      "2026-10",
    );
    expect(getYearMonthInJst(new Date("2026-10-31T15:00:00.000Z"))).toBe(
      "2026-11",
    );
  });
});

describe("settlement: multi-game Hamilton view allocation, clipping & labor forfeiture", () => {
  it("distributes pool by Hamilton Largest-Remainder (tie-break: gameId ASC) and folds 0-key sub-retail remainders into carryOverToNextJpy", () => {
    const game3: TargetGameSnapshot = {
      id: 30,
      retailPriceJpy: 1200,
      isOperatorAffiliated: false,
      isApproved: true,
    };

    // Pool 1000 JPY across equal views 100 : 100 : 100 -> 333 rem 100 each
    // Tie-break gameId ASC gives +1 JPY to gameId=10 -> 334, 333, 333
    const allocs = allocatePoolByPublicViews({
      netBuybackPoolJpy: 1000,
      gameViewInputs: [
        { game: game3, publicViewCount: 100n },
        { game: GAME_A, publicViewCount: 100n },
        { game: GAME_B, publicViewCount: 100n },
      ],
      confirmedEntryCount: 10,
    });

    expect(allocs.map((a) => a.gameId)).toEqual([10, 20, 30]);
    expect(allocs.map((a) => a.allocatedBudgetJpy)).toEqual([334, 333, 333]);
    // All 3 are below retail (1000, 500, 1200) -> 0 keys, 100% folded to remainder
    expect(allocs.map((a) => a.keysPurchased)).toEqual([0, 0, 0]);
    expect(allocs.reduce((acc, a) => acc + a.remainderJpy, 0)).toBe(1000);
  });

  it("clips keys via Hamilton Largest-Remainder proportional to maxAffordableKeys when entries < budget keys (with tie-breakers)", () => {
    const g1: TargetGameSnapshot = {
      id: 1,
      retailPriceJpy: 500,
      isOperatorAffiliated: false,
      isApproved: true,
    };
    const g2: TargetGameSnapshot = {
      id: 2,
      retailPriceJpy: 500,
      isOperatorAffiliated: false,
      isApproved: true,
    };
    const g3: TargetGameSnapshot = {
      id: 3,
      retailPriceJpy: 500,
      isOperatorAffiliated: false,
      isApproved: true,
    };

    // Pool = 3000 JPY; views 1000 : 1100 : 900 -> budgets 1000, 1100, 900
    // maxAffordableKeys: g1 = 2, g2 = 2, g3 = 1 (totalMax = 5)
    // confirmedEntryCount = 3:
    //   g1: 3 * 2 / 5 = 1 rem 1 (views 1000)
    //   g2: 3 * 2 / 5 = 1 rem 1 (views 1100 -> wins tie-break over g1 via publicViewCount DESC!)
    //   g3: 3 * 1 / 5 = 0 rem 3 (highest remainder 3 -> gets +1!)
    // wait:baseKeysSum = 1 + 1 + 0 = 2, leftoverKeys = 1 -> g3 has rem 3 > rem 1, so g3 gets +1 -> [1, 1, 1]!
    // Now test exact remainder tie (confirmedEntryCount = 2, g1 max=2, g2 max=2 -> totalMax=4):
    //   g1: 2 * 2 / 4 = 1 rem 0; let's use confirmedEntryCount = 1 with g1 max=2 (views 1000), g2 max=2 (views 1500):
    //   g1: 1 * 2 / 4 = 0 rem 2 (views 1000)
    //   g2: 1 * 2 / 4 = 0 rem 2 (views 1500) -> g2 wins tie on publicViewCount DESC!
    const tieClip = allocatePoolByPublicViews({
      netBuybackPoolJpy: 2500,
      gameViewInputs: [
        { game: g1, publicViewCount: 1000n }, // allocated 1000 -> max 2
        { game: g2, publicViewCount: 1500n }, // allocated 1500 -> max 3 -> let's make g2 retail 750 so max=2!
      ].map((x, idx) =>
        idx === 1 ? { ...x, game: { ...g2, retailPriceJpy: 750 } } : x,
      ),
      confirmedEntryCount: 1,
    });

    expect(tieClip[0]?.maxAffordableKeys).toBe(2);
    expect(tieClip[1]?.maxAffordableKeys).toBe(2);
    expect(tieClip[0]?.keysPurchased).toBe(0);
    expect(tieClip[1]?.keysPurchased).toBe(1); // Won tie via higher publicViewCount (1500 > 1000)

    const fullCalc = calculateMonthlySettlement({
      carryOverFromPrevJpy: 0,
      grossAdRevenueJpy: 3000,
      videoGenerationCostsDecimalJpy: [],
      webHostingCostJpy: 0,
      videoPlayLaborCostsDecimalJpy: [],
      videoReviewLaborCostsDecimalJpy: [],
      gameViewInputs: [
        { game: g1, publicViewCount: 1000n },
        { game: g2, publicViewCount: 1100n },
        { game: g3, publicViewCount: 900n },
      ],
      confirmedEntryCount: 3, // totalMax = 5 -> clipped to 3
    });

    expect(fullCalc.totalMaxAffordableKeys).toBe(5);
    expect(fullCalc.totalKeysPurchased).toBe(3);
    expect(fullCalc.allocations.map((a) => a.keysPurchased)).toEqual([1, 1, 1]);
    expect(fullCalc.totalSpentOnKeysJpy).toBe(1500);
    expect(fullCalc.carryOverToNextJpy).toBe(1500);
  });

  it("forfeits unpaid labor without carry-over while carrying over negative cash infra deficit only", () => {
    // Month 1: Ad revenue 500 JPY < Cash infra 2000 JPY; accrued labor = 1760 JPY
    // Expected: paidLabor = 0, forfeitedLabor = 1760, carryOverToNext = -1500 JPY (NOT -3260!)
    const month1 = calculateMonthlySettlement({
      carryOverFromPrevJpy: 0,
      grossAdRevenueJpy: 500,
      videoGenerationCostsDecimalJpy: ["200.00"],
      webHostingCostJpy: 1800,
      videoPlayLaborCostsDecimalJpy: ["1320.00"],
      videoReviewLaborCostsDecimalJpy: ["440.00"],
      gameViewInputs: [{ game: GAME_A, publicViewCount: 500n }],
      confirmedEntryCount: 20,
    });

    expect(month1.totalInfraCostJpy).toBe(2000);
    expect(month1.totalLaborCostJpy).toBe(1760);
    expect(month1.paidLaborCostJpy).toBe(0);
    expect(month1.forfeitedLaborCostJpy).toBe(1760);
    expect(month1.netBuybackPoolJpy).toBe(-1500);
    expect(month1.totalKeysPurchased).toBe(0);
    expect(month1.carryOverToNextJpy).toBe(-1500);

    // Month 2: Recovers -1500 cash infra + pays 1000 out of 1760 Month-2 labor, forfeits remaining 760 -> carryOver = 0
    const month2 = calculateMonthlySettlement({
      carryOverFromPrevJpy: month1.carryOverToNextJpy,
      grossAdRevenueJpy: 3500,
      videoGenerationCostsDecimalJpy: [],
      webHostingCostJpy: 1000, // balanceAfterInfra = -1500 + 3500 - 1000 = 1000
      videoPlayLaborCostsDecimalJpy: ["1320.00"],
      videoReviewLaborCostsDecimalJpy: ["440.00"], // totalLabor = 1760
      gameViewInputs: [{ game: GAME_A, publicViewCount: 1000n }],
      confirmedEntryCount: 20,
    });

    expect(month2.paidLaborCostJpy).toBe(1000);
    expect(month2.forfeitedLaborCostJpy).toBe(760);
    expect(month2.netBuybackPoolJpy).toBe(0);
    expect(month2.carryOverToNextJpy).toBe(0);
  });

  it("rejects non-zero ownerProfitJpy and operator-affiliated self-dealing games", () => {
    expect(() =>
      calculateMonthlySettlement({
        carryOverFromPrevJpy: 0,
        grossAdRevenueJpy: 5000,
        videoGenerationCostsDecimalJpy: [],
        webHostingCostJpy: 1000,
        videoPlayLaborCostsDecimalJpy: [],
        videoReviewLaborCostsDecimalJpy: [],
        gameViewInputs: [{ game: GAME_A, publicViewCount: 100n }],
        confirmedEntryCount: 5,
        ownerProfitJpy: 1,
      }),
    ).toThrow(InvariantViolationError);

    expect(() =>
      validateTargetGameEligible({
        id: 99,
        retailPriceJpy: 1000,
        isOperatorAffiliated: true,
        isApproved: true,
      }),
    ).toThrow(SelfDealingProhibitedError);
  });
});

describe("settlement: verifySettlementInvariants (all 5 cross-record invariants)", () => {
  it("passes when multi-game view allocations, AI & human videos, labor caps, and (gameId ASC, keyId ASC) draw hold", () => {
    const ctx = buildValidMultiGameAuditContext();
    expect(() => verifySettlementInvariants(ctx)).not.toThrow();
  });

  it("Invariant 1: detects carry-over discontinuity, duplicate play labor, tampered AI cost, missing AI disclosure, & missing receipt", () => {
    const base = buildValidMultiGameAuditContext();

    // 1. Carry-over discontinuity
    expect(() =>
      verifySettlementInvariants({
        ...base,
        previousSettlement: { yearMonth: "2026-10", carryOverToNextJpy: 199 },
      }),
    ).toThrow(InvariantViolationError);

    // 2. Duplicate HUMAN_PLAY (playMinutes=60) for same game in same month
    expect(() =>
      verifySettlementInvariants({
        ...base,
        monthVideos: base.monthVideos.map((v) =>
          v.id === 2
            ? {
                ...v,
                footageSource: "HUMAN_PLAY",
                playMinutes: 60,
                playLaborRateJpyPerHour: 1320,
                playLaborCostDecimalJpy: "1320.00",
              }
            : v,
        ),
      }),
    ).toThrow(InvariantViolationError);

    // 3. Reused rawFootageSha256 from prior month claiming playMinutes > 0
    expect(() =>
      verifySettlementInvariants({
        ...base,
        priorMonthsBilledRawFootageHashes: new Set(["a".repeat(64)]),
      }),
    ).toThrow(InvariantViolationError);

    // 4. Synthetic video missing aiDisclosureSet
    expect(() =>
      verifySettlementInvariants({
        ...base,
        monthVideos: base.monthVideos.map((v) =>
          v.id === 1 ? { ...v, aiDisclosureSet: false } : v,
        ),
      }),
    ).toThrow(InvariantViolationError);

    // 5. Non-synthetic (human streamer) video falsely claiming aiDisclosureSet = true
    expect(() =>
      verifySettlementInvariants({
        ...base,
        monthVideos: base.monthVideos.map((v) =>
          v.id === 3 ? { ...v, aiDisclosureSet: true } : v,
        ),
      }),
    ).toThrow(InvariantViolationError);

    // 6. Recording game cost > 0 without receipt URL
    expect(() =>
      verifySettlementInvariants({
        ...base,
        monthVideos: base.monthVideos.map((v) =>
          v.id === 1 ? { ...v, recordingGameReceiptUrl: null } : v,
        ),
      }),
    ).toThrow(InvariantViolationError);

    // 7. Recording game cost > 0 when same gameId was ALREADY billed in a prior month (lifetime once-per-game limit)
    try {
      verifySettlementInvariants({
        ...base,
        priorMonthsBilledRecordingCostGameIds: new Set([GAME_A.id]),
      });
      expect.unreachable("Expected InvariantViolationError for prior-month recording cost");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(InvariantViolationError);
      expect((err as InvariantViolationError).messageKey).toBe(
        "error.invariant.video_recording_cost_invalid",
      );
    }

    // 8. Allocation math tampered (+10 JPY shifted from GAME_A to GAME_B)
    expect(() =>
      verifySettlementInvariants({
        ...base,
        allocations: base.allocations.map((a) =>
          a.gameId === GAME_A.id
            ? {
                ...a,
                allocatedBudgetJpy: a.allocatedBudgetJpy - 10,
                remainderJpy: a.remainderJpy - 10,
              }
            : {
                ...a,
                allocatedBudgetJpy: a.allocatedBudgetJpy + 10,
                remainderJpy: a.remainderJpy + 10,
              },
        ),
      }),
    ).toThrow(InvariantViolationError);
  });

  it("Invariant 1 (historical minutes): passes past 60m/20m rows after standard minutes change, and rejects unapproved minutes", () => {
    const base = buildValidMultiGameAuditContext();

    // Future constants update: active standard changes to 90m play / 30m review while keeping 60m / 20m in allowedHistorical*
    const futureConstants = parsePublicConstants({
      schemaVersion: 1,
      playMinutesPerVideo: 90,
      reviewMinutesPerVideo: 30,
      allowedHistoricalPlayMinutesPerVideo: [60, 90],
      allowedHistoricalReviewMinutesPerVideo: [20, 30],
      regionalLaborRatesJpyPerHour: { JP: 1320 },
      allowedHistoricalRegionalRatesJpyPerHour: { JP: [1320] },
      minutesHistory: [
        {
          effectiveFrom: "2026-10-01",
          playMinutesPerVideo: 60,
          reviewMinutesPerVideo: 20,
          rationale: "初期基準（60分／20分）",
        },
        {
          effectiveFrom: "2027-04-01",
          playMinutesPerVideo: 90,
          reviewMinutesPerVideo: 30,
          rationale: "長編検証に伴う基準改定（90分／30分）",
        },
      ],
      rateHistory: [
        {
          effectiveFrom: "2026-10-01",
          regionCode: "JP",
          rateJpyPerHour: 1320,
          rationale: "初期基準時給",
        },
      ],
    });

    // Existing historical 60m / 20m rows MUST still pass third-party audit!
    expect(() =>
      verifySettlementInvariants({
        ...base,
        publicConstants: futureConstants,
      }),
    ).not.toThrow();

    // Unapproved playMinutes (45m = 990.00 JPY) MUST fail even if arithmetic (45 * 1320 / 60 = 990) matches
    try {
      verifySettlementInvariants({
        ...base,
        publicConstants: futureConstants,
        monthVideos: base.monthVideos.map((v) =>
          v.id === 1
            ? {
                ...v,
                playMinutes: 45,
                playLaborCostDecimalJpy: "990.00",
              }
            : v,
        ),
      });
      expect.unreachable("Expected unapproved playMinutes (45) to be rejected");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(InvariantViolationError);
      expect((err as InvariantViolationError).messageKey).toBe(
        "error.invariant.video_labor_invalid",
      );
    }

    // Unapproved reviewMinutes (15m = 330.00 JPY) MUST also fail
    try {
      verifySettlementInvariants({
        ...base,
        publicConstants: futureConstants,
        monthVideos: base.monthVideos.map((v) =>
          v.id === 1
            ? {
                ...v,
                reviewMinutes: 15,
                reviewLaborCostDecimalJpy: "330.00",
              }
            : v,
        ),
      });
      expect.unreachable("Expected unapproved reviewMinutes (15) to be rejected");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(InvariantViolationError);
      expect((err as InvariantViolationError).messageKey).toBe(
        "error.invariant.video_labor_invalid",
      );
    }
  });

  it("Invariant 2 & 3: detects settlementId mismatches across allocations, SteamKeyInventory, and entries", () => {
    const base = buildValidMultiGameAuditContext();

    // Allocation belonging to a different settlementId
    expect(() =>
      verifySettlementInvariants({
        ...base,
        allocations: base.allocations.map((a) =>
          a.id === 11 ? { ...a, settlementId: 999 } : a,
        ),
      }),
    ).toThrow(InvariantViolationError);

    // Distributed or undistributed SteamKeyInventory row with mismatched settlementId
    try {
      verifySettlementInvariants({
        ...base,
        steamKeys: base.steamKeys.map((k) =>
          k.id === 501 ? { ...k, settlementId: 999 } : k,
        ),
      });
      expect.unreachable("Expected SteamKeyInventory settlementId mismatch to throw");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(InvariantViolationError);
      expect((err as InvariantViolationError).messageKey).toBe(
        "error.invariant.inventory_game_mismatch",
      );
    }

    expect(() =>
      verifySettlementInvariants({
        ...base,
        steamKeys: base.steamKeys.map((k) =>
          k.id === 503 ? { ...k, settlementId: 999 } : k,
        ),
      }),
    ).toThrow(InvariantViolationError);

    // Lottery entry belonging to a different settlementId
    expect(() =>
      verifySettlementInvariants({
        ...base,
        entries: base.entries.map((e, idx) =>
          idx === 0 ? { ...e, settlementId: 999 } : e,
        ),
      }),
    ).toThrow(InvariantViolationError);
  });

  it("Invariant 2: detects per-allocation SteamKeyInventory gameId, price, or distributed count mismatch", () => {
    const base = buildValidMultiGameAuditContext();

    expect(() =>
      verifySettlementInvariants({
        ...base,
        steamKeys: base.steamKeys.map((k) =>
          k.id === 501 ? { ...k, gameId: GAME_B.id } : k,
        ),
      }),
    ).toThrow(InvariantViolationError);

    expect(() =>
      verifySettlementInvariants({
        ...base,
        steamKeys: base.steamKeys.map((k) =>
          k.id === 501 ? { ...k, purchasePriceJpy: 800 } : k,
        ),
      }),
    ).toThrow(InvariantViolationError);
  });

  it("Invariant 3: detects totalKeysPurchased cap mismatch, post-cutoff entries, and swapped (gameId ASC, key.id ASC) winner keys", () => {
    const base = buildValidMultiGameAuditContext();

    // Direct totalKeysPurchased cap violation
    expect(() =>
      verifySettlementInvariants({
        ...base,
        settlement: { ...base.settlement, totalKeysPurchased: 2 },
      }),
    ).toThrow(InvariantViolationError);

    // Swapping GAME_A key (501) and GAME_B key (601) between 1st-rank winner and 3rd-rank winner!
    const e501 = base.entries.find((e) => e.wonSteamKeyId === 501);
    const e601 = base.entries.find((e) => e.wonSteamKeyId === 601);
    if (!e501 || !e601) {
      throw new Error("Expected winners with keys 501 and 601");
    }
    expect(() =>
      verifySettlementInvariants({
        ...base,
        entries: base.entries.map((e) => {
          if (e.id === e501.id) return { ...e, wonSteamKeyId: 601 };
          if (e.id === e601.id) return { ...e, wonSteamKeyId: 501 };
          return e;
        }),
      }),
    ).toThrow(InvariantViolationError);
  });

  it("Invariant 4 & 5: detects tampered drand commitment and operator-affiliated game in allocations", () => {
    const base = buildValidMultiGameAuditContext();

    expect(() =>
      verifySettlementInvariants({
        ...base,
        settlement: {
          ...base.settlement,
          committedDrandRound: base.settlement.committedDrandRound + 1n,
        },
      }),
    ).toThrow(InvariantViolationError);

    expect(() =>
      verifySettlementInvariants({
        ...base,
        games: base.games.map((g) =>
          g.id === GAME_B.id ? { ...g, isOperatorAffiliated: true } : g,
        ),
      }),
    ).toThrow(SelfDealingProhibitedError);
  });
});
