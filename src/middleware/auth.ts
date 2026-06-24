import { Request, Response, NextFunction } from "express";
import {
  verifyAccessToken,
  signAccessToken,
  verifyRefreshToken,
  blacklistToken,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
  validateTokenVersion,
  JWTPayload,
} from "../lib/auth";

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload & { jti?: string };
    }
  }
}

// ─── Main auth middleware ─────────────────────────────────────────────────
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const accessToken = req.cookies[ACCESS_COOKIE];
  const refreshToken = req.cookies[REFRESH_COOKIE];

  // 1) Try access token
  if (accessToken) {
    const payload = await verifyAccessToken(accessToken);
    if (payload) {
      // Validate token version (catches "logout all sessions")
      const valid = await validateTokenVersion(payload.userId, payload.tokenVersion ?? 0);
      if (valid) {
        req.user = payload;
        return next();
      }
    }
  }

  // 2) Access token missing/expired → try refresh token (silent rotation)
  if (refreshToken) {
    const payload = await verifyRefreshToken(refreshToken);
    if (payload) {
      const valid = await validateTokenVersion(payload.userId, payload.tokenVersion ?? 0);
      if (valid) {
        // Blacklist the old refresh token (rotation — prevents reuse)
        blacklistToken(payload.jti);

        // Issue new token pair
        const { jti: _jti, ...cleanPayload } = payload as any;
        const newAccess = await signAccessToken(cleanPayload);
        const { SignJWT } = await import("jose");
        const REFRESH_SECRET = new TextEncoder().encode(
          process.env.REFRESH_TOKEN_SECRET || "change-this-refresh-token-secret-min-32-chars-long"
        );
        const newRefresh = await new SignJWT({ ...cleanPayload })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt()
          .setExpirationTime(process.env.REFRESH_TOKEN_EXPIRES_IN || "7d")
          .setJti(crypto.randomUUID())
          .sign(REFRESH_SECRET);

        res.cookie(ACCESS_COOKIE, newAccess, ACCESS_COOKIE_OPTIONS);
        res.cookie(REFRESH_COOKIE, newRefresh, REFRESH_COOKIE_OPTIONS);

        req.user = cleanPayload;
        return next();
      }
    }
  }

  return res.status(401).json({ error: "Unauthorized" });
}

// ─── Role-based access control ────────────────────────────────────────────
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${roles.join(" or ")}` });
    }
    return next();
  };
}
