import { z } from "zod";
import {
  PUBLIC_CONSTANTS,
  type PublicConstantsConfig,
  resolveActiveRegionalLaborRateJpy,
} from "@/domain/constants";
import { DomainValidationError, InvariantViolationError } from "@/domain/errors";
import {
  type LedgerContentIdStatus,
  type LedgerFootageSource,
  type TargetGameSnapshot,
  computeFixedMinutesLaborCostSen,
  computeLlmCostSenFromTokens,
  formatSenToDecimalJpy,
  getYearMonthInJst,
  parseDecimalJpyToSen,
  parseDecimalRate4ToUnits,
  validateTargetGameEligible,
} from "@/domain/settlement";
import { createTranslator, resolveLocale } from "@/i18n";
import type { Logger } from "@/lib/logger";

const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{6,32}$/;
const SHA256_HEX_REGEX = /^[0-9a-fA-F]{64}$/;
const HTTP_URL_REGEX = /^https?:\/\/\S+$/;

export const EngineVideoCostReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    steamAppId: z.string().trim().min(1).max(64),
    videoTitle: z.string().trim().min(1).max(191),
    generatedAt: z.string().datetime({ offset: true }),
    isSyntheticContent: z.boolean(),
    aiGeneration: z
      .object({
        llmModelName: z.string().trim().min(1).max(191).nullable(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        inputRateUsdPer1M: z.string().trim(),
        outputRateUsdPer1M: z.string().trim(),
        usdJpyRate: z.string().trim(),
        llmCostJpy: z.string().trim(),
        ttsCostJpy: z.string().trim(),
        computeCostJpy: z.string().trim(),
        totalGenerationCostJpy: z.string().trim(),
      })
      .strict(),
    recordingAcquisition: z
      .object({
        recordingGameCostJpy: z.number().int().nonnegative(),
        recordingGameReceiptUrl: z.string().trim().max(191).nullable(),
      })
      .strict(),
    footage: z
      .object({
        footageSource: z.enum(["HUMAN_PLAY", "SECONDARY_CLIP", "BOT_PLAY"]),
        rawFootageSha256: z
          .string()
          .trim()
          .regex(SHA256_HEX_REGEX)
          .nullable(),
        rawFootageSec: z.number().int().nonnegative(),
        playRegionCode: z.string().trim().min(2).max(16),
      })
      .strict(),
  })
  .strict();

export type EngineVideoCostReport = z.infer<typeof EngineVideoCostReportSchema>;

export interface PostUploadMetadataInput {
  readonly youtubeVideoId: string;
  readonly publishedAt: Date;
  readonly reviewRegionCode: string;
  readonly contentIdStatus: LedgerContentIdStatus;
  readonly aiDisclosureAck: boolean;
}

export interface EngineFileImportRequest {
  readonly mode: "engine_file";
  readonly rawReport: unknown;
  readonly postUpload: PostUploadMetadataInput;
  readonly overridePlayRegionCode?: string | undefined;
}

export interface HumanStreamImportRequest {
  readonly mode: "human_stream";
  readonly steamAppId: string;
  readonly videoTitle: string;
  readonly playRegionCode: string;
  readonly postUpload: PostUploadMetadataInput;
  readonly footageSource?: LedgerFootageSource | undefined;
  readonly rawFootageSha256?: string | null | undefined;
  readonly rawFootageSec?: number | undefined;
  readonly recordingGameCostJpy?: number | undefined;
  readonly recordingGameReceiptUrl?: string | null | undefined;
}

export type VideoCostImportRequest =
  | EngineFileImportRequest
  | HumanStreamImportRequest;

