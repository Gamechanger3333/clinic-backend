import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

// ─── Secrets ────────────────────────────────────────────────────────────────
const ACCESS_SECRET = new TextEncoder().encode(
  process.env.ACCESS_TOKEN_SECRET || "change-this-access-token-secret-min-32-chars-long"
);
const REFRESH_SECRET = new TextEncoder().encode(
  process.env.REFRESH_TOKEN_SECRET || "change-this-refresh-token-secret-min-32-chars-long"
);

export const ACCESS_COOKIE = "clinicflow_access";
export const REFRESH_COOKIE = "clinicflow_refresh";

const ACCESS_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES_IN || "15m";
const REFRESH_EXPIRES = process.env.REFRESH_TOKEN_EXPIRES_IN || "7d";

// ─── Payload type ───────────────────────────────────────────────────────────
export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
  fullName: string;
  tokenVersion?: number; // for invalidating all sessions
}

// ─── In-memory refresh-token blacklist ──────────────────────────────────────
// In production, replace with Redis: SET jti EX <ttl>
const blacklistedJtis = new Set<string>();

export function blacklistToken(jti: string) {
  blacklistedJtis.add(jti);
}
export function isBlacklisted(jti: string): boolean {
  return blacklistedJtis.has(jti);
}

// ─── Token generation ───────────────────────────────────────────────────────
export async function signAccessToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(ACCESS_EXPIRES)
    .setJti(crypto.randomUUID())
    .sign(ACCESS_SECRET);
}

export async function signRefreshToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(REFRESH_EXPIRES)
    .setJti(crypto.randomUUID())
    .sign(REFRESH_SECRET);
}

// ─── Token verification ─────────────────────────────────────────────────────
export async function verifyAccessToken(token: string): Promise<(JWTPayload & { jti?: string }) | null> {
  try {
    const { payload } = await jwtVerify(token, ACCESS_SECRET);
    return payload as unknown as JWTPayload & { jti?: string };
  } catch {
    return null;
  }
}

export async function verifyRefreshToken(token: string): Promise<(JWTPayload & { jti: string }) | null> {
  try {
    const { payload } = await jwtVerify(token, REFRESH_SECRET);
    const p = payload as unknown as JWTPayload & { jti: string };
    if (isBlacklisted(p.jti)) return null;
    return p;
  } catch {
    return null;
  }
}

// ─── Cookie helpers ─────────────────────────────────────────────────────────
const isProd = process.env.NODE_ENV === "production";

export const ACCESS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax" as const,
  maxAge: 15 * 60,           // 15 minutes
  path: "/",
};

export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax" as const,
  maxAge: 7 * 24 * 60 * 60,  // 7 days
  path: "/",                  // broad path for proxy compatibility
};

// ─── Password helpers ────────────────────────────────────────────────────────
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ─── Account lockout (brute-force protection) ─────────────────────────────
// Simple in-memory store. Replace with Redis in production.
const failedAttempts = new Map<string, { count: number; lockedUntil?: number }>();

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export function recordFailedLogin(email: string): { locked: boolean; remainingMs?: number } {
  const now = Date.now();
  const rec = failedAttempts.get(email) ?? { count: 0 };

  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { locked: true, remainingMs: rec.lockedUntil - now };
  }

  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
  }
  failedAttempts.set(email, rec);
  return { locked: rec.count >= MAX_ATTEMPTS, remainingMs: rec.lockedUntil ? rec.lockedUntil - now : undefined };
}

export function isAccountLocked(email: string): { locked: boolean; remainingMs?: number } {
  const now = Date.now();
  const rec = failedAttempts.get(email);
  if (!rec?.lockedUntil) return { locked: false };
  if (now >= rec.lockedUntil) {
    failedAttempts.delete(email); // auto-unlock
    return { locked: false };
  }
  return { locked: true, remainingMs: rec.lockedUntil - now };
}

export function clearFailedAttempts(email: string) {
  failedAttempts.delete(email);
}

// ─── Token version check (invalidate all sessions for a user) ──────────────
// We store tokenVersion on User. If token's version < DB version → reject.
// This is already in the prisma schema as optional; we use a simple approach:
// increment DB field to kill all sessions.
export async function validateTokenVersion(userId: string, tokenVersion: number): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } });
  if (!user) return false;
  return user.tokenVersion === tokenVersion;
}
