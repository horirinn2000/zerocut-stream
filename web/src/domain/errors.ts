import {
  type MessageKey,
  type MessageParams,
  type SupportedLocale,
  translate,
} from "@/i18n";

export class DomainError extends Error {
  public readonly messageKey: MessageKey;
  public readonly params: MessageParams;

  constructor(
    messageKey: MessageKey,
    params: MessageParams = {},
    options?: { cause?: unknown },
  ) {
    super(translate("ja", messageKey, params), options);
    this.name = new.target.name;
    this.messageKey = messageKey;
    this.params = params;
  }

  public toLocalizedMessage(locale: SupportedLocale): string {
    return translate(locale, this.messageKey, this.params);
  }
}

export class DomainValidationError extends DomainError {}

export class InvariantViolationError extends DomainError {}

export class SelfDealingProhibitedError extends InvariantViolationError {
  constructor(gameId: number) {
    super("error.invariant.self_dealing_prohibited", { gameId });
  }
}

export class CipherIntegrityError extends DomainError {}
