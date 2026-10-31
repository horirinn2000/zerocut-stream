import { createHash } from "node:crypto";
import { DomainValidationError } from "@/domain/errors";

export interface DrandChainConfig {
  readonly chainHash: string;
  readonly genesisUnixSec: bigint;
  readonly periodSec: bigint;
}

/**
 * League of Entropy Mainnet (quicknet) default configuration.
 * https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info
 */
export const DRAND_QUICKNET_CONFIG: DrandChainConfig = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  genesisUnixSec: 1692803367n,
  periodSec: 3n,
} as const;

export interface RankedTicket {
  readonly entryId: number;
  readonly ticketHash: string; // SHA-256("${publicRandomSeed}:${entryId}")
  readonly rank: number; // 1-indexed
  readonly isWinner: boolean;
}

export interface FairDrawInput {
  readonly publicRandomSeed: string;
  readonly entryIds: readonly number[];
  readonly maxAffordableKeys: number;
}

export interface FairDrawResult {
  readonly publicRandomSeed: string;
  readonly entriesSnapshotHash: string; // SHA-256(sortedEntryIds.join(","))
  readonly totalEntries: number;
  readonly maxAffordableKeys: number;
  readonly actualWinnerCount: number; // Math.min(maxAffordableKeys, totalEntries)
  readonly winnerEntryIds: readonly number[];
  readonly rankedTickets: readonly RankedTicket[];
}

const LOWER_HEX_64_REGEX = /^[0-9a-f]{64}$/;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function validatePositiveSafeInt(field: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainValidationError("error.validation.invalid_integer", {
      field,
      value: String(value),
    });
  }
  if (value <= 0) {
    throw new DomainValidationError("error.validation.positive_required", {
      field,
      value,
    });
  }
}

function validateNonNegativeSafeInt(field: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainValidationError("error.validation.invalid_integer", {
      field,
      value: String(value),
    });
  }
  if (value < 0) {
    throw new DomainValidationError("error.validation.negative_not_allowed", {
      field,
      value,
    });
  }
}

/**
 * Derives the exact first drand round whose emission timestamp is strictly greater
 * than `entryCutoffAt` (t_emission > t_cutoff), preventing both last-millisecond
 * seed knowledge before cutoff and post-cutoff round cherry-picking.
 */
export function deriveTargetDrandRound(
  entryCutoffAt: Date,
  config: DrandChainConfig = DRAND_QUICKNET_CONFIG,
): bigint {
  const cutoffMsNumber = entryCutoffAt.getTime();
  if (Number.isNaN(cutoffMsNumber)) {
    throw new DomainValidationError("error.validation.invalid_date", {
      field: "entryCutoffAt",
    });
  }
  if (config.periodSec <= 0n || config.genesisUnixSec < 0n) {
    throw new DomainValidationError("error.validation.invalid_drand_config");
  }

  const cutoffMs = BigInt(cutoffMsNumber);
  const genesisMs = config.genesisUnixSec * 1000n;
  if (cutoffMs < genesisMs) {
    throw new DomainValidationError("error.validation.cutoff_before_genesis");
  }

  const periodMs = config.periodSec * 1000n;
  const elapsedMs = cutoffMs - genesisMs;
  return elapsedMs / periodMs + 2n;
}

/**
 * Computes the exact emission Unix timestamp (in seconds) of a given drand round.
 */
export function getDrandRoundUnixSec(
  round: bigint,
  config: DrandChainConfig = DRAND_QUICKNET_CONFIG,
): bigint {
  if (round < 1n || config.periodSec <= 0n) {
    throw new DomainValidationError("error.validation.invalid_drand_config");
  }
  return config.genesisUnixSec + (round - 1n) * config.periodSec;
}

export function getDrandRoundEmissionDate(
  round: bigint,
  config: DrandChainConfig = DRAND_QUICKNET_CONFIG,
): Date {
  const unixSec = getDrandRoundUnixSec(round, config);
  return new Date(Number(unixSec * 1000n));
}

/**
 * Validates and sorts entry IDs ascending, returning both the sorted copy and
 * the deterministic SHA-256 snapshot commitment hash.
 */
export function computeEntriesSnapshotHash(entryIds: readonly number[]): string {
  const sortedIds = validateAndSortEntryIds(entryIds);
  return sha256Hex(sortedIds.join(","));
}

function validateAndSortEntryIds(entryIds: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const id of entryIds) {
    validatePositiveSafeInt("entryId", id);
    if (seen.has(id)) {
      throw new DomainValidationError("error.validation.duplicate_entry_id", {
        entryId: id,
      });
    }
    seen.add(id);
  }
  return [...entryIds].sort((a, b) => a - b);
}

export function computeTicketHash(
  publicRandomSeed: string,
  entryId: number,
): string {
  if (!LOWER_HEX_64_REGEX.test(publicRandomSeed)) {
    throw new DomainValidationError("error.validation.invalid_random_seed");
  }
  validatePositiveSafeInt("entryId", entryId);
  return sha256Hex(`${publicRandomSeed}:${entryId}`);
}

/**
 * Executes a verifiable, strictly flat (weight = 1.0 fixed for all entries)
 * SHA-256 lottery draw.
 *
 * Notice that no user tenure, rank, or multiplier parameter exists in the signature.
 */
export function executeFairDraw(input: FairDrawInput): FairDrawResult {
  const { publicRandomSeed, entryIds, maxAffordableKeys } = input;

  if (!LOWER_HEX_64_REGEX.test(publicRandomSeed)) {
    throw new DomainValidationError("error.validation.invalid_random_seed");
  }
  validateNonNegativeSafeInt("maxAffordableKeys", maxAffordableKeys);

  const sortedEntryIds = validateAndSortEntryIds(entryIds);
  const entriesSnapshotHash = sha256Hex(sortedEntryIds.join(","));
  const totalEntries = sortedEntryIds.length;
  const actualWinnerCount = Math.min(maxAffordableKeys, totalEntries);

  const unranked = sortedEntryIds.map((entryId) => ({
    entryId,
    ticketHash: sha256Hex(`${publicRandomSeed}:${entryId}`),
  }));

  unranked.sort((a, b) => {
    if (a.ticketHash < b.ticketHash) return -1;
    if (a.ticketHash > b.ticketHash) return 1;
    return a.entryId - b.entryId;
  });

  const rankedTickets: RankedTicket[] = unranked.map((item, idx) => {
    const rank = idx + 1;
    return {
      entryId: item.entryId,
      ticketHash: item.ticketHash,
      rank,
      isWinner: rank <= actualWinnerCount,
    };
  });

  const winnerEntryIds = rankedTickets
    .filter((ticket) => ticket.isWinner)
    .map((ticket) => ticket.entryId);

  return {
    publicRandomSeed,
    entriesSnapshotHash,
    totalEntries,
    maxAffordableKeys,
    actualWinnerCount,
    winnerEntryIds,
    rankedTickets,
  };
}
