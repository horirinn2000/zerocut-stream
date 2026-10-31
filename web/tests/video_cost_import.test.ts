import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  executeTransactionalVideoCostImport,
  parseImportCliArgs,
} from "@/cli/import_video_cost";
import {
  DomainValidationError,
  InvariantViolationError,
  SelfDealingProhibitedError,
} from "@/domain/errors";
import type { TargetGameSnapshot } from "@/domain/settlement";
import {
  type NewVideoCostLedgerRow,
  type VideoCostImportRepositoryPort,
  getJstMonthUtcRange,
  importVideoCostRecord,
} from "@/domain/video_cost_import";
import type { LogFields, Logger } from "@/lib/logger";
import { createPrismaClient } from "@/lib/prisma";

function createTestMemoryLogger(): {
  readonly logger: Logger;
  readonly entries: Array<{ level: string; msg: string; fields?: LogFields | undefined }>;
} {
  const entries: Array<{ level: string; msg: string; fields?: LogFields | undefined }> = [];
  const logger: Logger = {
    debug(msg, fields) {
      entries.push({ level: "debug", msg, fields });
    },
    info(msg, fields) {
      entries.push({ level: "info", msg, fields });
    },
    warn(msg, fields) {
      entries.push({ level: "warn", msg, fields });
    },
    error(msg, fields) {
      entries.push({ level: "error", msg, fields });
    },
    child() {
      return logger;
    },
  };
  return { logger, entries };
}

class InMemoryImportRepository implements VideoCostImportRepositoryPort {
  public readonly games = new Map<
    string,
    TargetGameSnapshot & { readonly steamAppId: string }
  >();
  public readonly settledMonths = new Set<string>();
  public readonly rows: Array<NewVideoCostLedgerRow & { readonly id: number }> =
    [];
  private nextId = 1;

  public async findGameBySteamAppId(steamAppId: string) {
    return this.games.get(steamAppId) ?? null;
  }

  public async findSettlementStateByYearMonth(yearMonth: string) {
    if (this.settledMonths.has(yearMonth)) {
      return { isSettled: true };
    }
    return null;
  }

  public async existsByYoutubeVideoId(youtubeVideoId: string): Promise<boolean> {
    return this.rows.some((r) => r.youtubeVideoId === youtubeVideoId);
  }

  public async hasBilledPlayLaborForFootageHash(
    rawFootageSha256: string,
  ): Promise<boolean> {
    return this.rows.some(
      (r) => r.rawFootageSha256 === rawFootageSha256 && r.playMinutes > 0,
    );
  }

  public async hasBilledPlayLaborForGameInMonth(params: {
    readonly gameId: number;
    readonly startUtc: Date;
    readonly endExclusiveUtc: Date;
  }): Promise<boolean> {
    return this.rows.some(
      (r) =>
        r.gameId === params.gameId &&
        r.publishedAt >= params.startUtc &&
        r.publishedAt < params.endExclusiveUtc &&
        r.playMinutes > 0,
    );
  }

  public async hasRecordingGameCostForGame(gameId: number): Promise<boolean> {
    return this.rows.some(
      (r) => r.gameId === gameId && r.recordingGameCostJpy > 0,
    );
  }

  public async insertVideoCostLedger(row: NewVideoCostLedgerRow) {
    const id = this.nextId++;
    this.rows.push({ ...row, id });
    return { id };
  }
}

function buildValidEngineReport(overrides?: {
  steamAppId?: string;
  footageSource?: "HUMAN_PLAY" | "SECONDARY_CLIP" | "BOT_PLAY";
  rawFootageSha256?: string | null;
  llmCostJpy?: string;
  totalGenerationCostJpy?: string;
  recordingGameCostJpy?: number;
  recordingGameReceiptUrl?: string | null;
}) {
  return {
    schemaVersion: "1.0" as const,
    steamAppId: overrides?.steamAppId ?? "2987650",
    videoTitle: "【原価公開】激ムズ登山インディー実況 #1",
    generatedAt: "2026-10-12T09:30:00.000Z",
    isSyntheticContent: true,
    aiGeneration: {
      llmModelName: "claude-sonnet-4-20250514",
      inputTokens: 48200,
      outputTokens: 15100,
      inputRateUsdPer1M: "3.0000",
      outputRateUsdPer1M: "15.0000",
      usdJpyRate: "152.5000",
      llmCostJpy: overrides?.llmCostJpy ?? "56.59",
      ttsCostJpy: "0.00",
      computeCostJpy: "5.81",
      totalGenerationCostJpy: overrides?.totalGenerationCostJpy ?? "62.40",
    },
    recordingAcquisition: {
      recordingGameCostJpy: overrides?.recordingGameCostJpy ?? 0,
      recordingGameReceiptUrl: overrides?.recordingGameReceiptUrl ?? null,
    },
    footage: {
      footageSource: overrides?.footageSource ?? "HUMAN_PLAY",
      rawFootageSha256:
        overrides && "rawFootageSha256" in overrides
          ? overrides.rawFootageSha256
          : "a".repeat(64),
      rawFootageSec: 3600,
      playRegionCode: "JP",
    },
  };
}

