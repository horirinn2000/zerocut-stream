import { afterEach, describe, expect, it, vi } from "vitest";
import { CipherIntegrityError, DomainValidationError } from "@/domain/errors";
import {
  Aes256GcmSteamKeyCipher,
  createSteamKeyCipherFromEnv,
} from "@/lib/steam_key_cipher";

const VALID_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_KEY_HEX =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("Aes256GcmSteamKeyCipher", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("encrypts and decrypts Steam activation keys losslessly with randomized IVs", () => {
    const cipher = new Aes256GcmSteamKeyCipher(VALID_KEY_HEX);
    const plainKey = "AB12C-DE34F-GH56J";

    const encrypted1 = cipher.encrypt(plainKey);
    const encrypted2 = cipher.encrypt(plainKey);

    expect(encrypted1).not.toBe(encrypted2);
    expect(encrypted1.startsWith("v1:")).toBe(true);
    expect(cipher.decrypt(encrypted1)).toBe(plainKey);
    expect(cipher.decrypt(encrypted2)).toBe(plainKey);
  });

  it("trims surrounding whitespace before encrypting", () => {
    const cipher = new Aes256GcmSteamKeyCipher(VALID_KEY_HEX);
    const encrypted = cipher.encrypt("  ZX98Y-WV76U-TS54R \n");
    expect(cipher.decrypt(encrypted)).toBe("ZX98Y-WV76U-TS54R");
  });

  it("rejects tampered ciphertext, IV, or GCM authentication tag", () => {
    const cipher = new Aes256GcmSteamKeyCipher(VALID_KEY_HEX);
    const encrypted = cipher.encrypt("KEY00-KEY11-KEY22");
    const [version, ivHex, tagHex, bodyHex] = encrypted.split(":");

    const flipFirstHexChar = (hex: string): string =>
      (hex[0] === "0" ? "1" : "0") + hex.slice(1);

    const tamperedBody = `${version}:${ivHex}:${tagHex}:${flipFirstHexChar(bodyHex ?? "")}`;
    const tamperedTag = `${version}:${ivHex}:${flipFirstHexChar(tagHex ?? "")}:${bodyHex}`;
    const tamperedIv = `${version}:${flipFirstHexChar(ivHex ?? "")}:${tagHex}:${bodyHex}`;

    expect(() => cipher.decrypt(tamperedBody)).toThrow(CipherIntegrityError);
    expect(() => cipher.decrypt(tamperedTag)).toThrow(CipherIntegrityError);
    expect(() => cipher.decrypt(tamperedIv)).toThrow(CipherIntegrityError);
  });

  it("rejects decryption with a different 256-bit key", () => {
    const cipherA = new Aes256GcmSteamKeyCipher(VALID_KEY_HEX);
    const cipherB = new Aes256GcmSteamKeyCipher(OTHER_KEY_HEX);

    const encrypted = cipherA.encrypt("SECRET-STEAM-KEY01");
    expect(() => cipherB.decrypt(encrypted)).toThrow(CipherIntegrityError);
  });

  it("rejects malformed keys, empty plaintext, and invalid payload formats", () => {
    expect(() => new Aes256GcmSteamKeyCipher("short")).toThrow(
      DomainValidationError,
    );
    expect(() => new Aes256GcmSteamKeyCipher("z".repeat(64))).toThrow(
      DomainValidationError,
    );

    const cipher = new Aes256GcmSteamKeyCipher(VALID_KEY_HEX);
    expect(() => cipher.encrypt("   ")).toThrow(DomainValidationError);
    expect(() => cipher.decrypt("v2:00:00:00")).toThrow(CipherIntegrityError);
    expect(() => cipher.decrypt("invalid-format")).toThrow(
      CipherIntegrityError,
    );
  });

  it("loads key from environment via vi.stubEnv cleanly", () => {
    vi.stubEnv("STEAM_KEY_ENCRYPTION_KEY_HEX", VALID_KEY_HEX);
    const cipher = createSteamKeyCipherFromEnv();
    const payload = cipher.encrypt("ENV01-TEST2-KEY03");
    expect(cipher.decrypt(payload)).toBe("ENV01-TEST2-KEY03");
  });
});
