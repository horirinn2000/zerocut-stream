import {
  PUBLIC_CONSTANTS,
  type PublicConstantsConfig,
  isAllowedHistoricalPlayMinutes,
  isAllowedHistoricalRegionalLaborRateJpy,
  isAllowedHistoricalReviewMinutes,
} from "@/domain/constants";
import {
  DomainValidationError,
  InvariantViolationError,
  SelfDealingProhibitedError,
} from "@/domain/errors";
import {
  DRAND_QUICKNET_CONFIG,
  type DrandChainConfig,
  computeEntriesSnapshotHash,
  deriveTargetDrandRound,
  executeFairDraw,
} from "@/lib/fair_draw";

const DECIMAL_JPY_REGEX = /^\d+(?:\.(\d{1,2}))?$/;
const DECIMAL_RATE_4_REGEX = /^\d+(?:\.(\d{1,4}))?$/;

export type LedgerFootageSource = "HUMAN_PLAY" | "SECONDARY_CLIP" | "BOT_PLAY";
export type LedgerContentIdStatus =
  | "CLEAR"
  | "CLAIMED_REVENUE_REDIRECTED"
  | "RESTRICTED";

export interface TargetGameSnapshot {
  readonly id: number;
  readonly retailPriceJpy: number;
  readonly isOperatorAffiliated: boolean;
  readonly isApproved: boolean;
}

export interface GameViewAllocationInput {
  readonly game: TargetGameSnapshot;
  readonly publicViewCount: bigint;
}

export interface ComputedGameAllocation {
  readonly gameId: number;
  readonly publicViewCount: bigint;
  readonly unitRetailPriceJpy: number;
  readonly allocatedBudgetJpy: number;
  readonly maxAffordableKeys: number;
  readonly keysPurchased: number;
  readonly spentJpy: number;
  readonly remainderJpy: number;
}

export interface SettlementCalculationInput {
  readonly carryOverFromPrevJpy: number;
  readonly grossAdRevenueJpy: number;
  readonly videoGenerationCostsDecimalJpy: readonly string[];
  readonly recordingGameCostsJpy?: readonly number[];
  readonly webHostingCostJpy: number;
  readonly videoPlayLaborCostsDecimalJpy: readonly string[];
  readonly videoReviewLaborCostsDecimalJpy: readonly string[];
  readonly gameViewInputs: readonly GameViewAllocationInput[];
  readonly confirmedEntryCount: number;
  readonly ownerProfitJpy?: number;
}

export interface SettlementCalculationOutput {
  readonly totalInfraCostJpy: number;
  readonly totalLaborCostJpy: number;
  readonly paidLaborCostJpy: number;
  readonly forfeitedLaborCostJpy: number;
  readonly ownerProfitJpy: 0;
  readonly netBuybackPoolJpy: number;
  readonly allocations: readonly ComputedGameAllocation[];
  readonly totalMaxAffordableKeys: number;
  readonly totalKeysPurchased: number;
  readonly totalSpentOnKeysJpy: number;
  readonly carryOverToNextJpy: number;
}

export interface VideoCostAuditRecord {
  readonly id: number;
  readonly youtubeVideoId: string | null;
  readonly gameId: number;
  readonly isSyntheticContent: boolean;
  readonly llmModelName: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly inputRateUsdPer1M: string;
  readonly outputRateUsdPer1M: string;
  readonly usdJpyRate: string;
  readonly llmCostDecimalJpy: string;
  readonly ttsCostDecimalJpy: string;
  readonly computeCostDecimalJpy: string;
  readonly totalGenerationCostDecimalJpy: string;
  readonly recordingGameCostJpy: number;
  readonly recordingGameReceiptUrl: string | null;
  readonly footageSource: LedgerFootageSource;
  readonly rawFootageSha256: string | null;
  readonly playRegionCode: string;
  readonly playMinutes: number;
  readonly playLaborRateJpyPerHour: number;
  readonly playLaborCostDecimalJpy: string;
  readonly reviewRegionCode: string;
  readonly reviewMinutes: number;
  readonly reviewLaborRateJpyPerHour: number;
  readonly reviewLaborCostDecimalJpy: string;
  readonly aiDisclosureSet: boolean;
  readonly contentIdStatus: LedgerContentIdStatus;
  readonly viewCountSnapshot: bigint | null;
  readonly publishedAt: Date;
}

export interface AllocationAuditRecord {
  readonly id: number;
  readonly settlementId: number;
  readonly gameId: number;
  readonly publicViewCount: bigint;
  readonly allocatedBudgetJpy: number;
  readonly unitRetailPriceJpy: number;
  readonly keysPurchased: number;
  readonly spentJpy: number;
  readonly remainderJpy: number;
}

export interface SteamKeyAuditRecord {
  readonly id: number;
  readonly settlementId: number;
  readonly allocationId: number;
  readonly gameId: number;
  readonly purchasePriceJpy: number;
  readonly isDistributed: boolean;
}

export interface LotteryEntryAuditRecord {
  readonly id: number;
  readonly settlementId: number;
  readonly isWinner: boolean;
  readonly wonSteamKeyId: number | null;
  readonly createdAt: Date;
}

export interface SettledRecordSnapshot {
  readonly id: number;
  readonly yearMonth: string;
  readonly entryCutoffAt: Date;
  readonly drandChainHash: string;
  readonly committedDrandRound: bigint;
  readonly carryOverFromPrevJpy: number;
  readonly grossAdRevenueJpy: number;
  readonly webHostingCostJpy: number;
  readonly totalInfraCostJpy: number;
  readonly totalLaborCostJpy: number;
  readonly paidLaborCostJpy: number;
  readonly ownerProfitJpy: number;
  readonly netBuybackPoolJpy: number;
  readonly totalKeysPurchased: number;
  readonly totalSpentOnKeysJpy: number;
  readonly carryOverToNextJpy: number;
  readonly entriesSnapshotHash: string | null;
  readonly publicRandomSeed: string | null;
}

