import { describe, it, expect } from "vitest";
import { generateCsrfToken, verifyCsrfToken } from "../lib/auth";

describe("CSRF double-submit token", () => {
  it("generates a hex token of the expected length", () => {
    const token = generateCsrfToken();
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it("verifies successfully when cookie and header match", () => {
    const token = generateCsrfToken();
    expect(verifyCsrfToken(token, token)).toBe(true);
  });

  it("rejects when cookie and header differ", () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(verifyCsrfToken(a, b)).toBe(false);
  });

  it("rejects when either value is missing", () => {
    const token = generateCsrfToken();
    expect(verifyCsrfToken("", token)).toBe(false);
    expect(verifyCsrfToken(token, "")).toBe(false);
    expect(verifyCsrfToken("", "")).toBe(false);
  });

  it("rejects a real cookie against a non-hex header without throwing", () => {
    // Realistic scenario: cookie is server-issued (always valid hex);
    // header is attacker/client-controlled and may be garbage.
    const cookie = generateCsrfToken();
    expect(() => verifyCsrfToken(cookie, "not-hex!!")).not.toThrow();
    expect(verifyCsrfToken(cookie, "not-hex!!")).toBe(false);
  });

  it("rejects mismatched-length tokens without throwing", () => {
    const token = generateCsrfToken();
    expect(() => verifyCsrfToken(token, token + "ab")).not.toThrow();
    expect(verifyCsrfToken(token, token + "ab")).toBe(false);
  });
});
