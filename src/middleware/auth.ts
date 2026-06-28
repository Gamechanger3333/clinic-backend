/**
 * src/middleware/auth.ts — Enterprise Auth Middleware
 *
 * - Validates access token (httpOnly cookie)
 * - Silent refresh: rotates refresh token on-the-fly when access token expires
 * - CSRF protection for state-mutating requests
 * - Role-based access control (RBAC)
 * - Injects typed req.user
 */

import { Request, Response, NextFunction } from "express";
import {
  verifyAccessToken,
  verifyRefreshToken,
  signAccessToken,
  signRefreshToken,
  revokeRefreshToken,
  validateTokenVersion,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
  verifyCsrfToken,
  JWTPayload,
  auditLog,
} from "../lib/auth";

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload & { jti?: string };
    }
  }
}

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
         req.socket.remoteAddress || "unknown";
}

// ─── CSRF Middleware ──────────────────────────────────────────────────────────
// Protects state-mutating endpoints. Cookie-to-header double-submit pattern.
// The frontend must send X-CSRF-Token header matching the cf_csrf cookie value.
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "cf_csrf";

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();

  const tokenFromCookie = req.cookies[CSRF_COOKIE];
  const tokenFromHeader = req.headers["x-csrf-token"] as string;

  if (!verifyCsrfToken(tokenFromCookie, tokenFromHeader)) {
    return res.status(403).json({ error: "Invalid CSRF token" });
  }
  return next();
}

// ─── Main Auth Middleware ─────────────────────────────────────────────────────
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const accessToken  = req.cookies[ACCESS_COOKIE];
  const refreshToken = req.cookies[REFRESH_COOKIE];
  const ip           = getIp(req);
  const ua           = req.headers["user-agent"];

  // 1) Try access token
  if (accessToken) {
    const payload = await verifyAccessToken(accessToken);
    if (payload) {
      const valid = await validateTokenVersion(payload.userId, payload.tokenVersion ?? 0);
      if (valid) {
        req.user = payload;
        return next();
      }
    }
  }

  // 2) Silent refresh — access token missing or expired
  if (refreshToken) {
    const result = await verifyRefreshToken(refreshToken);
    if (result) {
      const { payload } = result;
      const jti = payload.jti;
      const valid = await validateTokenVersion(payload.userId, payload.tokenVersion ?? 0);
      if (valid) {
        const { jti: _jti, iat: _iat, exp: _exp, ...cleanPayload } = payload as any;

        // Sign the new pair FIRST so we have its jti to link the old token to
        // (replacedByJti) before revoking — this lets a concurrent request
        // racing on the same old refresh cookie follow the chain instead of
        // being rejected. See verifyRefreshToken's race-safety logic.
        const newAccess = await signAccessToken(cleanPayload);
        const { token: newRefresh, jti: newJti } = await signRefreshToken(cleanPayload, { userAgent: ua, ipAddress: ip });

        await revokeRefreshToken(jti, newJti);

        res.cookie(ACCESS_COOKIE,  newAccess,  ACCESS_COOKIE_OPTIONS);
        res.cookie(REFRESH_COOKIE, newRefresh, REFRESH_COOKIE_OPTIONS);

        req.user = cleanPayload;

        await auditLog("TOKEN_REFRESHED", { userId: cleanPayload.userId, ipAddress: ip, userAgent: ua });
        return next();
      }
    }
  }

  return res.status(401).json({ error: "Unauthorized — please sign in" });
}

// ─── Optional Auth (doesn't fail if unauthenticated) ──────────────────────────
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const accessToken = req.cookies[ACCESS_COOKIE];
  if (accessToken) {
    const payload = await verifyAccessToken(accessToken);
    if (payload) {
      const valid = await validateTokenVersion(payload.userId, payload.tokenVersion ?? 0);
      if (valid) req.user = payload;
    }
  }
  return next();
}

// ─── RBAC Middleware ──────────────────────────────────────────────────────────
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error:    "Forbidden",
        required: roles,
        current:  req.user.role,
      });
    }
    return next();
  };
}

// ─── Email Verified Guard ─────────────────────────────────────────────────────
export function requireEmailVerified() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const { prisma } = await import("../lib/prisma");
    const user = await prisma.user.findUnique({
      where:  { id: req.user.userId },
      select: { isEmailVerified: true },
    });
    if (!user?.isEmailVerified) {
      return res.status(403).json({
        error: "Email not verified. Please verify your email to access this resource.",
        code:  "EMAIL_NOT_VERIFIED",
      });
    }
    return next();
  };
}