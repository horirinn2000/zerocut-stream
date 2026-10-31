import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DomainValidationError } from "@/domain/errors";
import {
  DRAND_QUICKNET_CONFIG,
  computeEntriesSnapshotHash,
  computeTicketHash,
  deriveTargetDrandRound,
  executeFairDraw,
  getDrandRoundEmissionDate,
  getDrandRoundUnixSec,
} from "@/lib/fair_draw";

const SAMPLE_SEED =
  "a3f1e2d4c5b6a7980123456789abcdefa3f1e2d4c5b6a7980123456789abcdef";

describe("fair_draw: drand round pre-commitment derivation", () => {
  it("returns round 2 when cutoff equals exact genesis timestamp (round 1 is already live at genesis)", () => {
    const genesisDate = new Date(
      Number(DRAND_QUICKNET_CONFIG.genesisUnixSec * 1000n),
    );
    const targetRound = deriveTargetDrandRound(genesisDate);
    expect(targetRound).toBe(2n);
    expect(getDrandRoundEmissionDate(targetRound).getTime()).toBeGreaterThan(
      genesisDate.getTime(),
    );
  });

  it("handles exact round boundary (.000Z), 1ms before (.999Z), and 1ms after (.001Z) strictly", () => {
    // Round 2 emits at genesis + 3s = 1692803370.000Z
    const oneMsBeforeRound2 = new Date(1692803369999);
    const exactRound2Boundary = new Date(1692803370000);
    const oneMsAfterRound2 = new Date(1692803370001);

    // 1ms before Round 2 -> Round 2 (1692803370.000) is strictly in the future
    expect(deriveTargetDrandRound(oneMsBeforeRound2)).toBe(2n);
    expect(
      getDrandRoundEmissionDate(2n).getTime() > oneMsBeforeRound2.getTime(),
    ).toBe(true);

    // Exact Round 2 second -> Round 2 is already emitted at that instant, so must pick Round 3
    expect(deriveTargetDrandRound(exactRound2Boundary)).toBe(3n);
    expect(
      getDrandRoundEmissionDate(3n).getTime() > exactRound2Boundary.getTime(),
    ).toBe(true);
    expect(getDrandRoundUnixSec(2n)).toBe(1692803370n);

    // 1ms after Round 2 -> Round 3 (1692803373.000)
    expect(deriveTargetDrandRound(oneMsAfterRound2)).toBe(3n);
  });

  it("guarantees the previous round was emitted at or before cutoff and target round is strictly after cutoff", () => {
    const cutoffSamples = [
      new Date("2026-10-31T14:59:59.000Z"),
      new Date("2026-11-30T14:59:59.000Z"),
      new Date("2026-11-30T14:59:59.999Z"),
      new Date(1692803367000 + 3000 * 500),
    ];

    for (const cutoff of cutoffSamples) {
      const round = deriveTargetDrandRound(cutoff);
      const targetEmissionMs = getDrandRoundEmissionDate(round).getTime();
      const prevEmissionMs = getDrandRoundEmissionDate(round - 1n).getTime();

      expect(targetEmissionMs).toBeGreaterThan(cutoff.getTime());
      expect(prevEmissionMs).toBeLessThanOrEqual(cutoff.getTime());
    }
  });

  it("rejects cutoff dates earlier than genesis, invalid Date objects, or invalid drand config", () => {
    const beforeGenesis = new Date(
      Number(DRAND_QUICKNET_CONFIG.genesisUnixSec * 1000n) - 1,
    );
    expect(() => deriveTargetDrandRound(beforeGenesis)).toThrow(
      DomainValidationError,
    );
    expect(() => deriveTargetDrandRound(new Date("invalid"))).toThrow(
      DomainValidationError,
    );
    expect(() =>
      deriveTargetDrandRound(new Date("2026-11-01T00:00:00Z"), {
        chainHash: "abc",
        genesisUnixSec: 100n,
        periodSec: 0n,
      }),
    ).toThrow(DomainValidationError);
    expect(() => getDrandRoundUnixSec(0n)).toThrow(DomainValidationError);
  });
});