export interface PreviousSettlementSnapshot {
  readonly yearMonth: string;
  readonly carryOverToNextJpy: number;
}

export interface SettlementAuditContext {
  readonly settlement: SettledRecordSnapshot;
  readonly previousSettlement: PreviousSettlementSnapshot | null;
  readonly games: readonly TargetGameSnapshot[];
  readonly allocations: readonly AllocationAuditRecord[];
  readonly monthVideos: readonly VideoCostAuditRecord[];
  readonly steamKeys: readonly SteamKeyAuditRecord[];
  readonly entries: readonly LotteryEntryAuditRecord[];
  readonly drandConfig?: DrandChainConfig;
  readonly publicConstants?: PublicConstantsConfig;
  readonly priorMonthsBilledRawFootageHashes?: ReadonlySet<string>;
  readonly priorMonthsBilledRecordingCostGameIds?: ReadonlySet<number>;
}

function assertSafeInteger(field: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainValidationError("error.validation.invalid_integer", {
      field,
      value: String(value),
    });
  }
}

function assertNonNegativeInteger(field: string, value: number): void {
  assertSafeInteger(field, value);
  if (value < 0) {
    throw new DomainValidationError("error.validation.negative_not_allowed", {
      field,
      value,
    });
  }
}

function assertPositiveInteger(field: string, value: number): void {
  assertSafeInteger(field, value);
  if (value <= 0) {
    throw new DomainValidationError("error.validation.positive_required", {
      field,
      value,
    });
  }
}

/**
 * Formats a Date into "YYYY-MM" in Asia/Tokyo (UTC+09:00) deterministically.
 */
export function getYearMonthInJst(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new DomainValidationError("error.validation.invalid_date", {
      field: "date",
    });
  }
  const jstTimeMs = date.getTime() + 9 * 60 * 60 * 1000;
  const jstDate = new Date(jstTimeMs);
  const year = jstDate.getUTCFullYear();
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Converts a non-negative decimal JPY string (up to 2 decimal places, e.g. "68.50")
 * into exact integer "sen" (1 JPY = 100 sen) using BigInt without floating-point math.
 */
export function parseDecimalJpyToSen(decimalStr: string): bigint {
  const trimmed = decimalStr.trim();
  const match = DECIMAL_JPY_REGEX.exec(trimmed);
  if (!match) {
    throw new DomainValidationError("error.validation.invalid_decimal_jpy", {
      value: decimalStr,
    });
  }
  const [wholePart] = trimmed.split(".");
  const fractionPart = (match[1] ?? "").padEnd(2, "0");
  return BigInt(wholePart ?? "0") * 100n + BigInt(fractionPart);
}

/**
 * Formats non-negative integer sen into "XX.YY" decimal JPY string.
 */