describe("video_cost_import: CLI argument parser & JST month UTC range", () => {
  it("computes exact UTC boundaries for JST calendar months including year rollover", () => {
    const oct = getJstMonthUtcRange("2026-10");
    expect(oct.startUtc.toISOString()).toBe("2026-09-30T15:00:00.000Z");
    expect(oct.endExclusiveUtc.toISOString()).toBe("2026-10-31T15:00:00.000Z");

    const dec = getJstMonthUtcRange("2026-12");
    expect(dec.startUtc.toISOString()).toBe("2026-11-30T15:00:00.000Z");
    expect(dec.endExclusiveUtc.toISOString()).toBe("2026-12-31T15:00:00.000Z");
  });

  it("parses both --file (engine JSON) and --human-stream CLI flags and rejects ambiguous combos", () => {
    const helpRes = parseImportCliArgs(["--help"]);
    expect(helpRes.kind).toBe("help");

    const engineCli = parseImportCliArgs([
      "--file",
      "/tmp/report.json",
      "--youtube-video-id",
      "dQw4w9WgXcQ",
      "--ai-disclosure-ack",
      "--published-at",
      "2026-10-12T10:00:00.000Z",
    ]);
    expect(engineCli.kind).toBe("engine_file");
    if (engineCli.kind === "engine_file") {
      expect(engineCli.postUpload.youtubeVideoId).toBe("dQw4w9WgXcQ");
      expect(engineCli.postUpload.aiDisclosureAck).toBe(true);
    }

    const humanCli = parseImportCliArgs([
      "--human-stream",
      "--steam-app-id",
      "2987650",
      "--title",
      "生身で挑む初見実況",
      "--youtube-video-id",
      "aBcDeFgHiJk",
      "--published-at",
      "2026-10-12T10:00:00.000Z",
    ]);
    expect(humanCli.kind).toBe("human_stream");
    if (humanCli.kind === "human_stream") {
      expect(humanCli.request.mode).toBe("human_stream");
    }

    // Rejects when both --file and --human-stream are given, or neither
    expect(() =>
      parseImportCliArgs([
        "--file",
        "/tmp/a.json",
        "--human-stream",
        "--youtube-video-id",
        "dQw4w9WgXcQ",
      ]),
    ).toThrow(DomainValidationError);

    expect(() =>
      parseImportCliArgs(["--youtube-video-id", "dQw4w9WgXcQ"]),
    ).toThrow(DomainValidationError);

    // Rejects when --published-at is omitted (no execution-time fallback allowed)
    try {
      parseImportCliArgs([
        "--file",
        "/tmp/report.json",
        "--youtube-video-id",
        "dQw4w9WgXcQ",
        "--ai-disclosure-ack",
      ]);
      expect.unreachable("Expected missing --published-at to throw");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(DomainValidationError);
      expect((err as DomainValidationError).messageKey).toBe(
        "error.validation.missing_cli_arg",
      );
      expect((err as DomainValidationError).params).toEqual({
        arg: "--published-at",
      });
    }
  });
});

