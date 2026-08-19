import { describe, it, expect } from "vitest";
import { checkPasswordStrength } from "../lib/auth";

describe("checkPasswordStrength", () => {
  it("rejects passwords shorter than 8 characters", () => {
    const result = checkPasswordStrength("Ab1!");
    expect(result.valid).toBe(false);
    expect(result.feedback).toContain("Password must be at least 8 characters");
  });

  it("rejects passwords missing an uppercase letter", () => {
    const result = checkPasswordStrength("lowercase1!");
    expect(result.valid).toBe(false);
    expect(result.feedback).toContain("Add at least one uppercase letter");
  });

  it("rejects passwords missing a special character", () => {
    const result = checkPasswordStrength("Password123");
    expect(result.valid).toBe(false);
    expect(result.feedback).toContain("Add at least one special character (!@#$%^&*)");
  });

  it("accepts a password satisfying every rule", () => {
    const result = checkPasswordStrength("Str0ng!Pass");
    expect(result.valid).toBe(true);
    expect(result.feedback).toHaveLength(0);
  });

  it("penalises common patterns like 'password' or '123'", () => {
    const weak = checkPasswordStrength("Password123!");
    const strong = checkPasswordStrength("Xk9#mQ2!vLp");
    expect(weak.score).toBeLessThan(strong.score);
  });

  it("clamps score into the 0–4 range", () => {
    const result = checkPasswordStrength("aaaaaaaa");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(4);
  });
});
