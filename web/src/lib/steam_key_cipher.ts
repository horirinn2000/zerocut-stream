import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CipherIntegrityError, DomainValidationError } from "@/domain/errors";

const ALGORITHM = "aes-256-gcm";
const PAYLOAD_VERSION = "v1";
const IV_BYTE_LENGTH = 12; // 96-bit standard GCM nonce
const AUTH_TAG_BYTE_LENGTH = 16; // 128-bit GCM authentication tag
const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;
const HEX_EVEN_REGEX = /^(?:[0-9a-fA-F]{2})+$/;

export interface SteamKeyCipher {
  encrypt(plainSteamKey: string): string;
  decrypt(encryptedPayload: string): string;
}

export class Aes256GcmSteamKeyCipher implements SteamKeyCipher {
  private readonly keyBuffer: Buffer;

  constructor(keyHex: string) {
    if (!HEX_64_REGEX.test(keyHex)) {
      throw new DomainValidationError("error.validation.invalid_encryption_key");
    }
    this.keyBuffer = Buffer.from(keyHex, "hex");
  }

  public encrypt(plainSteamKey: string): string {
    const trimmed = plainSteamKey.trim();
    if (trimmed.length === 0) {
      throw new DomainValidationError("error.validation.empty_steam_key");
    }

    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.keyBuffer, iv, {
      authTagLength: AUTH_TAG_BYTE_LENGTH,
    });

    const ciphertext = Buffer.concat([
      cipher.update(trimmed, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      PAYLOAD_VERSION,
      iv.toString("hex"),
      authTag.toString("hex"),
      ciphertext.toString("hex"),
    ].join(":");
  }

  public decrypt(encryptedPayload: string): string {
    const parts = encryptedPayload.split(":");
    if (parts.length !== 4) {
      throw new CipherIntegrityError("error.cipher.invalid_payload_format");
    }

    const [version, ivHex, authTagHex, ciphertextHex] = parts;
    if (
      version !== PAYLOAD_VERSION ||
      !ivHex ||
      !authTagHex ||
      !ciphertextHex ||
      ivHex.length !== IV_BYTE_LENGTH * 2 ||
      authTagHex.length !== AUTH_TAG_BYTE_LENGTH * 2 ||
      !HEX_EVEN_REGEX.test(ivHex) ||
      !HEX_EVEN_REGEX.test(authTagHex) ||
      !HEX_EVEN_REGEX.test(ciphertextHex)
    ) {
      throw new CipherIntegrityError("error.cipher.invalid_payload_format");
    }

    try {
      const iv = Buffer.from(ivHex, "hex");
      const authTag = Buffer.from(authTagHex, "hex");
      const ciphertext = Buffer.from(ciphertextHex, "hex");

      const decipher = createDecipheriv(ALGORITHM, this.keyBuffer, iv, {
        authTagLength: AUTH_TAG_BYTE_LENGTH,
      });
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch (err) {
      throw new CipherIntegrityError(
        "error.cipher.decryption_failed",
        {},
        { cause: err },
      );
    }
  }
}

export function createSteamKeyCipherFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SteamKeyCipher {
  const keyHex = env["STEAM_KEY_ENCRYPTION_KEY_HEX"] ?? "";
  return new Aes256GcmSteamKeyCipher(keyHex);
}