describe("video_cost_import: domain cross-record checks & 2nd-video auto-normalization", () => {
  function setupRepo(): InMemoryImportRepository {
    const repo = new InMemoryImportRepository();
    repo.games.set("2987650", {
      id: 1,
      steamAppId: "2987650",
      retailPriceJpy: 800,
      isOperatorAffiliated: false,
      isApproved: true,
    });
    repo.games.set("9999999", {
      id: 2,
      steamAppId: "9999999",
      retailPriceJpy: 1000,
      isOperatorAffiliated: true, // Self-dealing!
      isApproved: true,
    });
    repo.settledMonths.add("2026-09");
    return repo;
  }

  it("imports 1st video with 60m play labor, auto-normalizes 2nd video in same month to 0m, and allows 60m again next month on new footage", async () => {
    const repo = setupRepo();
    const { logger, entries } = createTestMemoryLogger();

    // 1st video of game 2987650 in 2026-10
    const first = await importVideoCostRecord(
      {
        mode: "engine_file",
        rawReport: buildValidEngineReport({ rawFootageSha256: "1".repeat(64) }),
        postUpload: {
          youtubeVideoId: "vid_oct_01",
          publishedAt: new Date("2026-10-10T10:00:00.000Z"),
          reviewRegionCode: "JP",
          contentIdStatus: "CLEAR",
          aiDisclosureAck: true,
        },
      },
      { repo, logger },
    );

    expect(first.footageSource).toBe("HUMAN_PLAY");
    expect(first.normalizedToSecondaryClip).toBe(false);
    expect(first.playMinutes).toBe(60);
    expect(first.playLaborCostJpy).toBe("1320.00");
    expect(first.reviewMinutes).toBe(20);
    expect(first.reviewLaborCostJpy).toBe("440.00");

    // 2nd video of same game in 2026-10 (new raw hash) -> MUST NOT reject; auto-normalizes to 0m!
    const second = await importVideoCostRecord(
      {
        mode: "engine_file",
        rawReport: buildValidEngineReport({ rawFootageSha256: "2".repeat(64) }),
        postUpload: {
          youtubeVideoId: "vid_oct_02",
          publishedAt: new Date("2026-10-20T10:00:00.000Z"),
          reviewRegionCode: "JP",
          contentIdStatus: "CLEAR",
          aiDisclosureAck: true,
        },
      },
      { repo, logger },
    );

    expect(second.footageSource).toBe("SECONDARY_CLIP");
    expect(second.normalizedToSecondaryClip).toBe(true);
    expect(second.playMinutes).toBe(0);
    expect(second.playLaborCostJpy).toBe("0.00");
    expect(second.reviewMinutes).toBe(20);
    expect(second.reviewLaborCostJpy).toBe("440.00");
    expect(entries.some((e) => e.msg.includes("0分"))).toBe(true);

    // Next JST month (2026-10-31T15:00:00Z === 2026-11-01 00:00 JST) with new footage -> 60m again!
    const novFirst = await importVideoCostRecord(
      {
        mode: "engine_file",
        rawReport: buildValidEngineReport({ rawFootageSha256: "3".repeat(64) }),
        postUpload: {
          youtubeVideoId: "vid_nov_01",
          publishedAt: new Date("2026-10-31T15:00:00.000Z"),
          reviewRegionCode: "JP",
          contentIdStatus: "CLEAR",
          aiDisclosureAck: true,
        },
      },
      { repo, logger },
    );
    expect(novFirst.yearMonth).toBe("2026-11");
    expect(novFirst.playMinutes).toBe(60);
  });

  it("supports engine-less --human-stream mode and always forces aiDisclosureSet = false even if --ai-disclosure-ack is passed", async () => {
    const repo = setupRepo();
    const { logger } = createTestMemoryLogger();

    const human = await importVideoCostRecord(
      {
        mode: "human_stream",
        steamAppId: "2987650",
        videoTitle: "生身配信者のインディー初見プレイ",
        playRegionCode: "JP",
        postUpload: {
          youtubeVideoId: "human_vid_01",
          publishedAt: new Date("2026-10-15T12:00:00.000Z"),
          reviewRegionCode: "JP",
          contentIdStatus: "CLEAR",
          aiDisclosureAck: true, // Even if passed by mistake on CLI, non-synthetic must stay false
        },
      },
      { repo, logger },
    );

    expect(human.isSyntheticContent).toBe(false);
    expect(human.aiDisclosureSet).toBe(false);
    expect(repo.rows[0]?.aiDisclosureSet).toBe(false);
    expect(human.totalGenerationCostJpy).toBe("0.00");
    expect(human.playMinutes).toBe(60);
    expect(human.playLaborCostJpy).toBe("1320.00");
    expect(human.reviewMinutes).toBe(20);
    expect(human.reviewLaborCostJpy).toBe("440.00");
  });

  it("allows recordingGameCostJpy at most once per game across all time (rejecting duplicate billing in subsequent months)", async () => {
    const repo = setupRepo();
    const { logger } = createTestMemoryLogger();

    // 1st purchase in 2026-10 with receipt URL -> succeeds
    const oct = await importVideoCostRecord(
      {
        mode: "engine_file",
        rawReport: buildValidEngineReport({
          rawFootageSha256: "a".repeat(64),
          recordingGameCostJpy: 800,
          recordingGameReceiptUrl: "https://example.org/receipts/2987650.png",
        }),
        postUpload: {
          youtubeVideoId: "vid_oct_buy",
          publishedAt: new Date("2026-10-10T10:00:00.000Z"),
          reviewRegionCode: "JP",
          contentIdStatus: "CLEAR",
          aiDisclosureAck: true,
        },
      },
      { repo, logger },
    );
    expect(oct.recordingGameCostJpy).toBe(800);

    // Next month (2026-11), brand-new raw footage hash, attempting to bill recordingGameCostJpy > 0 AGAIN -> REJECTED!
    try {
      await importVideoCostRecord(
        {
          mode: "engine_file",
          rawReport: buildValidEngineReport({
            rawFootageSha256: "b".repeat(64),
            recordingGameCostJpy: 800,
            recordingGameReceiptUrl: "https://example.org/receipts/2987650-nov.png",
          }),
          postUpload: {
            youtubeVideoId: "vid_nov_rebill",
            publishedAt: new Date("2026-11-10T10:00:00.000Z"),
            reviewRegionCode: "JP",
            contentIdStatus: "CLEAR",
            aiDisclosureAck: true,
          },
        },
        { repo, logger },
      );
      expect.unreachable("Expected lifetime once-per-game recordingGameCostJpy limit to reject");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(InvariantViolationError);
      expect((err as InvariantViolationError).messageKey).toBe(
        "error.import.recording_receipt_required",
      );
    }

    // Next month (2026-11) with recordingGameCostJpy = 0 -> succeeds with 60m play labor
    const novZeroCost = await importVideoCostRecord(
      {
        mode: "engine_file",
        rawReport: buildValidEngineReport({
          rawFootageSha256: "b".repeat(64),
          recordingGameCostJpy: 0,
          recordingGameReceiptUrl: null,
        }),
        postUpload: {
          youtubeVideoId: "vid_nov_zero_rec",
          publishedAt: new Date("2026-11-10T10:00:00.000Z"),
          reviewRegionCode: "JP",
          contentIdStatus: "CLEAR",
          aiDisclosureAck: true,
        },
      },
      { repo, logger },
    );
    expect(novZeroCost.recordingGameCostJpy).toBe(0);
    expect(novZeroCost.playMinutes).toBe(60);
  });

  it("strictly rejects duplicate rawFootageSha256 play labor billing even across different months", async () => {
    const repo = setupRepo();
    const { logger } = createTestMemoryLogger();

    await importVideoCostRecord(
      {
        mode: "engine_file",
        rawReport: buildValidEngineReport({ rawFootageSha256: "f".repeat(64) }),
        postUpload: {
          youtubeVideoId: "vid_oct_raw1",
          publishedAt: new Date("2026-10-10T10:00:00.000Z"),
          reviewRegionCode: "JP",
          contentIdStatus: "CLEAR",
          aiDisclosureAck: true,
        },
      },
      { repo, logger },
    );

    // Attempting to bill HUMAN_PLAY again in November using the SAME rawFootageSha256 (even uppercase) -> REJECTED!
    await expect(
      importVideoCostRecord(
        {
          mode: "engine_file",
          rawReport: buildValidEngineReport({
            rawFootageSha256: "F".repeat(64),
          }),
          postUpload: {
            youtubeVideoId: "vid_nov_raw_dup",
            publishedAt: new Date("2026-11-10T10:00:00.000Z"),
            reviewRegionCode: "JP",
            contentIdStatus: "CLEAR",
            aiDisclosureAck: true,
          },
        },
        { repo, logger },
      ),
    ).rejects.toThrow(InvariantViolationError);

    // Explicitly importing a SECONDARY_CLIP (0m play labor) from the same raw hash is permitted
    const highlight = await importVideoCostRecord(
      {
        mode: "engine_file",
        rawReport: buildValidEngineReport({
          footageSource: "SECONDARY_CLIP",
          rawFootageSha256: "f".repeat(64),
        }),
        postUpload: {
          youtubeVideoId: "vid_nov_highlight",
          publishedAt: new Date("2026-11-11T10:00:00.000Z"),
          reviewRegionCode: "JP",
          contentIdStatus: "CLEAR",
          aiDisclosureAck: true,
        },
      },
      { repo, logger },
    );
    expect(highlight.playMinutes).toBe(0);
  });

  it("rejects missing AI disclosure, tampered LLM cost, settled month backdating, self-dealing, restricted video, and extra JSON fields", async () => {
    const repo = setupRepo();
    const { logger } = createTestMemoryLogger();

    // 1. Missing --ai-disclosure-ack on synthetic video
    await expect(
      importVideoCostRecord(
        {
          mode: "engine_file",
          rawReport: buildValidEngineReport(),
          postUpload: {
            youtubeVideoId: "vid_no_ack",
            publishedAt: new Date("2026-10-10T10:00:00.000Z"),
            reviewRegionCode: "JP",
            contentIdStatus: "CLEAR",
            aiDisclosureAck: false,
          },
        },
        { repo, logger },
      ),
    ).rejects.toThrow(InvariantViolationError);

    // 2. Tampered LLM cost (56.60 instead of 56.59)
    await expect(
      importVideoCostRecord(
        {
          mode: "engine_file",
          rawReport: buildValidEngineReport({
            llmCostJpy: "56.60",
            totalGenerationCostJpy: "62.41",
          }),
          postUpload: {
            youtubeVideoId: "vid_bad_math",
            publishedAt: new Date("2026-10-10T10:00:00.000Z"),
            reviewRegionCode: "JP",
            contentIdStatus: "CLEAR",
            aiDisclosureAck: true,
          },
        },
        { repo, logger },
      ),
    ).rejects.toThrow(InvariantViolationError);

    // 3. Backdating into settled month (2026-09)
    await expect(
      importVideoCostRecord(
        {
          mode: "engine_file",
          rawReport: buildValidEngineReport(),
          postUpload: {
            youtubeVideoId: "vid_backdated",
            publishedAt: new Date("2026-09-20T10:00:00.000Z"),
            reviewRegionCode: "JP",
            contentIdStatus: "CLEAR",
            aiDisclosureAck: true,
          },
        },
        { repo, logger },
      ),
    ).rejects.toThrow(InvariantViolationError);

    // 4. Operator-affiliated game (Self-Dealing)
    await expect(
      importVideoCostRecord(
        {
          mode: "engine_file",
          rawReport: buildValidEngineReport({ steamAppId: "9999999" }),
          postUpload: {
            youtubeVideoId: "vid_self_deal",
            publishedAt: new Date("2026-10-10T10:00:00.000Z"),
            reviewRegionCode: "JP",
            contentIdStatus: "CLEAR",
            aiDisclosureAck: true,
          },
        },
        { repo, logger },
      ),
    ).rejects.toThrow(SelfDealingProhibitedError);

    // 5. RESTRICTED Content ID status
    await expect(
      importVideoCostRecord(
        {
          mode: "engine_file",
          rawReport: buildValidEngineReport(),
          postUpload: {
            youtubeVideoId: "vid_restricted",
            publishedAt: new Date("2026-10-10T10:00:00.000Z"),
            reviewRegionCode: "JP",
            contentIdStatus: "RESTRICTED",
            aiDisclosureAck: true,
          },
        },
        { repo, logger },
      ),
    ).rejects.toThrow(InvariantViolationError);

    // 6. Strict schema rejects manually injected youtubeVideoId inside engine JSON
    await expect(
      importVideoCostRecord(
        {
          mode: "engine_file",
          rawReport: {
            ...buildValidEngineReport(),
            youtubeVideoId: "manual_edit_not_allowed",
          },
          postUpload: {
            youtubeVideoId: "vid_strict_json",
            publishedAt: new Date("2026-10-10T10:00:00.000Z"),
            reviewRegionCode: "JP",
            contentIdStatus: "CLEAR",
            aiDisclosureAck: true,
          },
        },
        { repo, logger },
      ),
    ).rejects.toThrow(DomainValidationError);
  });
});

