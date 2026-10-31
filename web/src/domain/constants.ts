import { z } from "zod";
import { DomainValidationError } from "@/domain/errors";
import rawPublicConstantsJson from "./public_constants.json";

const MinutesHistoryEntrySchema = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  playMinutesPerVideo: z.number().int().positive(),
  reviewMinutesPerVideo: z.number().int().positive(),
  rationale: z.string().min(1),
});

const RateHistoryEntrySchema = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  regionCode: z.string().min(2).max(16),
  rateJpyPerHour: z.number().int().positive(),
  rationale: z.string().min(1),
});

const PublicConstantsSchema = z
  .object({
    schemaVersion: z.literal(1),
    playMinutesPerVideo: z.number().int().positive(),
    reviewMinutesPerVideo: z.number().int().positive(),
    allowedHistoricalPlayMinutesPerVideo: z
      .array(z.number().int().positive())
      .nonempty(),
    allowedHistoricalReviewMinutesPerVideo: z
      .array(z.number().int().positive())
      .nonempty(),
    regionalLaborRatesJpyPerHour: z.record(
      z.string().min(2).max(16),
      z.number().int().positive(),
    ),
    allowedHistoricalRegionalRatesJpyPerHour: z.record(
      z.string().min(2).max(16),
      z.array(z.number().int().positive()).nonempty(),
    ),
    minutesHistory: z.array(MinutesHistoryEntrySchema).nonempty(),
    rateHistory: z.array(RateHistoryEntrySchema).nonempty(),
  })
  .superRefine((val, ctx) => {
    if (
      !val.allowedHistoricalPlayMinutesPerVideo.includes(
        val.playMinutesPerVideo,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Active playMinutesPerVideo (${val.playMinutesPerVideo}) must be included in allowedHistoricalPlayMinutesPerVideo`,
      });
    }
    if (
      !val.allowedHistoricalReviewMinutesPerVideo.includes(
        val.reviewMinutesPerVideo,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Active reviewMinutesPerVideo (${val.reviewMinutesPerVideo}) must be included in allowedHistoricalReviewMinutesPerVideo`,
      });
    }
    for (const [region, activeRate] of Object.entries(
      val.regionalLaborRatesJpyPerHour,
    )) {
      const historical = val.allowedHistoricalRegionalRatesJpyPerHour[region];
      if (!historical || !historical.includes(activeRate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Active labor rate (${activeRate}) for region ${region} must be included in allowedHistoricalRegionalRatesJpyPerHour`,
        });
      }
    }
  });

export type PublicConstantsConfig = Readonly<
  z.infer<typeof PublicConstantsSchema>
>;

export function parsePublicConstants(
  rawUnknown: unknown,
): PublicConstantsConfig {
  const parsed = PublicConstantsSchema.parse(rawUnknown);

  const frozenHistoricalRates: Record<string, readonly number[]> = {};
  for (const [region, rates] of Object.entries(
    parsed.allowedHistoricalRegionalRatesJpyPerHour,
  )) {
    frozenHistoricalRates[region] = Object.freeze([...rates]);
  }

  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    playMinutesPerVideo: parsed.playMinutesPerVideo,
    reviewMinutesPerVideo: parsed.reviewMinutesPerVideo,
    allowedHistoricalPlayMinutesPerVideo: Object.freeze([
      ...parsed.allowedHistoricalPlayMinutesPerVideo,
    ]) as unknown as PublicConstantsConfig["allowedHistoricalPlayMinutesPerVideo"],
    allowedHistoricalReviewMinutesPerVideo: Object.freeze([
      ...parsed.allowedHistoricalReviewMinutesPerVideo,
    ]) as unknown as PublicConstantsConfig["allowedHistoricalReviewMinutesPerVideo"],
    regionalLaborRatesJpyPerHour: Object.freeze({
      ...parsed.regionalLaborRatesJpyPerHour,
    }),
    allowedHistoricalRegionalRatesJpyPerHour: Object.freeze(
      frozenHistoricalRates,
    ) as PublicConstantsConfig["allowedHistoricalRegionalRatesJpyPerHour"],
    minutesHistory: Object.freeze(
      parsed.minutesHistory.map((item) => Object.freeze({ ...item })),
    ) as unknown as PublicConstantsConfig["minutesHistory"],
    rateHistory: Object.freeze(
      parsed.rateHistory.map((item) => Object.freeze({ ...item })),
    ) as unknown as PublicConstantsConfig["rateHistory"],
  });
}

export const PUBLIC_CONSTANTS: PublicConstantsConfig = parsePublicConstants(
  rawPublicConstantsJson,
);

export const PUBLIC_PLAY_MINUTES_PER_VIDEO: number =
  PUBLIC_CONSTANTS.playMinutesPerVideo;

export const PUBLIC_REVIEW_MINUTES_PER_VIDEO: number =
  PUBLIC_CONSTANTS.reviewMinutesPerVideo;

export const PUBLIC_REGIONAL_LABOR_RATES_JPY: Readonly<Record<string, number>> =
  PUBLIC_CONSTANTS.regionalLaborRatesJpyPerHour;

export function resolveActiveRegionalLaborRateJpy(
  regionCode: string,
  constants: PublicConstantsConfig = PUBLIC_CONSTANTS,
): number {
  const normalized = regionCode.trim().toUpperCase();
  const rate = constants.regionalLaborRatesJpyPerHour[normalized];
  if (rate === undefined) {
    throw new DomainValidationError("error.validation.invalid_region_code", {
      regionCode,
    });
  }
  return rate;
}

export function isAllowedHistoricalRegionalLaborRateJpy(
  regionCode: string,
  rateJpyPerHour: number,
  constants: PublicConstantsConfig = PUBLIC_CONSTANTS,
): boolean {
  const normalized = regionCode.trim().toUpperCase();
  const allowed =
    constants.allowedHistoricalRegionalRatesJpyPerHour[normalized];
  if (!allowed) {
    return false;
  }
  return allowed.includes(rateJpyPerHour);
}

export function isAllowedHistoricalPlayMinutes(
  minutes: number,
  constants: PublicConstantsConfig = PUBLIC_CONSTANTS,
): boolean {
  return constants.allowedHistoricalPlayMinutesPerVideo.includes(minutes);
}

export function isAllowedHistoricalReviewMinutes(
  minutes: number,
  constants: PublicConstantsConfig = PUBLIC_CONSTANTS,
): boolean {
  return constants.allowedHistoricalReviewMinutesPerVideo.includes(minutes);
}