describe("fair_draw: deterministic & order-independent flat SHA-256 draw", () => {
  it("matches independent SHA-256 test vectors exactly", () => {
    const expectedSnapshot = createHash("sha256")
      .update("10,20,30", "utf8")
      .digest("hex");
    expect(computeEntriesSnapshotHash([30, 10, 20])).toBe(expectedSnapshot);

    const expectedTicketHash20 = createHash("sha256")
      .update(`${SAMPLE_SEED}:20`, "utf8")
      .digest("hex");
    expect(computeTicketHash(SAMPLE_SEED, 20)).toBe(expectedTicketHash20);
  });

  it("is 100% deterministic and completely invariant under input order permutations (no early-entry bias)", () => {
    const forward = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const reversed = [...forward].reverse();
    const interleaved = [9, 2, 7, 4, 1, 10, 3, 8, 5, 6];

    const resA = executeFairDraw({
      publicRandomSeed: SAMPLE_SEED,
      entryIds: forward,
      maxAffordableKeys: 4,
    });
    const resB = executeFairDraw({
      publicRandomSeed: SAMPLE_SEED,
      entryIds: reversed,
      maxAffordableKeys: 4,
    });
    const resC = executeFairDraw({
      publicRandomSeed: SAMPLE_SEED,
      entryIds: interleaved,
      maxAffordableKeys: 4,
    });

    expect(resA).toEqual(resB);
    expect(resA).toEqual(resC);
    expect(resA.actualWinnerCount).toBe(4);
    expect(resA.winnerEntryIds).toHaveLength(4);
  });

  it("clips actualWinnerCount when maxAffordableKeys exceeds total entries", () => {
    const res = executeFairDraw({
      publicRandomSeed: SAMPLE_SEED,
      entryIds: [101, 102],
      maxAffordableKeys: 15,
    });

    expect(res.totalEntries).toBe(2);
    expect(res.maxAffordableKeys).toBe(15);
    expect(res.actualWinnerCount).toBe(2);
    expect(res.winnerEntryIds).toHaveLength(2);
    expect([...res.winnerEntryIds].sort((a, b) => a - b)).toEqual([101, 102]);
  });

  it("handles zero budget (maxAffordableKeys = 0) and empty entry list cleanly", () => {
    const zeroBudget = executeFairDraw({
      publicRandomSeed: SAMPLE_SEED,
      entryIds: [1, 2, 3],
      maxAffordableKeys: 0,
    });
    expect(zeroBudget.actualWinnerCount).toBe(0);
    expect(zeroBudget.winnerEntryIds).toEqual([]);
    expect(zeroBudget.rankedTickets.every((t) => !t.isWinner)).toBe(true);

    const noEntries = executeFairDraw({
      publicRandomSeed: SAMPLE_SEED,
      entryIds: [],
      maxAffordableKeys: 5,
    });
    expect(noEntries.actualWinnerCount).toBe(0);
    expect(noEntries.winnerEntryIds).toEqual([]);
    expect(noEntries.rankedTickets).toEqual([]);
  });

  it("rejects duplicate entryIds, non-positive entryIds, negative key counts, and malformed seeds", () => {
    expect(() =>
      executeFairDraw({
        publicRandomSeed: SAMPLE_SEED,
        entryIds: [1, 2, 2],
        maxAffordableKeys: 1,
      }),
    ).toThrow(DomainValidationError);

    expect(() =>
      executeFairDraw({
        publicRandomSeed: SAMPLE_SEED,
        entryIds: [0, 1],
        maxAffordableKeys: 1,
      }),
    ).toThrow(DomainValidationError);

    expect(() =>
      executeFairDraw({
        publicRandomSeed: SAMPLE_SEED,
        entryIds: [1],
        maxAffordableKeys: -1,
      }),
    ).toThrow(DomainValidationError);

    expect(() =>
      executeFairDraw({
        publicRandomSeed: SAMPLE_SEED.toUpperCase(),
        entryIds: [1],
        maxAffordableKeys: 1,
      }),
    ).toThrow(DomainValidationError);

    expect(() =>
      executeFairDraw({
        publicRandomSeed: "abcd",
        entryIds: [1],
        maxAffordableKeys: 1,
      }),
    ).toThrow(DomainValidationError);
  });
});
