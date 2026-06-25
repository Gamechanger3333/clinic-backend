/**
 * src/middleware/rateLimiter.ts — Enterprise Rate Limiting
 *
 * Multiple tiers:
 *  - authLimiter:         Strict — 5 attempts / 15 min (auth endpoints)
 *  - otpLimiter:          Very strict — 3 attempts / 10 min (OTP)
 *  - passwordResetLimiter: 3 requests / hour (forgot-password)
 *  - apiLimiter:          100 requests / min (general API)
 *  - strictApiLimiter:    30 requests / min (sensitive endpoints)
 *
 * Key by IP + optional identifier to prevent credential stuffing.
 * In production, swap the default MemoryStore for rate-limit-redis.
 */

import rateLimit, { Options } from "express-rate-limit";
import { Request, Response } from "express";

function getIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// ─── Shared response builder ──────────────────────────────────────────────────
function rateLimitHandler(
  _req: Request,
  res: Response,
  _next: any,
  options: Options
) {
  res.status(options.statusCode ?? 429).json({
    error:     options.message as string,
    retryAfter: Math.ceil((options.windowMs ?? 60000) / 1000),
  });
}

// ─── Auth Limiter (login, signup, refresh) ────────────────────────────────────
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max:      5,
  message:  "Too many authentication attempts. Please wait 15 minutes and try again.",
  keyGenerator: (req) => {
    // Key by IP + email body (if present) to prevent per-account stuffing
    const email = (req.body?.email || "").toLowerCase().trim();
    return `auth:${getIp(req)}:${email}`;
  },
  handler:              rateLimitHandler,
  standardHeaders:      true,
  legacyHeaders:        false,
  skipSuccessfulRequests: true, // only count failures
});

// ─── OTP / Verify Limiter ─────────────────────────────────────────────────────
export const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 minutes
  max:      3,
  message:  "Too many OTP attempts. Please wait 10 minutes.",
  keyGenerator: (req) => `otp:${getIp(req)}`,
  handler:      rateLimitHandler,
  standardHeaders: true,
  legacyHeaders:   false,
});

// ─── Password Reset Limiter ───────────────────────────────────────────────────
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max:      3,
  message:  "Too many password reset requests. Please try again in 1 hour.",
  keyGenerator: (req) => {
    const email = (req.body?.email || "").toLowerCase().trim();
    return `pwreset:${getIp(req)}:${email}`;
  },
  handler:      rateLimitHandler,
  standardHeaders: true,
  legacyHeaders:   false,
});

// ─── General API Limiter ──────────────────────────────────────────────────────
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max:      100,
  message:  "Too many requests. Please slow down.",
  keyGenerator: (req) => getIp(req),
  handler:      rateLimitHandler,
  standardHeaders: true,
  legacyHeaders:   false,
});

// ─── Strict API Limiter (sensitive reads — audit logs, user list, etc.) ────────
export const strictApiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max:      30,
  message:  "Rate limit exceeded for this endpoint.",
  keyGenerator: (req) => `strict:${getIp(req)}`,
  handler:      rateLimitHandler,
  standardHeaders: true,
  legacyHeaders:   false,
});

// ─── Signup Limiter ───────────────────────────────────────────────────────────
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max:      5,
  message:  "Too many accounts created from this IP. Please try again later.",
  keyGenerator: (req) => `signup:${getIp(req)}`,
  handler:      rateLimitHandler,
  standardHeaders: true,
  legacyHeaders:   false,
});