export interface NewVideoCostLedgerRow {
  readonly youtubeVideoId: string;
  readonly title: string;
  readonly gameId: number;
  readonly isSyntheticContent: boolean;
  readonly llmModelName: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly inputRateUsdPer1M: string;
  readonly outputRateUsdPer1M: string;
  readonly usdJpyRate: string;
  readonly llmCostJpy: string;
  readonly ttsCostJpy: string;
  readonly computeCostJpy: string;
  readonly totalGenerationCost: string;
  readonly recordingGameCostJpy: number;
  readonly recordingGameReceiptUrl: string | null;
  readonly footageSource: LedgerFootageSource;
  readonly rawFootageSha256: string | null;
  readonly rawFootageSec: number;
  readonly playRegionCode: string;
  readonly playMinutes: number;
  readonly playLaborRateJpyPerHour: number;
  readonly playLaborCostJpy: string;
  readonly reviewRegionCode: string;
  readonly reviewMinutes: number;
  readonly reviewLaborRateJpyPerHour: number;
  readonly reviewLaborCostJpy: string;
  readonly aiDisclosureSet: boolean;
  readonly contentIdStatus: LedgerContentIdStatus;
  readonly publishedAt: Date;
}

export interface CreatedVideoCostLedgerSummary {
  readonly id: number;
  readonly youtubeVideoId: string;
  readonly yearMonth: string;
  readonly gameId: number;
  readonly isSyntheticContent: boolean;
  readonly aiDisclosureSet: boolean;
  readonly footageSource: LedgerFootageSource;
  readonly normalizedToSecondaryClip: boolean;
  readonly totalGenerationCostJpy: string;
  readonly recordingGameCostJpy: number;
  readonly playMinutes: number;
  readonly playLaborCostJpy: string;
  readonly reviewMinutes: number;
  readonly reviewLaborCostJpy: string;
}

export interface VideoCostImportRepositoryPort {
  findGameBySteamAppId(
    steamAppId: string,
  ): Promise<(TargetGameSnapshot & { readonly steamAppId: string }) | null>;
  findSettlementStateByYearMonth(
    yearMonth: string,
  ): Promise<{ readonly isSettled: boolean } | null>;
  existsByYoutubeVideoId(youtubeVideoId: string): Promise<boolean>;
  hasBilledPlayLaborForFootageHash(rawFootageSha256: string): Promise<boolean>;
  hasBilledPlayLaborForGameInMonth(params: {
    readonly gameId: number;
    readonly startUtc: Date;
    readonly endExclusiveUtc: Date;
  }): Promise<boolean>;
  hasRecordingGameCostForGame(gameId: number): Promise<boolean>;
  insertVideoCostLedger(
    row: NewVideoCostLedgerRow,
  ): Promise<{ readonly id: number }>;
}

export interface VideoCostImportDependencies {
  readonly repo: VideoCostImportRepositoryPort;
  readonly logger: Logger;
  readonly publicConstants?: PublicConstantsConfig | undefined;
  readonly localeRaw?: string | undefined;
}

/**
 * Returns the exact half-open UTC range [startUtc, endExclusiveUtc) corresponding
 * to a "YYYY-MM" calendar month in Asia/Tokyo (UTC+09:00).
 */
export function getJstMonthUtcRange(yearMonth: string): {
  readonly startUtc: Date;
  readonly endExclusiveUtc: Date;
} {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(yearMonth.trim());
  if (!match) {
    throw new DomainValidationError("error.validation.invalid_date", {
      field: "yearMonth",
    });
  }
  const year = Number(match[1]);
  const monthIndex0 = Number(match[2]) - 1;
  const jstOffsetMs = 9 * 60 * 60 * 1000;

  const startUtc = new Date(Date.UTC(year, monthIndex0, 1, 0, 0, 0, 0) - jstOffsetMs);
  const endExclusiveUtc = new Date(
    Date.UTC(year, monthIndex0 + 1, 1, 0, 0, 0, 0) - jstOffsetMs,
  );
  return { startUtc, endExclusiveUtc };
}

function validateYoutubeVideoId(rawId: string): string {
  const trimmed = rawId.trim();
  if (!YOUTUBE_VIDEO_ID_REGEX.test(trimmed)) {
    throw new DomainValidationError("error.validation.invalid_youtube_video_id", {
      youtubeVideoId: rawId,
    });
  }
  return trimmed;
}