describe("video_cost_import: live MySQL transactional repository integration", () => {
  const prisma = createPrismaClient();
  let mysqlAvailable = false;
  const createdVideoIds: number[] = [];
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
    if (createdVideoIds.length > 0) {
      await prisma.videoCostLedger.deleteMany({
        where: { id: { in: createdVideoIds } },
      });
      createdVideoIds.length = 0;
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

  it("persists 1st & 2nd videos atomically in MySQL and enforces cross-row hash & lifetime recording cost uniqueness", async (ctx) => {
    if (!mysqlAvailable) {
      ctx.skip();
      return;
    }

    const { logger } = createTestMemoryLogger();
    const uniqueAppId = `import_it_${Date.now()}`;
    const game = await prisma.indieGame.create({
      data: {
        title: "Transactional Import Test Game",
        steamAppId: uniqueAppId,
        storeUrl: "https://store.steampowered.com/app/777/",
        retailPriceJpy: 700,
        developerName: "Indie Test Studio",
        isOperatorAffiliated: false,
        isApproved: true,
      },
    });
    createdGameIds.push(game.id);

    const hash1 = `a1${String(Date.now()).padStart(62, "0")}`;
    const hash2 = `b2${String(Date.now()).padStart(62, "0")}`;
    const hash3 = `c3${String(Date.now()).padStart(62, "0")}`;

    const v1 = await executeTransactionalVideoCostImport({
      prisma,
      logger,
      request: {
        mode: "engine_file",
        rawReport: buildValidEngineReport({
          steamAppId: uniqueAppId,
          rawFootageSha256: hash1,
          recordingGameCostJpy: 700,
          recordingGameReceiptUrl: "https://example.org/receipts/it-777.png",
        }),
        postUpload: {
          youtubeVideoId: `yt1_${Date.now()}`,
          publishedAt: new Date("2098-05-10T10:00:00.000Z"),
          reviewRegionCode: "JP",
          contentIdStatus: "CLEAR",
          aiDisclosureAck: true,
        },
      },
    });
    createdVideoIds.push(v1.id);
    expect(v1.playMinutes).toBe(60);
    expect(v1.recordingGameCostJpy).toBe(700);

    const v2 = await executeTransactionalVideoCostImport({
      prisma,
      logger,
      request: {
        mode: "human_stream",
        steamAppId: uniqueAppId,
        videoTitle: "2本目の生身追加配信（自動0分正規化）",
        playRegionCode: "JP",
        rawFootageSha256: hash2,
        postUpload: {
          youtubeVideoId: `yt2_${Date.now()}`,
          publishedAt: new Date("2098-05-18T10:00:00.000Z"),
          reviewRegionCode: "JP",
          contentIdStatus: "CLEAR",
          aiDisclosureAck: false,
        },
      },
    });
    createdVideoIds.push(v2.id);
    expect(v2.playMinutes).toBe(0);
    expect(v2.footageSource).toBe("SECONDARY_CLIP");

    // Duplicate rawFootageSha256 in next month -> rejected
    await expect(
      executeTransactionalVideoCostImport({
        prisma,
        logger,
        request: {
          mode: "engine_file",
          rawReport: buildValidEngineReport({
            steamAppId: uniqueAppId,
            rawFootageSha256: hash1,
          }),
          postUpload: {
            youtubeVideoId: `yt3_${Date.now()}`,
            publishedAt: new Date("2098-06-10T10:00:00.000Z"),
            reviewRegionCode: "JP",
            contentIdStatus: "CLEAR",
            aiDisclosureAck: true,
          },
        },
      }),
    ).rejects.toThrow(InvariantViolationError);

    // Duplicate recordingGameCostJpy > 0 in next month (even on brand-new hash3) -> rejected by all-time DB query!
    await expect(
      executeTransactionalVideoCostImport({
        prisma,
        logger,
        request: {
          mode: "engine_file",
          rawReport: buildValidEngineReport({
            steamAppId: uniqueAppId,
            rawFootageSha256: hash3,
            recordingGameCostJpy: 700,
            recordingGameReceiptUrl: "https://example.org/receipts/it-777-jun.png",
          }),
          postUpload: {
            youtubeVideoId: `yt4_${Date.now()}`,
            publishedAt: new Date("2098-06-12T10:00:00.000Z"),
            reviewRegionCode: "JP",
            contentIdStatus: "CLEAR",
            aiDisclosureAck: true,
          },
        },
      }),
    ).rejects.toThrow(InvariantViolationError);
  });
});
