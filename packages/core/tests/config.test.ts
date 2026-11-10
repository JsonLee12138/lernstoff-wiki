import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LERNSTOFF_CONFIG,
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  resetConfigToDefaults,
} from "../src/config.js";

describe("LernstoffConfig (Zero-Config Out-of-the-Box Defaults)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lernstoff-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads complete default config when config.json does not exist", () => {
    const config = loadConfig(tempDir);
    expect(config).toEqual(DEFAULT_LERNSTOFF_CONFIG);
    expect(config.server.port).toBe(8188);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.gate.tauOff).toBe(0.35);
    expect(config.gate.tauCore).toBe(0.65);
    expect(config.gate.maxSemRedundant).toBe(0.82);
    expect(config.socratic.minOutboundLinks).toBe(2);
    expect(config.scratchpad.ttlDays).toBe(14);
  });

  it("partially populated config falls back to default values for omitted fields", () => {
    saveConfig(tempDir, {
      server: { port: 9000 } as any,
    });
    const loaded = loadConfig(tempDir);
    expect(loaded.server.port).toBe(9000);
    expect(loaded.server.host).toBe("127.0.0.1");
    expect(loaded.gate.tauOff).toBe(0.35);
  });

  it("gets and sets nested dot-path values with type safety", () => {
    setConfigValue(tempDir, "gate.tauCore", 0.75);
    expect(getConfigValue(tempDir, "gate.tauCore")).toBe(0.75);

    // Boolean string parsing
    setConfigValue(tempDir, "server.autoStartOnBoot", "true");
    expect(getConfigValue(tempDir, "server.autoStartOnBoot")).toBe(true);

    // Number string parsing
    setConfigValue(tempDir, "server.port", "8200");
    expect(getConfigValue(tempDir, "server.port")).toBe(8200);

    const config = loadConfig(tempDir);
    expect(config.server.port).toBe(8200);
    expect(config.server.autoStartOnBoot).toBe(true);
    expect(config.gate.tauCore).toBe(0.75);
  });

  it("resets single section or entire config to defaults", () => {
    setConfigValue(tempDir, "gate.tauCore", 0.99);
    setConfigValue(tempDir, "server.port", 9999);

    resetConfigToDefaults(tempDir, "gate");
    expect(getConfigValue(tempDir, "gate.tauCore")).toBe(0.65);
    expect(getConfigValue(tempDir, "server.port")).toBe(9999);

    resetConfigToDefaults(tempDir);
    expect(getConfigValue(tempDir, "server.port")).toBe(8188);
  });
});