export function formatSenToDecimalJpy(sen: bigint): string {
  if (sen < 0n) {
    throw new DomainValidationError("error.validation.negative_not_allowed", {
      field: "sen",
      value: sen.toString(),
    });
  }
  const whole = sen / 100n;
  const frac = (sen % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}`;
}

/**
 * Converts a non-negative rate string (up to 4 decimal places, e.g. "152.5000")
 * into exact 10^-4 units using BigInt.
 */
export function parseDecimalRate4ToUnits(rateStr: string): bigint {
  const trimmed = rateStr.trim();
  const match = DECIMAL_RATE_4_REGEX.exec(trimmed);
  if (!match) {
    throw new DomainValidationError("error.validation.invalid_decimal_rate", {
      value: rateStr,
    });
  }
  const [wholePart] = trimmed.split(".");
  const fractionPart = (match[1] ?? "").padEnd(4, "0");
  return BigInt(wholePart ?? "0") * 10000n + BigInt(fractionPart);
}

/**
 * Computes exact LLM token cost in sen (ROUND_HALF_UP to 0.01 JPY) using BigInt only.
 */
export function computeLlmCostSenFromTokens(params: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly inputRateUsdPer1M: string;
  readonly outputRateUsdPer1M: string;
  readonly usdJpyRate: string;
}): bigint {
  assertNonNegativeInteger("inputTokens", params.inputTokens);
  assertNonNegativeInteger("outputTokens", params.outputTokens);

  const inRate4 = parseDecimalRate4ToUnits(params.inputRateUsdPer1M);
  const outRate4 = parseDecimalRate4ToUnits(params.outputRateUsdPer1M);
  const fxRate4 = parseDecimalRate4ToUnits(params.usdJpyRate);

  const usdUnits10 =
    BigInt(params.inputTokens) * inRate4 +
    BigInt(params.outputTokens) * outRate4;
  const jpyUnits14 = usdUnits10 * fxRate4;
  return (jpyUnits14 + 500_000_000_000n) / 1_000_000_000_000n;
}

/**
 * Computes fixed-minute labor cost in exact integer sen (viewer-favorable floor).
 */
export function computeFixedMinutesLaborCostSen(
  minutes: number,
  rateJpyPerHour: number,
): bigint {
  assertNonNegativeInteger("minutes", minutes);
  assertNonNegativeInteger("rateJpyPerHour", rateJpyPerHour);
  return (BigInt(minutes) * BigInt(rateJpyPerHour) * 100n) / 60n;
}

/**
 * Sums cash out-of-pocket infrastructure & recording software expenses in exact 1-sen
 * BigInt units and floors to whole JPY.
 */
export function sumInfraCostFloorJpy(
  videoGenerationCostsDecimalJpy: readonly string[],
  webHostingCostJpy: number,
  recordingGameCostsJpy: readonly number[] = [],
): number {
  assertNonNegativeInteger("webHostingCostJpy", webHostingCostJpy);

  let totalSen = BigInt(webHostingCostJpy) * 100n;
  for (const recCost of recordingGameCostsJpy) {
    assertNonNegativeInteger("recordingGameCostJpy", recCost);
    totalSen += BigInt(recCost) * 100n;
  }
  for (const costStr of videoGenerationCostsDecimalJpy) {
    totalSen += parseDecimalJpyToSen(costStr);
  }

  const totalFloorJpy = Number(totalSen / 100n);
  assertSafeInteger("totalInfraCostJpy", totalFloorJpy);
  return totalFloorJpy;
}

/**
 * Sums play labor and review/upload labor Decimal strings in exact 1-sen BigInt units
 * and floors to whole JPY.
 */
export function sumLaborCostFloorJpy(
  videoPlayLaborCostsDecimalJpy: readonly string[],
  videoReviewLaborCostsDecimalJpy: readonly string[],
): number {
  let totalSen = 0n;
  for (const playStr of videoPlayLaborCostsDecimalJpy) {
    totalSen += parseDecimalJpyToSen(playStr);
  }
  for (const reviewStr of videoReviewLaborCostsDecimalJpy) {
    totalSen += parseDecimalJpyToSen(reviewStr);
  }
  const totalFloorJpy = Number(totalSen / 100n);
  assertSafeInteger("totalLaborCostJpy", totalFloorJpy);
  return totalFloorJpy;
}

/**
 * Validates that a target game is an approved, independent third-party title
 * (Cross-Record Invariant 5: Self-Dealing Prohibited).
 */
export function validateTargetGameEligible(game: TargetGameSnapshot): void {
  assertPositiveInteger("game.id", game.id);
  assertPositiveInteger("game.retailPriceJpy", game.retailPriceJpy);

  if (game.isOperatorAffiliated) {
    throw new SelfDealingProhibitedError(game.id);
  }
  if (!game.isApproved) {
    throw new InvariantViolationError("error.invariant.game_not_approved", {
      gameId: game.id,
    });
  }
}

/**
 * Allocates netBuybackPoolJpy across eligible games using exact BigInt Hamilton
 * Largest-Remainder Method proportional to publicViewCount (tie-breaker: gameId ASC),
 * then clips purchasable keys to confirmedEntryCount via Hamilton Largest-Remainder
 * proportional to maxAffordableKeys (tie-breaker: remainder DESC, publicViewCount DESC, gameId ASC).
 */
export function allocatePoolByPublicViews(params: {
  readonly netBuybackPoolJpy: number;
  readonly gameViewInputs: readonly GameViewAllocationInput[];
  readonly confirmedEntryCount: number;
}): readonly ComputedGameAllocation[] {
  assertSafeInteger("netBuybackPoolJpy", params.netBuybackPoolJpy);
  assertNonNegativeInteger("confirmedEntryCount", params.confirmedEntryCount);

  const seenGameIds = new Set<number>();
  const sortedInputs = [...params.gameViewInputs].sort(
    (a, b) => a.game.id - b.game.id,
  );

  let totalViews = 0n;
  for (const item of sortedInputs) {
    validateTargetGameEligible(item.game);
    if (seenGameIds.has(item.game.id)) {
      throw new DomainValidationError("error.validation.invalid_integer", {
        field: "duplicateGameId",
        value: String(item.game.id),
      });
    }
    if (item.publicViewCount < 0n) {
      throw new DomainValidationError("error.validation.negative_not_allowed", {
        field: "publicViewCount",
        value: item.publicViewCount.toString(),
      });
    }
    seenGameIds.add(item.game.id);
    totalViews += item.publicViewCount;
  }

  // Stage 1: Budget allocation per game
  const allocatedBudgets = new Array<number>(sortedInputs.length).fill(0);
  if (
    params.netBuybackPoolJpy > 0 &&
    sortedInputs.length > 0 &&
    totalViews > 0n
  ) {
    const poolBig = BigInt(params.netBuybackPoolJpy);
    let baseBudgetSum = 0;
    const budgetRemainders: Array<{
      readonly idx: number;
      readonly rem: bigint;
      readonly gameId: number;
    }> = [];

    for (const [idx, item] of sortedInputs.entries()) {
      const numer = poolBig * item.publicViewCount;
      const base = Number(numer / totalViews);
      const rem = numer % totalViews;
      allocatedBudgets[idx] = base;
      baseBudgetSum += base;
      budgetRemainders.push({ idx, rem, gameId: item.game.id });
    }

    const leftoverYen = params.netBuybackPoolJpy - baseBudgetSum;
    budgetRemainders.sort((a, b) => {
      if (a.rem !== b.rem) {
        return a.rem > b.rem ? -1 : 1;
      }
      return a.gameId - b.gameId;
    });

    for (let r = 0; r < leftoverYen; r++) {
      const winner = budgetRemainders[r];
      if (winner) {
        allocatedBudgets[winner.idx] = (allocatedBudgets[winner.idx] ?? 0) + 1;
      }
    }
  }

  // Stage 2: Affordable keys & deterministic clipping when confirmedEntryCount < sum(maxAffordableKeys)
  const maxAffordablePerGame = sortedInputs.map((item, idx) => {
    const budget = allocatedBudgets[idx] ?? 0;
    return budget > 0 ? Math.floor(budget / item.game.retailPriceJpy) : 0;
  });

  const totalMaxAffordableKeys = maxAffordablePerGame.reduce(
    (acc, n) => acc + n,
    0,
  );
  const keysPurchasedPerGame = new Array<number>(sortedInputs.length).fill(0);

  if (params.confirmedEntryCount >= totalMaxAffordableKeys) {
    for (let idx = 0; idx < sortedInputs.length; idx++) {
      keysPurchasedPerGame[idx] = maxAffordablePerGame[idx] ?? 0;
    }
  } else if (params.confirmedEntryCount > 0 && totalMaxAffordableKeys > 0) {
    const mBig = BigInt(params.confirmedEntryCount);
    const totalMaxBig = BigInt(totalMaxAffordableKeys);
    let baseKeysSum = 0;
    const keyRemainders: Array<{
      readonly idx: number;
      readonly rem: bigint;
      readonly publicViewCount: bigint;
      readonly gameId: number;
    }> = [];

    for (const [idx, item] of sortedInputs.entries()) {
      const maxK = maxAffordablePerGame[idx] ?? 0;
      const numer = mBig * BigInt(maxK);
      const baseK = Number(numer / totalMaxBig);
      const remK = numer % totalMaxBig;
      keysPurchasedPerGame[idx] = baseK;
      baseKeysSum += baseK;
      if (maxK > 0) {
        keyRemainders.push({
          idx,
          rem: remK,
          publicViewCount: item.publicViewCount,
          gameId: item.game.id,
        });
      }
    }

    const leftoverKeys = params.confirmedEntryCount - baseKeysSum;
    keyRemainders.sort((a, b) => {
      if (a.rem !== b.rem) {
        return a.rem > b.rem ? -1 : 1;
      }
      if (a.publicViewCount !== b.publicViewCount) {
        return a.publicViewCount > b.publicViewCount ? -1 : 1;
      }
      return a.gameId - b.gameId;
    });

    for (let r = 0; r < leftoverKeys; r++) {
      const winner = keyRemainders[r];
      if (winner) {
        keysPurchasedPerGame[winner.idx] =
          (keysPurchasedPerGame[winner.idx] ?? 0) + 1;
      }
    }
  }

  return sortedInputs.map((item, idx) => {
    const allocatedBudgetJpy = allocatedBudgets[idx] ?? 0;
    const maxAffordableKeys = maxAffordablePerGame[idx] ?? 0;
    const keysPurchased = keysPurchasedPerGame[idx] ?? 0;
    const unitRetailPriceJpy = item.game.retailPriceJpy;
    const spentJpy = keysPurchased * unitRetailPriceJpy;
    const remainderJpy = allocatedBudgetJpy - spentJpy;

    return {
      gameId: item.game.id,
      publicViewCount: item.publicViewCount,
      unitRetailPriceJpy,
      allocatedBudgetJpy,
      maxAffordableKeys,
      keysPurchased,
      spentJpy,
      remainderJpy,
    };
  });
}

/**
 * Pure multi-game monthly settlement calculation enforcing:
 * - Iron Rule 1: ownerProfitJpy === 0, cash infra carry-over vs non-carried-over labor forfeiture
 * - Iron Rule 2: 100% net pool allocated across independent third-party games by public view ratio
 */
export function calculateMonthlySettlement(
  input: SettlementCalculationInput,
): SettlementCalculationOutput {
  assertSafeInteger("carryOverFromPrevJpy", input.carryOverFromPrevJpy);
  assertNonNegativeInteger("grossAdRevenueJpy", input.grossAdRevenueJpy);
  assertNonNegativeInteger("webHostingCostJpy", input.webHostingCostJpy);
  assertNonNegativeInteger("confirmedEntryCount", input.confirmedEntryCount);

  const requestedOwnerProfit = input.ownerProfitJpy ?? 0;
  if (requestedOwnerProfit !== 0) {
    throw new InvariantViolationError("error.invariant.owner_profit_nonzero", {
      ownerProfitJpy: requestedOwnerProfit,
    });
  }

  const totalInfraCostJpy = sumInfraCostFloorJpy(
    input.videoGenerationCostsDecimalJpy,
    input.webHostingCostJpy,
    input.recordingGameCostsJpy ?? [],
  );

  const totalLaborCostJpy = sumLaborCostFloorJpy(
    input.videoPlayLaborCostsDecimalJpy,
    input.videoReviewLaborCostsDecimalJpy,
  );

  const balanceAfterInfraJpy =
    input.carryOverFromPrevJpy + input.grossAdRevenueJpy - totalInfraCostJpy;
  assertSafeInteger("balanceAfterInfraJpy", balanceAfterInfraJpy);

  const paidLaborCostJpy = Math.min(
    totalLaborCostJpy,
    Math.max(0, balanceAfterInfraJpy),
  );
  const forfeitedLaborCostJpy = totalLaborCostJpy - paidLaborCostJpy;
  const netBuybackPoolJpy = balanceAfterInfraJpy - paidLaborCostJpy;
  assertSafeInteger("netBuybackPoolJpy", netBuybackPoolJpy);

  const allocations = allocatePoolByPublicViews({
    netBuybackPoolJpy,
    gameViewInputs: input.gameViewInputs,
    confirmedEntryCount: input.confirmedEntryCount,
  });

  const totalMaxAffordableKeys = allocations.reduce(
    (acc, a) => acc + a.maxAffordableKeys,
    0,
  );
  const totalKeysPurchased = allocations.reduce(
    (acc, a) => acc + a.keysPurchased,
    0,
  );
  const totalSpentOnKeysJpy = allocations.reduce(
    (acc, a) => acc + a.spentJpy,
    0,
  );
  const carryOverToNextJpy = netBuybackPoolJpy - totalSpentOnKeysJpy;

  const conservationDiff =
    input.carryOverFromPrevJpy +
    input.grossAdRevenueJpy -
    totalInfraCostJpy -
    paidLaborCostJpy -
    totalSpentOnKeysJpy -
    carryOverToNextJpy;

  if (conservationDiff !== 0) {
    throw new InvariantViolationError(
      "error.invariant.conservation_law_broken",
      { diffJpy: conservationDiff },
    );
  }

  return {
    totalInfraCostJpy,
    totalLaborCostJpy,
    paidLaborCostJpy,
    forfeitedLaborCostJpy,
    ownerProfitJpy: 0,
    netBuybackPoolJpy,
    allocations,
    totalMaxAffordableKeys,
    totalKeysPurchased,
    totalSpentOnKeysJpy,
    carryOverToNextJpy,
  };
}

/**
 * Audits a settled MonthlySettlement record against the money conservation equation
 * AND all 5 cross-record invariants across allocations, videos, keys, and entries.
 */
export function verifySettlementInvariants(ctx: SettlementAuditContext): void {
  const {
    settlement,
    previousSettlement,
    games,
    allocations,
    monthVideos,
    steamKeys,
    entries,
  } = ctx;
  const drandConfig = ctx.drandConfig ?? DRAND_QUICKNET_CONFIG;
  const constants = ctx.publicConstants ?? PUBLIC_CONSTANTS;
  const priorRawHashes =
    ctx.priorMonthsBilledRawFootageHashes ?? new Set<string>();

  // Iron Rule 1: Owner profit must strictly be 0 JPY
  if (settlement.ownerProfitJpy !== 0) {
    throw new InvariantViolationError("error.invariant.owner_profit_nonzero", {
      ownerProfitJpy: settlement.ownerProfitJpy,
    });
  }

  // Build game lookup & validate Cross-Record Invariant 5 on all provided games
  const gameById = new Map<number, TargetGameSnapshot>();
  for (const g of games) {
    validateTargetGameEligible(g);
    gameById.set(g.id, g);
  }

  // Cross-Record Invariant 1-A: Month-to-month carry-over continuity
  const expectedCarryOverIn = previousSettlement
    ? previousSettlement.carryOverToNextJpy
    : 0;
  if (settlement.carryOverFromPrevJpy !== expectedCarryOverIn) {
    throw new InvariantViolationError(
      "error.invariant.carry_over_discontinuity",
      {
        actualJpy: settlement.carryOverFromPrevJpy,
        expectedJpy: expectedCarryOverIn,
      },
    );
  }

  // Cross-Record Invariant 1-B & 5: Audit every video in monthVideos
  const videoGenCosts: string[] = [];
  const recordingGameCosts: number[] = [];
  const playLaborCosts: string[] = [];
  const reviewLaborCosts: string[] = [];
  const viewsByGameId = new Map<number, bigint>();
  const humanPlayCountByGameId = new Map<number, number>();
  const seenYoutubeVideoIds = new Set<string>();
  const seenBilledRawHashes = new Set<string>(priorRawHashes);
  const seenBilledRecordingCostGameIds = new Set<number>(
    ctx.priorMonthsBilledRecordingCostGameIds ?? [],
  );

  for (const video of monthVideos) {
    const videoMonth = getYearMonthInJst(video.publishedAt);
    if (videoMonth !== settlement.yearMonth) {
      throw new InvariantViolationError(
        "error.invariant.video_month_mismatch",
        {
          videoId: video.id,
          videoMonth,
          settlementMonth: settlement.yearMonth,
        },
      );
    }

    const videoGame = gameById.get(video.gameId);
    if (!videoGame) {
      throw new InvariantViolationError(
        "error.invariant.allocation_game_set_mismatch",
      );
    }
    validateTargetGameEligible(videoGame);

    const trimmedYtId = video.youtubeVideoId?.trim() ?? "";
    if (
      trimmedYtId.length === 0 ||
      seenYoutubeVideoIds.has(trimmedYtId) ||
      video.contentIdStatus === "RESTRICTED" ||
      (video.isSyntheticContent && !video.aiDisclosureSet) ||
      (!video.isSyntheticContent && video.aiDisclosureSet)
    ) {
      throw new InvariantViolationError(
        "error.invariant.video_not_public_eligible",
        { videoId: video.id },
      );
    }
    seenYoutubeVideoIds.add(trimmedYtId);

    if (video.viewCountSnapshot === null || video.viewCountSnapshot < 0n) {
      throw new InvariantViolationError(
        "error.invariant.video_view_snapshot_missing",
        { videoId: video.id },
      );
    }
    viewsByGameId.set(
      video.gameId,
      (viewsByGameId.get(video.gameId) ?? 0n) + video.viewCountSnapshot,
    );

    // Verify AI generation cost arithmetic (supports LLM synthetic, non-LLM synthetic, and human stream)
    const llmSen = parseDecimalJpyToSen(video.llmCostDecimalJpy);
    const ttsSen = parseDecimalJpyToSen(video.ttsCostDecimalJpy);
    const compSen = parseDecimalJpyToSen(video.computeCostDecimalJpy);
    const totalGenSen = parseDecimalJpyToSen(
      video.totalGenerationCostDecimalJpy,
    );

    if (video.llmModelName === null) {
      if (
        video.inputTokens !== 0 ||
        video.outputTokens !== 0 ||
        llmSen !== 0n ||
        (!video.isSyntheticContent &&
          (ttsSen !== 0n || compSen !== 0n || totalGenSen !== 0n))
      ) {
        throw new InvariantViolationError("error.import.llm_cost_mismatch", {
          reportedJpy: video.totalGenerationCostDecimalJpy,
          expectedJpy: "0.00",
        });
      }
    } else {
      if (!video.isSyntheticContent) {
        throw new InvariantViolationError(
          "error.invariant.video_not_public_eligible",
          { videoId: video.id },
        );
      }
      const expectedLlmSen = computeLlmCostSenFromTokens({
        inputTokens: video.inputTokens,
        outputTokens: video.outputTokens,
        inputRateUsdPer1M: video.inputRateUsdPer1M,
        outputRateUsdPer1M: video.outputRateUsdPer1M,
        usdJpyRate: video.usdJpyRate,
      });
      if (llmSen !== expectedLlmSen) {
        throw new InvariantViolationError("error.import.llm_cost_mismatch", {
          reportedJpy: video.llmCostDecimalJpy,
          expectedJpy: formatSenToDecimalJpy(expectedLlmSen),
        });
      }
    }

    if (totalGenSen !== llmSen + ttsSen + compSen) {
      throw new InvariantViolationError("error.import.llm_cost_mismatch", {
        reportedJpy: video.totalGenerationCostDecimalJpy,
        expectedJpy: formatSenToDecimalJpy(llmSen + ttsSen + compSen),
      });
    }

    // Verify recording software acquisition cost (at most once per game across all time)
    if (video.recordingGameCostJpy < 0) {
      throw new InvariantViolationError(
        "error.invariant.video_recording_cost_invalid",
        { videoId: video.id },
      );
    }
    if (video.recordingGameCostJpy > 0) {
      if (
        !video.recordingGameReceiptUrl ||
        video.recordingGameReceiptUrl.trim().length === 0 ||
        video.footageSource !== "HUMAN_PLAY" ||
        seenBilledRecordingCostGameIds.has(video.gameId)
      ) {
        throw new InvariantViolationError(
          "error.invariant.video_recording_cost_invalid",
          { videoId: video.id },
        );
      }
      seenBilledRecordingCostGameIds.add(video.gameId);
    }

    // Verify fixed-minute regional review labor (allowing historical standard minutes & rates)
    if (
      !isAllowedHistoricalReviewMinutes(video.reviewMinutes, constants) ||
      !isAllowedHistoricalRegionalLaborRateJpy(
        video.reviewRegionCode,
        video.reviewLaborRateJpyPerHour,
        constants,
      ) ||
      parseDecimalJpyToSen(video.reviewLaborCostDecimalJpy) !==
        computeFixedMinutesLaborCostSen(
          video.reviewMinutes,
          video.reviewLaborRateJpyPerHour,
        )
    ) {
      throw new InvariantViolationError("error.invariant.video_labor_invalid", {
        videoId: video.id,
      });
    }

    // Verify fixed-minute regional play labor & uniqueness per (month, gameId) and rawFootageSha256
    const playSen = parseDecimalJpyToSen(video.playLaborCostDecimalJpy);
    if (video.footageSource === "HUMAN_PLAY") {
      const prevPlayCount = humanPlayCountByGameId.get(video.gameId) ?? 0;
      if (
        prevPlayCount > 0 ||
        !isAllowedHistoricalPlayMinutes(video.playMinutes, constants) ||
        !isAllowedHistoricalRegionalLaborRateJpy(
          video.playRegionCode,
          video.playLaborRateJpyPerHour,
          constants,
        ) ||
        playSen !==
          computeFixedMinutesLaborCostSen(
            video.playMinutes,
            video.playLaborRateJpyPerHour,
          )
      ) {
        throw new InvariantViolationError(
          "error.invariant.video_labor_invalid",
          { videoId: video.id },
        );
      }
      if (video.rawFootageSha256) {
        const normalizedHash = video.rawFootageSha256.trim().toLowerCase();
        if (seenBilledRawHashes.has(normalizedHash)) {
          throw new InvariantViolationError(
            "error.invariant.video_labor_invalid",
            { videoId: video.id },
          );
        }
        seenBilledRawHashes.add(normalizedHash);
      }
      humanPlayCountByGameId.set(video.gameId, prevPlayCount + 1);
    } else if (
      video.playMinutes !== 0 ||
      video.playLaborRateJpyPerHour !== 0 ||
      playSen !== 0n
    ) {
      throw new InvariantViolationError("error.invariant.video_labor_invalid", {
        videoId: video.id,
      });
    }

    videoGenCosts.push(video.totalGenerationCostDecimalJpy);
    recordingGameCosts.push(video.recordingGameCostJpy);
    playLaborCosts.push(video.playLaborCostDecimalJpy);
    reviewLaborCosts.push(video.reviewLaborCostDecimalJpy);
  }

  // Verify allocation game set matches monthVideos game set 1-to-1
  if (allocations.length !== viewsByGameId.size) {
    throw new InvariantViolationError(
      "error.invariant.allocation_game_set_mismatch",
    );
  }

  const gameViewInputs: GameViewAllocationInput[] = [];
  for (const [gameId, viewSum] of viewsByGameId.entries()) {
    const game = gameById.get(gameId);
    if (!game) {
      throw new InvariantViolationError(
        "error.invariant.allocation_game_set_mismatch",
      );
    }
    gameViewInputs.push({ game, publicViewCount: viewSum });
  }

  // Recompute full monthly settlement & cross-row allocation math
  const recomputed = calculateMonthlySettlement({
    carryOverFromPrevJpy: settlement.carryOverFromPrevJpy,
    grossAdRevenueJpy: settlement.grossAdRevenueJpy,
    videoGenerationCostsDecimalJpy: videoGenCosts,
    recordingGameCostsJpy: recordingGameCosts,
    webHostingCostJpy: settlement.webHostingCostJpy,
    videoPlayLaborCostsDecimalJpy: playLaborCosts,
    videoReviewLaborCostsDecimalJpy: reviewLaborCosts,
    gameViewInputs,
    confirmedEntryCount: entries.length,
    ownerProfitJpy: settlement.ownerProfitJpy,
  });

  if (settlement.totalInfraCostJpy !== recomputed.totalInfraCostJpy) {
    throw new InvariantViolationError("error.invariant.infra_cost_mismatch", {
      expectedJpy: recomputed.totalInfraCostJpy,
      actualJpy: settlement.totalInfraCostJpy,
    });
  }
  if (settlement.totalLaborCostJpy !== recomputed.totalLaborCostJpy) {
    throw new InvariantViolationError("error.invariant.labor_cost_mismatch", {
      expectedJpy: recomputed.totalLaborCostJpy,
      actualJpy: settlement.totalLaborCostJpy,
    });
  }
  if (settlement.paidLaborCostJpy !== recomputed.paidLaborCostJpy) {
    throw new InvariantViolationError("error.invariant.paid_labor_mismatch", {
      actualJpy: settlement.paidLaborCostJpy,
      expectedJpy: recomputed.paidLaborCostJpy,
    });
  }
  if (settlement.netBuybackPoolJpy !== recomputed.netBuybackPoolJpy) {
    throw new InvariantViolationError(
      "error.invariant.conservation_law_broken",
      {
        diffJpy: settlement.netBuybackPoolJpy - recomputed.netBuybackPoolJpy,
      },
    );
  }

  // Explicit direct cap check (M1 review enhancement)
  const expectedTotalKeysCapped = Math.min(
    recomputed.totalMaxAffordableKeys,
    entries.length,
  );
  if (settlement.totalKeysPurchased !== expectedTotalKeysCapped) {
    throw new InvariantViolationError(
      "error.invariant.total_keys_cap_mismatch",
      {
        actual: settlement.totalKeysPurchased,
        expected: expectedTotalKeysCapped,
      },
    );
  }

  const conservationDiff =
    settlement.carryOverFromPrevJpy +
    settlement.grossAdRevenueJpy -
    settlement.totalInfraCostJpy -
    settlement.paidLaborCostJpy -
    settlement.totalSpentOnKeysJpy -
    settlement.carryOverToNextJpy;
  if (
    conservationDiff !== 0 ||
    settlement.carryOverToNextJpy !== recomputed.carryOverToNextJpy
  ) {
    throw new InvariantViolationError(
      "error.invariant.conservation_law_broken",
      {
        diffJpy:
          conservationDiff !== 0
            ? conservationDiff
            : settlement.carryOverToNextJpy - recomputed.carryOverToNextJpy,
      },
    );
  }

  // Verify every SettlementGameAllocation row & cross-row sums
  const recomputedByGameId = new Map<number, ComputedGameAllocation>(
    recomputed.allocations.map((a) => [a.gameId, a]),
  );
  const allocationById = new Map<number, AllocationAuditRecord>();
  let sumAllocatedBudgetJpy = 0;
  let sumAllocationKeys = 0;
  let sumAllocationSpentJpy = 0;

  for (const alloc of allocations) {
    if (alloc.settlementId !== settlement.id) {
      throw new InvariantViolationError(
        "error.invariant.allocation_game_set_mismatch",
      );
    }
    const allocGame = gameById.get(alloc.gameId);
    if (!allocGame) {
      throw new InvariantViolationError(
        "error.invariant.allocation_game_set_mismatch",
      );
    }
    // Cross-Record Invariant 5 per allocation
    validateTargetGameEligible(allocGame);

    const expectedAlloc = recomputedByGameId.get(alloc.gameId);
    if (!expectedAlloc || allocationById.has(alloc.id)) {
      throw new InvariantViolationError(
        "error.invariant.allocation_game_set_mismatch",
      );
    }

    if (
      alloc.publicViewCount !== expectedAlloc.publicViewCount ||
      alloc.unitRetailPriceJpy !== expectedAlloc.unitRetailPriceJpy ||
      alloc.allocatedBudgetJpy !== expectedAlloc.allocatedBudgetJpy ||
      alloc.keysPurchased !== expectedAlloc.keysPurchased ||
      alloc.spentJpy !== expectedAlloc.spentJpy ||
      alloc.remainderJpy !== expectedAlloc.remainderJpy ||
      alloc.spentJpy + alloc.remainderJpy !== alloc.allocatedBudgetJpy
    ) {
      throw new InvariantViolationError(
        "error.invariant.allocation_math_mismatch",
        { gameId: alloc.gameId },
      );
    }

    allocationById.set(alloc.id, alloc);
    sumAllocatedBudgetJpy += alloc.allocatedBudgetJpy;
    sumAllocationKeys += alloc.keysPurchased;
    sumAllocationSpentJpy += alloc.spentJpy;
  }

  const totalViewsAcrossMonth = [...viewsByGameId.values()].reduce(
    (acc, v) => acc + v,
    0n,
  );
  const expectedSumAllocated =
    settlement.netBuybackPoolJpy > 0 && totalViewsAcrossMonth > 0n
      ? settlement.netBuybackPoolJpy
      : 0;

  if (
    sumAllocatedBudgetJpy !== expectedSumAllocated ||
    sumAllocationKeys !== settlement.totalKeysPurchased ||
    sumAllocationSpentJpy !== settlement.totalSpentOnKeysJpy
  ) {
    throw new InvariantViolationError(
      "error.invariant.conservation_law_broken",
      {
        diffJpy:
          sumAllocatedBudgetJpy !== expectedSumAllocated
            ? sumAllocatedBudgetJpy - expectedSumAllocated
            : sumAllocationSpentJpy - settlement.totalSpentOnKeysJpy,
      },
    );
  }

  // Cross-Record Invariant 4: drand pre-committed round & chain re-derivation
  if (settlement.drandChainHash !== drandConfig.chainHash) {
    throw new InvariantViolationError("error.invariant.drand_chain_mismatch");
  }
  const expectedDrandRound = deriveTargetDrandRound(
    settlement.entryCutoffAt,
    drandConfig,
  );
  if (settlement.committedDrandRound !== expectedDrandRound) {
    throw new InvariantViolationError("error.invariant.drand_round_mismatch", {
      actualRound: settlement.committedDrandRound.toString(),
      expectedRound: expectedDrandRound.toString(),
    });
  }

  // Cross-Record Invariant 2: Per-allocation SteamKeyInventory gameId, unit price, count & spend
  const distributedKeysByAllocId = new Map<number, SteamKeyAuditRecord[]>();
  const allDistributedKeys: SteamKeyAuditRecord[] = [];
  let totalDistributedInventorySpendJpy = 0;

  for (const key of steamKeys) {
    const parentAlloc = allocationById.get(key.allocationId);
    if (
      !parentAlloc ||
      key.settlementId !== parentAlloc.settlementId ||
      key.settlementId !== settlement.id ||
      key.gameId !== parentAlloc.gameId
    ) {
      throw new InvariantViolationError(
        "error.invariant.inventory_game_mismatch",
        {
          keyId: key.id,
          keyGameId: key.gameId,
          targetGameId: parentAlloc?.gameId ?? 0,
        },
      );
    }
    if (key.purchasePriceJpy !== parentAlloc.unitRetailPriceJpy) {
      throw new InvariantViolationError(
        "error.invariant.inventory_price_mismatch",
        {
          keyId: key.id,
          purchasePriceJpy: key.purchasePriceJpy,
          unitPriceJpy: parentAlloc.unitRetailPriceJpy,
        },
      );
    }
    if (key.isDistributed) {
      const list = distributedKeysByAllocId.get(parentAlloc.id) ?? [];
      list.push(key);
      distributedKeysByAllocId.set(parentAlloc.id, list);
      allDistributedKeys.push(key);
      totalDistributedInventorySpendJpy += key.purchasePriceJpy;
    }
  }

  for (const alloc of allocations) {
    const distKeys = distributedKeysByAllocId.get(alloc.id) ?? [];
    const allocInventorySpend = distKeys.reduce(
      (acc, k) => acc + k.purchasePriceJpy,
      0,
    );
    if (
      distKeys.length !== alloc.keysPurchased ||
      allocInventorySpend !== alloc.spentJpy
    ) {
      throw new InvariantViolationError("error.invariant.spent_amount_mismatch", {
        totalSpentOnKeysJpy: alloc.spentJpy,
        inventorySumJpy: allocInventorySpend,
      });
    }
  }

  if (settlement.totalSpentOnKeysJpy !== totalDistributedInventorySpendJpy) {
    throw new InvariantViolationError("error.invariant.spent_amount_mismatch", {
      totalSpentOnKeysJpy: settlement.totalSpentOnKeysJpy,
      inventorySumJpy: totalDistributedInventorySpendJpy,
    });
  }

  // Cross-Record Invariant 3: Cutoff, snapshot hash, fair draw & (gameId ASC, key.id ASC) 1-to-1 assignment
  const cutoffMs = settlement.entryCutoffAt.getTime();
  const entryById = new Map<number, LotteryEntryAuditRecord>();
  const entryIds: number[] = [];
  let winnerCount = 0;

  for (const entry of entries) {
    if (entry.settlementId !== settlement.id) {
      throw new InvariantViolationError(
        "error.invariant.winner_key_assignment_invalid",
      );
    }
    if (entry.createdAt.getTime() > cutoffMs) {
      throw new InvariantViolationError("error.invariant.entry_after_cutoff", {
        entryId: entry.id,
      });
    }
    entryById.set(entry.id, entry);
    entryIds.push(entry.id);
    if (entry.isWinner) {
      winnerCount += 1;
    }
  }

  if (winnerCount !== settlement.totalKeysPurchased) {
    throw new InvariantViolationError(
      "error.invariant.winner_count_mismatch",
      {
        totalKeysPurchased: settlement.totalKeysPurchased,
        winnerCount,
      },
    );
  }

  const expectedSnapshotHash = computeEntriesSnapshotHash(entryIds);
  if (settlement.entriesSnapshotHash !== expectedSnapshotHash) {
    throw new InvariantViolationError(
      "error.invariant.snapshot_hash_mismatch",
    );
  }

  if (!settlement.publicRandomSeed) {
    throw new DomainValidationError("error.validation.invalid_random_seed");
  }

  const recomputedDraw = executeFairDraw({
    publicRandomSeed: settlement.publicRandomSeed,
    entryIds,
    maxAffordableKeys: recomputed.totalMaxAffordableKeys,
  });

  if (recomputedDraw.winnerEntryIds.length !== settlement.totalKeysPurchased) {
    throw new InvariantViolationError("error.invariant.fair_draw_mismatch");
  }

  const sortedDistributedKeys = [...allDistributedKeys].sort((a, b) => {
    if (a.gameId !== b.gameId) {
      return a.gameId - b.gameId;
    }
    return a.id - b.id;
  });

  const winnerIdSet = new Set<number>(recomputedDraw.winnerEntryIds);
  for (const [rankIdx, winnerEntryId] of recomputedDraw.winnerEntryIds.entries()) {
    const entry = entryById.get(winnerEntryId);
    const expectedKey = sortedDistributedKeys[rankIdx];
    if (
      !entry ||
      !expectedKey ||
      !entry.isWinner ||
      entry.wonSteamKeyId !== expectedKey.id
    ) {
      throw new InvariantViolationError(
        entry && !entry.isWinner
          ? "error.invariant.fair_draw_mismatch"
          : "error.invariant.winner_key_assignment_invalid",
      );
    }
  }

  for (const entry of entries) {
    if (!winnerIdSet.has(entry.id)) {
      if (entry.isWinner || entry.wonSteamKeyId !== null) {
        throw new InvariantViolationError(
          "error.invariant.winner_key_assignment_invalid",
        );
      }
    }
  }
}