function normalizeOptionalReceiptUrl(
  rawUrl: string | null | undefined,
  costJpy: number,
): string | null {
  if (rawUrl === null || rawUrl === undefined || rawUrl.trim().length === 0) {
    if (costJpy > 0) {
      throw new InvariantViolationError(
        "error.import.recording_receipt_required",
        { costJpy },
      );
    }
    return null;
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > 191 || !HTTP_URL_REGEX.test(trimmed)) {
    throw new InvariantViolationError(
      "error.import.recording_receipt_required",
      { costJpy },
    );
  }
  return trimmed;
}

/**
 * Validates and imports a published video's cost & fixed-minute labor record into VideoCostLedger.
 * Supports both immutable JSON output from `zerocut-engine` (`mode: "engine_file"`)
 * and engine-less human streamer registration (`mode: "human_stream"`).
 */
export async function importVideoCostRecord(
  request: VideoCostImportRequest,
  deps: VideoCostImportDependencies,
): Promise<CreatedVideoCostLedgerSummary> {
  const { repo, logger } = deps;
  const constants = deps.publicConstants ?? PUBLIC_CONSTANTS;
  const translator = createTranslator(resolveLocale(deps.localeRaw));

  // 1. Validate common post-upload CLI parameters
  const youtubeVideoId = validateYoutubeVideoId(
    request.postUpload.youtubeVideoId,
  );
  if (Number.isNaN(request.postUpload.publishedAt.getTime())) {
    throw new DomainValidationError("error.validation.invalid_date", {
      field: "publishedAt",
    });
  }
  if (request.postUpload.contentIdStatus === "RESTRICTED") {
    throw new InvariantViolationError("error.import.restricted_video_rejected");
  }

  const reviewRegionCode = request.postUpload.reviewRegionCode
    .trim()
    .toUpperCase();
  const reviewLaborRateJpyPerHour = resolveActiveRegionalLaborRateJpy(
    reviewRegionCode,
    constants,
  );
  const reviewMinutes = constants.reviewMinutesPerVideo;
  const reviewLaborCostJpy = formatSenToDecimalJpy(
    computeFixedMinutesLaborCostSen(reviewMinutes, reviewLaborRateJpyPerHour),
  );

  // 2. Normalize mode-specific fields & verify exact AI generation cost math
  let steamAppId: string;
  let videoTitle: string;
  let isSyntheticContent: boolean;
  let llmModelName: string | null;
  let inputTokens: number;
  let outputTokens: number;
  let inputRateUsdPer1M: string;
  let outputRateUsdPer1M: string;
  let usdJpyRate: string;
  let llmCostJpy: string;
  let ttsCostJpy: string;
  let computeCostJpy: string;
  let totalGenerationCost: string;
  let recordingGameCostJpy: number;
  let recordingGameReceiptUrl: string | null;
  let requestedFootageSource: LedgerFootageSource;
  let normalizedRawFootageSha256: string | null;
  let rawFootageSec: number;
  let requestedPlayRegionCode: string;

  if (request.mode === "engine_file") {
    const parsedResult = EngineVideoCostReportSchema.safeParse(
      request.rawReport,
    );
    if (!parsedResult.success) {
      const reason = parsedResult.error.issues
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
        .join("; ");
      throw new DomainValidationError("error.validation.invalid_json_report", {
        reason,
      });
    }
    const report = parsedResult.data;

    if (report.isSyntheticContent && !request.postUpload.aiDisclosureAck) {
      throw new InvariantViolationError("error.import.ai_disclosure_required");
    }

    // Validate rates & exact BigInt sen arithmetic
    parseDecimalRate4ToUnits(report.aiGeneration.inputRateUsdPer1M);
    parseDecimalRate4ToUnits(report.aiGeneration.outputRateUsdPer1M);
    parseDecimalRate4ToUnits(report.aiGeneration.usdJpyRate);

    const llmSen = parseDecimalJpyToSen(report.aiGeneration.llmCostJpy);
    const ttsSen = parseDecimalJpyToSen(report.aiGeneration.ttsCostJpy);
    const compSen = parseDecimalJpyToSen(report.aiGeneration.computeCostJpy);
    const totalGenSen = parseDecimalJpyToSen(
      report.aiGeneration.totalGenerationCostJpy,
    );

    if (report.aiGeneration.llmModelName === null) {
      if (
        report.aiGeneration.inputTokens !== 0 ||
        report.aiGeneration.outputTokens !== 0 ||
        llmSen !== 0n ||
        (!report.isSyntheticContent &&
          (ttsSen !== 0n || compSen !== 0n || totalGenSen !== 0n))
      ) {
        throw new InvariantViolationError("error.import.llm_cost_mismatch", {
          reportedJpy: report.aiGeneration.totalGenerationCostJpy,
          expectedJpy: "0.00",
        });
      }
    } else {
      if (!report.isSyntheticContent) {
        throw new InvariantViolationError("error.import.ai_disclosure_required");
      }
      const expectedLlmSen = computeLlmCostSenFromTokens({
        inputTokens: report.aiGeneration.inputTokens,
        outputTokens: report.aiGeneration.outputTokens,
        inputRateUsdPer1M: report.aiGeneration.inputRateUsdPer1M,
        outputRateUsdPer1M: report.aiGeneration.outputRateUsdPer1M,
        usdJpyRate: report.aiGeneration.usdJpyRate,
      });
      if (llmSen !== expectedLlmSen) {
        throw new InvariantViolationError("error.import.llm_cost_mismatch", {
          reportedJpy: report.aiGeneration.llmCostJpy,
          expectedJpy: formatSenToDecimalJpy(expectedLlmSen),
        });
      }
    }

    const expectedTotalGenSen = llmSen + ttsSen + compSen;
    if (totalGenSen !== expectedTotalGenSen) {
      throw new InvariantViolationError("error.import.llm_cost_mismatch", {
        reportedJpy: report.aiGeneration.totalGenerationCostJpy,
        expectedJpy: formatSenToDecimalJpy(expectedTotalGenSen),
      });
    }

    if (
      report.footage.footageSource === "HUMAN_PLAY" &&
      report.footage.rawFootageSha256 === null
    ) {
      throw new DomainValidationError("error.validation.invalid_json_report", {
        reason:
          "footage.rawFootageSha256 is required when footageSource is HUMAN_PLAY",
      });
    }

    steamAppId = report.steamAppId;
    videoTitle = report.videoTitle;
    isSyntheticContent = report.isSyntheticContent;
    llmModelName = report.aiGeneration.llmModelName;
    inputTokens = report.aiGeneration.inputTokens;
    outputTokens = report.aiGeneration.outputTokens;
    inputRateUsdPer1M = report.aiGeneration.inputRateUsdPer1M;
    outputRateUsdPer1M = report.aiGeneration.outputRateUsdPer1M;
    usdJpyRate = report.aiGeneration.usdJpyRate;
    llmCostJpy = formatSenToDecimalJpy(llmSen);
    ttsCostJpy = formatSenToDecimalJpy(ttsSen);
    computeCostJpy = formatSenToDecimalJpy(compSen);
    totalGenerationCost = formatSenToDecimalJpy(totalGenSen);
    recordingGameCostJpy = report.recordingAcquisition.recordingGameCostJpy;
    recordingGameReceiptUrl = normalizeOptionalReceiptUrl(
      report.recordingAcquisition.recordingGameReceiptUrl,
      recordingGameCostJpy,
    );
    requestedFootageSource = report.footage.footageSource;
    normalizedRawFootageSha256 = report.footage.rawFootageSha256
      ? report.footage.rawFootageSha256.toLowerCase()
      : null;
    rawFootageSec = report.footage.rawFootageSec;
    requestedPlayRegionCode = (
      request.overridePlayRegionCode ?? report.footage.playRegionCode
    )
      .trim()
      .toUpperCase();
  } else {
    const trimmedAppId = request.steamAppId.trim();
    if (trimmedAppId.length === 0 || trimmedAppId.length > 64) {
      throw new DomainValidationError("error.validation.missing_cli_arg", {
        arg: "--steam-app-id",
      });
    }
    const trimmedTitle = request.videoTitle.trim();
    if (trimmedTitle.length === 0 || trimmedTitle.length > 191) {
      throw new DomainValidationError("error.validation.missing_cli_arg", {
        arg: "--title",
      });
    }

    const rawSha = request.rawFootageSha256?.trim() ?? "";
    if (rawSha.length > 0 && !SHA256_HEX_REGEX.test(rawSha)) {
      throw new DomainValidationError("error.validation.invalid_json_report", {
        reason: "Invalid --raw-footage-sha256 (expected 64 hex chars)",
      });
    }

    const recCost = request.recordingGameCostJpy ?? 0;
    if (!Number.isSafeInteger(recCost) || recCost < 0) {
      throw new DomainValidationError("error.validation.negative_not_allowed", {
        field: "recordingGameCostJpy",
        value: String(recCost),
      });
    }

    const footageSec = request.rawFootageSec ?? 0;
    if (!Number.isSafeInteger(footageSec) || footageSec < 0) {
      throw new DomainValidationError("error.validation.negative_not_allowed", {
        field: "rawFootageSec",
        value: String(footageSec),
      });
    }

    steamAppId = trimmedAppId;
    videoTitle = trimmedTitle;
    isSyntheticContent = false;
    llmModelName = null;
    inputTokens = 0;
    outputTokens = 0;
    inputRateUsdPer1M = "0.0000";
    outputRateUsdPer1M = "0.0000";
    usdJpyRate = "0.0000";
    llmCostJpy = "0.00";
    ttsCostJpy = "0.00";
    computeCostJpy = "0.00";
    totalGenerationCost = "0.00";
    recordingGameCostJpy = recCost;
    recordingGameReceiptUrl = normalizeOptionalReceiptUrl(
      request.recordingGameReceiptUrl,
      recCost,
    );
    requestedFootageSource = request.footageSource ?? "HUMAN_PLAY";
    normalizedRawFootageSha256 = rawSha.length > 0 ? rawSha.toLowerCase() : null;
    rawFootageSec = footageSec;
    requestedPlayRegionCode = request.playRegionCode.trim().toUpperCase();
  }

  // Validate playRegionCode against canonical public_constants.json up front
  const activePlayRateForRegion = resolveActiveRegionalLaborRateJpy(
    requestedPlayRegionCode,
    constants,
  );

  // 3. Cross-Record Check 1: Target IndieGame existence, approval, & Self-Dealing prohibition
  const game = await repo.findGameBySteamAppId(steamAppId);
  if (!game) {
    throw new InvariantViolationError("error.import.game_not_found", {
      steamAppId,
    });
  }
  validateTargetGameEligible(game);

  // 4. Cross-Record Check 2: Settled month lock (no retroactive backdating)
  const yearMonth = getYearMonthInJst(request.postUpload.publishedAt);
  const { startUtc, endExclusiveUtc } = getJstMonthUtcRange(yearMonth);
  const settlementState = await repo.findSettlementStateByYearMonth(yearMonth);
  if (settlementState?.isSettled) {
    throw new InvariantViolationError("error.import.month_already_settled", {
      yearMonth,
    });
  }

  // 5. Cross-Record Check 3: Duplicate youtubeVideoId check
  if (await repo.existsByYoutubeVideoId(youtubeVideoId)) {
    throw new InvariantViolationError(
      "error.import.duplicate_youtube_video_id",
      { youtubeVideoId },
    );
  }

  // 6. Cross-Record Check 4 & Normalization:
  // - Reject ONLY if rawFootageSha256 already claimed playMinutes > 0 (even across months)
  // - Auto-normalize 2nd+ video of same (yearMonth, gameId) to SECONDARY_CLIP / playMinutes = 0
  let effectiveFootageSource: LedgerFootageSource = requestedFootageSource;
  let playMinutes = 0;
  let playLaborRateJpyPerHour = 0;
  let playLaborCostJpy = "0.00";
  let normalizedToSecondaryClip = false;

  if (requestedFootageSource === "HUMAN_PLAY") {
    if (
      normalizedRawFootageSha256 !== null &&
      (await repo.hasBilledPlayLaborForFootageHash(normalizedRawFootageSha256))
    ) {
      throw new InvariantViolationError(
        "error.import.duplicate_raw_footage_labor",
        { rawFootageSha256: normalizedRawFootageSha256 },
      );
    }

    const alreadyBilledGameInMonth =
      await repo.hasBilledPlayLaborForGameInMonth({
        gameId: game.id,
        startUtc,
        endExclusiveUtc,
      });

    if (alreadyBilledGameInMonth) {
      effectiveFootageSource = "SECONDARY_CLIP";
      playMinutes = 0;
      playLaborRateJpyPerHour = 0;
      playLaborCostJpy = "0.00";
      normalizedToSecondaryClip = true;
      logger.info(
        translator.t("import.secondary_clip_normalized", { gameId: game.id }),
        {
          gameId: game.id,
          steamAppId,
          yearMonth,
          youtubeVideoId,
        },
      );
    } else {
      effectiveFootageSource = "HUMAN_PLAY";
      playMinutes = constants.playMinutesPerVideo;
      playLaborRateJpyPerHour = activePlayRateForRegion;
      playLaborCostJpy = formatSenToDecimalJpy(
        computeFixedMinutesLaborCostSen(playMinutes, playLaborRateJpyPerHour),
      );
    }
  }

  // 7. Cross-Record Check 5: Recording software purchase cost allowed at most once per game across all time
  if (recordingGameCostJpy > 0) {
    if (
      effectiveFootageSource !== "HUMAN_PLAY" ||
      recordingGameReceiptUrl === null ||
      (await repo.hasRecordingGameCostForGame(game.id))
    ) {
      throw new InvariantViolationError(
        "error.import.recording_receipt_required",
        { costJpy: recordingGameCostJpy },
      );
    }
  }

  // Non-synthetic (human streamer) entries always record aiDisclosureSet = false
  const aiDisclosureSet = isSyntheticContent;

  const inserted = await repo.insertVideoCostLedger({
    youtubeVideoId,
    title: videoTitle,
    gameId: game.id,
    isSyntheticContent,
    llmModelName,
    inputTokens,
    outputTokens,
    inputRateUsdPer1M,
    outputRateUsdPer1M,
    usdJpyRate,
    llmCostJpy,
    ttsCostJpy,
    computeCostJpy,
    totalGenerationCost,
    recordingGameCostJpy,
    recordingGameReceiptUrl,
    footageSource: effectiveFootageSource,
    rawFootageSha256: normalizedRawFootageSha256,
    rawFootageSec,
    playRegionCode: requestedPlayRegionCode,
    playMinutes,
    playLaborRateJpyPerHour,
    playLaborCostJpy,
    reviewRegionCode,
    reviewMinutes,
    reviewLaborRateJpyPerHour,
    reviewLaborCostJpy,
    aiDisclosureSet,
    contentIdStatus: request.postUpload.contentIdStatus,
    publishedAt: request.postUpload.publishedAt,
  });

  logger.info(
    translator.t("import.completed", {
      videoId: inserted.id,
      youtubeVideoId,
    }),
    {
      videoId: inserted.id,
      youtubeVideoId,
      yearMonth,
      gameId: game.id,
      steamAppId,
      isSyntheticContent,
      aiDisclosureSet,
      footageSource: effectiveFootageSource,
      normalizedToSecondaryClip,
      totalGenerationCostJpy: totalGenerationCost,
      recordingGameCostJpy,
      playMinutes,
      playLaborCostJpy,
      reviewMinutes,
      reviewLaborCostJpy,
    },
  );

  return {
    id: inserted.id,
    youtubeVideoId,
    yearMonth,
    gameId: game.id,
    isSyntheticContent,
    aiDisclosureSet,
    footageSource: effectiveFootageSource,
    normalizedToSecondaryClip,
    totalGenerationCostJpy: totalGenerationCost,
    recordingGameCostJpy,
    playMinutes,
    playLaborCostJpy,
    reviewMinutes,
    reviewLaborCostJpy,
  };
}
