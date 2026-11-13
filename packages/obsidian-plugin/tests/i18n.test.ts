import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let currentMockLanguageFn: (() => string) | undefined = undefined;

vi.mock("obsidian", () => {
  return {
    get getLanguage() {
      return currentMockLanguageFn;
    },
  };
});

import { normalizeLocale, resolveObsidianLocale, getLocale, t, translations } from "../src/i18n.js";

describe("i18n runtime helper", () => {
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    currentMockLanguageFn = undefined;
    if (typeof window !== "undefined") {
      originalLocalStorage = window.localStorage;
    }
  });

  afterEach(() => {
    currentMockLanguageFn = undefined;

    // Restore localStorage
    if (typeof window !== "undefined" && originalLocalStorage) {
      Object.defineProperty(window, "localStorage", {
        value: originalLocalStorage,
        writable: true,
        configurable: true,
      });
    }
    vi.restoreAllMocks();
  });

  describe("normalizeLocale", () => {
    it("maps Simplified Chinese variations to 'zh'", () => {
      expect(normalizeLocale("zh")).toBe("zh");
      expect(normalizeLocale("zh-CN")).toBe("zh");
      expect(normalizeLocale("zh-cn")).toBe("zh");
      expect(normalizeLocale("zh-SG")).toBe("zh");
      expect(normalizeLocale("zh-hans")).toBe("zh");
      expect(normalizeLocale("zh-Hans-CN")).toBe("zh");
    });

    it("maps Traditional Chinese variations to 'zh-TW'", () => {
      expect(normalizeLocale("zh-TW")).toBe("zh-TW");
      expect(normalizeLocale("zh-tw")).toBe("zh-TW");
      expect(normalizeLocale("zh-HK")).toBe("zh-TW");
      expect(normalizeLocale("zh-MO")).toBe("zh-TW");
      expect(normalizeLocale("zh-hant")).toBe("zh-TW");
      expect(normalizeLocale("zh-Hant-TW")).toBe("zh-TW");
    });

    it("maps Japanese variations to 'ja'", () => {
      expect(normalizeLocale("ja")).toBe("ja");
      expect(normalizeLocale("ja-JP")).toBe("ja");
      expect(normalizeLocale("ja-jp")).toBe("ja");
    });

    it("maps Korean variations to 'ko'", () => {
      expect(normalizeLocale("ko")).toBe("ko");
      expect(normalizeLocale("ko-KR")).toBe("ko");
      expect(normalizeLocale("ko-kr")).toBe("ko");
    });

    it("falls back to 'en' for English, unknown locales, empty, null, and undefined", () => {
      expect(normalizeLocale("en")).toBe("en");
      expect(normalizeLocale("en-US")).toBe("en");
      expect(normalizeLocale("en-GB")).toBe("en");
      expect(normalizeLocale("fr")).toBe("en");
      expect(normalizeLocale("de")).toBe("en");
      expect(normalizeLocale("es")).toBe("en");
      expect(normalizeLocale("")).toBe("en");
      expect(normalizeLocale("   ")).toBe("en");
      expect(normalizeLocale(null)).toBe("en");
      expect(normalizeLocale(undefined)).toBe("en");
    });
  });

  describe("resolveObsidianLocale & getLocale", () => {
    it("uses obsidian.getLanguage() when available", () => {
      currentMockLanguageFn = () => "zh-TW";
      expect(resolveObsidianLocale()).toBe("zh-TW");
      expect(getLocale()).toBe("zh-TW");

      currentMockLanguageFn = () => "ja-JP";
      expect(resolveObsidianLocale()).toBe("ja");
      expect(getLocale()).toBe("ja");

      currentMockLanguageFn = () => "ko-KR";
      expect(resolveObsidianLocale()).toBe("ko");
      expect(getLocale()).toBe("ko");

      currentMockLanguageFn = () => "fr";
      expect(resolveObsidianLocale()).toBe("en");
      expect(getLocale()).toBe("en");
    });

    it("falls back to window.localStorage.getItem('language') when getLanguage is absent", () => {
      currentMockLanguageFn = undefined;

      const mockGetItem = vi.fn((key: string) => (key === "language" ? "zh-cn" : null));
      const fakeStorage = {
        getItem: mockGetItem,
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: vi.fn(),
        length: 1,
      };

      if (typeof window === "undefined") {
        (globalThis as unknown as { window: unknown }).window = { localStorage: fakeStorage };
      } else {
        Object.defineProperty(window, "localStorage", {
          value: fakeStorage,
          writable: true,
          configurable: true,
        });
      }

      expect(resolveObsidianLocale()).toBe("zh");
      expect(getLocale()).toBe("zh");
      expect(mockGetItem).toHaveBeenCalledWith("language");
    });

    it("defaults to 'en' when both getLanguage and localStorage are missing or empty", () => {
      currentMockLanguageFn = undefined;

      const mockGetItem = vi.fn(() => null);
      const fakeStorage = {
        getItem: mockGetItem,
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: vi.fn(),
        length: 0,
      };

      if (typeof window === "undefined") {
        (globalThis as unknown as { window: unknown }).window = { localStorage: fakeStorage };
      } else {
        Object.defineProperty(window, "localStorage", {
          value: fakeStorage,
          writable: true,
          configurable: true,
        });
      }

      expect(resolveObsidianLocale()).toBe("en");
      expect(getLocale()).toBe("en");
    });
  });

  describe("t helper", () => {
    beforeEach(() => {
      // Setup test translation keys in memory
      translations.en = {
        greeting: "Hello, {name}!",
        common: {
          save: "Save",
          server: {
            status: "Server is running on port {port}",
          },
        },
      };
      translations.zh = {
        common: {
          save: "保存",
        },
      };
      translations["zh-TW"] = {
        common: {
          save: "儲存",
        },
      };
    });

    afterEach(() => {
      translations.en = {};
      translations.zh = {};
      translations["zh-TW"] = {};
      translations.ja = {};
      translations.ko = {};
    });

    it("returns key if not found in active locale or fallback en", () => {
      expect(t("non.existent.key")).toBe("non.existent.key");
    });

    it("finds keys in active locale", () => {
      currentMockLanguageFn = () => "zh-CN";
      expect(t("common.save")).toBe("保存");

      currentMockLanguageFn = () => "zh-TW";
      expect(t("common.save")).toBe("儲存");
    });

    it("falls back to English when key is missing in active locale", () => {
      currentMockLanguageFn = () => "zh-CN";
      expect(t("greeting", { name: "Bob" })).toBe("Hello, Bob!");
      expect(t("common.server.status", { port: 3000 })).toBe("Server is running on port 3000");
    });

    it("interpolates parameters in string with {param}", () => {
      currentMockLanguageFn = () => "en";
      expect(t("greeting", { name: "Alice" })).toBe("Hello, Alice!");
      expect(t("common.server.status", { port: 8080 })).toBe("Server is running on port 8080");
    });

    it("interpolates parameters even when falling back to raw key", () => {
      expect(t("Port {port} on {host}", { port: 8080, host: "localhost" })).toBe(
        "Port 8080 on localhost",
      );
    });

    it("leaves missing placeholders intact", () => {
      expect(t("Missing {placeholder} here", {})).toBe("Missing {placeholder} here");
    });
  });
});
