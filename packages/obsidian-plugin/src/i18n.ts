import * as obsidian from "obsidian";
import en from "./locales/en.json" with { type: "json" };
import zh from "./locales/zh.json" with { type: "json" };
import zhTW from "./locales/zh-TW.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };

export type SupportedLocale = "en" | "zh" | "zh-TW" | "ja" | "ko";

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = [
  "en",
  "zh",
  "zh-TW",
  "ja",
  "ko",
] as const;

export type LocaleTranslations = Record<string, unknown>;

export const translations: Record<SupportedLocale, LocaleTranslations> = {
  en: en as LocaleTranslations,
  zh: zh as LocaleTranslations,
  "zh-TW": zhTW as LocaleTranslations,
  ja: ja as LocaleTranslations,
  ko: ko as LocaleTranslations,
};

/**
 * Normalizes any locale string or Obsidian language code into one of 5 supported locales.
 *
 * Rules:
 * - Simplified Chinese: zh, zh-cn, zh-sg, zh-hans -> "zh"
 * - Traditional Chinese: zh-tw, zh-hk, zh-mo, zh-hant -> "zh-TW"
 * - Japanese: ja, ja-* -> "ja"
 * - Korean: ko, ko-* -> "ko"
 * - All others (en, en-*, fr, de, null, undefined, empty) -> "en"
 */
export function normalizeLocale(raw?: string | null): SupportedLocale {
  if (!raw || typeof raw !== "string") {
    return "en";
  }
  const clean = raw.trim().toLowerCase();
  if (!clean) {
    return "en";
  }

  // Traditional Chinese variants
  if (
    clean === "zh-tw" ||
    clean === "zh-hk" ||
    clean === "zh-mo" ||
    clean === "zh-hant" ||
    clean.startsWith("zh-tw-") ||
    clean.startsWith("zh-hk-") ||
    clean.startsWith("zh-mo-") ||
    clean.startsWith("zh-hant-")
  ) {
    return "zh-TW";
  }

  // Simplified Chinese variants
  if (
    clean === "zh" ||
    clean === "zh-cn" ||
    clean === "zh-sg" ||
    clean === "zh-hans" ||
    clean.startsWith("zh-cn-") ||
    clean.startsWith("zh-sg-") ||
    clean.startsWith("zh-hans-")
  ) {
    return "zh";
  }

  // Japanese
  if (clean === "ja" || clean.startsWith("ja-")) {
    return "ja";
  }

  // Korean
  if (clean === "ko" || clean.startsWith("ko-")) {
    return "ko";
  }

  // Default fallback
  return "en";
}

/**
 * Resolves current Obsidian app language safely.
 *
 * Checks:
 * 1. obsidian.getLanguage() if function exists (Obsidian >= 1.8.7)
 * 2. window.localStorage.getItem("language") (Obsidian < 1.8.7)
 * 3. Default to "en"
 */
export function resolveObsidianLocale(): SupportedLocale {
  try {
    const obs = obsidian as { getLanguage?: () => unknown };
    if (typeof obs.getLanguage === "function") {
      const lang = obs.getLanguage();
      if (typeof lang === "string") {
        return normalizeLocale(lang);
      }
    }
  } catch {
    // Non-fatal, fall through to localStorage
  }

  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const stored = window.localStorage.getItem("language");
      if (stored) {
        return normalizeLocale(stored);
      }
    }
  } catch {
    // Non-fatal, fall through to default
  }

  return "en";
}

/**
 * Returns currently active SupportedLocale.
 */
export function getLocale(): SupportedLocale {
  return resolveObsidianLocale();
}

/**
 * Look up key in dictionary supporting both flat keys and nested dot paths.
 */
function lookupKey(dict: LocaleTranslations, key: string): string | undefined {
  if (typeof dict[key] === "string") {
    return dict[key] as string;
  }
  const parts = key.split(".");
  let cur: unknown = dict;
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Translate a key into the active Obsidian locale with fallback to English and the raw key.
 * Supports {param} interpolation.
 */
export function t(
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string {
  const currentLocale = getLocale();
  let message: string | undefined;

  // 1. Try active locale
  const activeDict = translations[currentLocale];
  if (activeDict) {
    message = lookupKey(activeDict, key);
  }

  // 2. Fall back to English
  if (message === undefined && currentLocale !== "en") {
    const enDict = translations.en;
    if (enDict) {
      message = lookupKey(enDict, key);
    }
  }

  // 3. Fall back to key itself
  const template = message !== undefined ? message : key;

  // 4. Interpolate {param} placeholders if params provided
  if (params && typeof template === "string" && template.includes("{")) {
    return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (match, paramName) => {
      if (Object.prototype.hasOwnProperty.call(params, paramName)) {
        const val = params[paramName];
        return val !== undefined && val !== null ? String(val) : "";
      }
      return match;
    });
  }

  return template;
}
