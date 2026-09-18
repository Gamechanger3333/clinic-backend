import { describe, it, expect } from "vitest";
import { isDemoAccount, DEMO_USER_EMAIL } from "../lib/demo";

describe("isDemoAccount", () => {
  it("matches the configured demo email", () => {
    expect(isDemoAccount(DEMO_USER_EMAIL)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDemoAccount(DEMO_USER_EMAIL.toUpperCase())).toBe(true);
  });

  it("returns false for any other email", () => {
    expect(isDemoAccount("someone@example.com")).toBe(false);
  });

  it("returns false for null/undefined/empty input without throwing", () => {
    expect(isDemoAccount(undefined)).toBe(false);
    expect(isDemoAccount(null)).toBe(false);
    expect(isDemoAccount("")).toBe(false);
  });
});
