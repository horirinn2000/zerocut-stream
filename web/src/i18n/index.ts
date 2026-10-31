import {
  type MessageKey,
  type MessageParams,
  type SupportedLocale,
  messages,
} from "./messages";

export type { MessageKey, MessageParams, SupportedLocale };

export interface Translator {
  readonly locale: SupportedLocale;
  t(key: MessageKey, params?: MessageParams): string;
}

export function resolveLocale(rawLocale?: string | null): SupportedLocale {
  if (rawLocale && rawLocale.toLowerCase().startsWith("en")) {
    return "en";
  }
  return "ja";
}

export function translate(
  locale: SupportedLocale,
  key: MessageKey,
  params?: MessageParams,
): string {
  const catalog = messages[locale];
  const template: string = catalog[key];
  if (!params) {
    return template;
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, token: string) => {
    const val = params[token];
    return val === undefined ? match : String(val);
  });
}

export function createTranslator(locale: SupportedLocale = "ja"): Translator {
  return {
    locale,
    t(key: MessageKey, params?: MessageParams): string {
      return translate(locale, key, params);
    },
  };
}
