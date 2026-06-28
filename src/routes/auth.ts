/**
 * src/routes/auth.ts — Enterprise Authentication Routes
 *
 * Endpoints:
 *  POST /signup                  — Register (email verification queued)
 *  POST /login                   — Login with lockout + audit log
 *  POST /logout                  — Revoke current session
 *  POST /logout-all              — Revoke all sessions (token version bump)
 *  POST /refresh                 — Explicit token refresh
 *  GET  /me                      — Current user profile
 *  POST /verify-email            — Verify email address via token
 *  POST /resend-verification     — Resend email verification
 *  POST /send-otp                — Send OTP (login/password-reset/mfa-setup)
 *  POST /verify-otp              — Verify OTP code
 *  POST /forgot-password         — Send password-reset link
 *  POST /reset-password          — Reset password via token
 *  POST /change-password         — Change password (authenticated)
 *  POST /mfa/setup               — Generate TOTP secret & QR (admin/doctor)
 *  POST /mfa/verify              — Confirm TOTP code to enable MFA
 *  POST /mfa/disable             — Disable MFA
 *  POST /mfa/validate            — Validate TOTP during login
 *  GET  /audit-logs              — Auth audit log (admin only)
 *  GET  /sessions                — List active sessions (admin only)
 *  DELETE /sessions/:jti         — Revoke a specific session
 *  GET  /csrf-token              — Issue CSRF token
 *  POST /check-password-strength — Real-time password strength check
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  hashPassword,
  comparePassword,
  checkPasswordStrength,
  recordFailedLogin,
  isAccountLocked,
  clearFailedAttempts,
  generateOtp,
  verifyOtp,
  generateSecureToken,
  generateCsrfToken,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
  auditLog,
} from "../lib/auth";
import {
  sendEmailVerification,
  sendOtpEmail,
  sendPasswordReset,
  sendSecurityAlert,
} from "../lib/email";
import { authenticate, requireRole } from "../middleware/auth";
import {
  authLimiter,
  otpLimiter,
  passwordResetLimiter,
  signupLimiter,
  strictApiLimiter,
} from "../middleware/rateLimiter";

const router = Router();

// ─── Input Schemas ────────────────────────────────────────────────────────────
// SECURITY: `role` is intentionally NOT accepted here. Public self-signup
// must never be able to grant privileged roles (admin/doctor/receptionist).
// Privileged accounts are created via POST /api/auth/admin/create-user,
// which requires an authenticated admin caller.
const signupSchema = z.object({
  email:    z.string().email("Invalid email address").max(254).toLowerCase().trim(),
  password: z.string().min(8, "Min 8 characters").max(128, "Password too long"),
  fullName: z.string().min(2, "Full name too short").max(100).trim(),
  phone:    z.string().max(20).optional(),
});

// Used only by the admin-only user-creation endpoint below.
const adminCreateUserSchema = z.object({
  email:    z.string().email("Invalid email address").max(254).toLowerCase().trim(),
  password: z.string().min(8, "Min 8 characters").max(128, "Password too long"),
  fullName: z.string().min(2, "Full name too short").max(100).trim(),
  role:     z.enum(["admin", "doctor", "receptionist", "patient"]),
  phone:    z.string().max(20).optional(),
});

const loginSchema = z.object({
  email:    z.string().email().toLowerCase().trim(),
  password: z.string().min(1).max(128),
  otpCode:  z.string().length(6).optional(), // for MFA step
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword:     z.string().min(8, "Min 8 characters").max(128),
});

const forgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

const resetPasswordSchema = z.object({
  token:    z.string().min(1),
  password: z.string().min(8).max(128),
});

const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

const sendOtpSchema = z.object({
  purpose: z.enum(["login", "password_reset", "mfa_setup"]),
});

const verifyOtpSchema = z.object({
  code:    z.string().length(6, "OTP must be 6 digits"),
  purpose: z.enum(["login", "password_reset", "mfa_setup"]),
});

const mfaVerifySchema = z.object({
  totpCode: z.string().min(6).max(8),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
         req.socket.remoteAddress || "unknown";
}

function getUserAgent(req: Request): string {
  return req.headers["user-agent"] || "unknown";
}

async function issueTokenPair(
  res:     Response,
  payload: { userId: string; email: string; role: string; fullName: string; tokenVersion: number },
  req:     Request
) {
  const accessToken = await signAccessToken(payload);
  const { token: refreshToken } = await signRefreshToken(payload, {
    userAgent: getUserAgent(req),
    ipAddress: getIp(req),
  });
  res.cookie(ACCESS_COOKIE,  accessToken,  ACCESS_COOKIE_OPTIONS);
  res.cookie(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTIONS);

  // Issue CSRF token alongside auth cookies
  const csrfToken = generateCsrfToken();
  res.cookie("cf_csrf", csrfToken, {
    httpOnly: false,               // JS must read this to send as header
    secure:   process.env.NODE_ENV === "production",
    // NOTE: this cookie is intentionally "lax", not "strict". It's the
    // double-submit CSRF token, not a session credential — the real
    // session lives in the httpOnly cf_at/cf_rt cookies, which stay
    // "strict". "strict" here was being silently dropped by the browser
    // for the frontend(3000)/backend(5000) cross-port dev setup, which
    // meant the cookie never reached document.cookie at all and every
    // mutating request failed CSRF validation.
    sameSite: "lax",
    maxAge:   15 * 60 * 1000, // ms — Express res.cookie() maxAge is milliseconds, NOT seconds
    path:     "/",
  });

  return { accessToken, refreshToken };
}

// ─── POST /api/auth/csrf-token ────────────────────────────────────────────────
router.get("/csrf-token", (_req, res) => {
  const token = generateCsrfToken();
  res.cookie("cf_csrf", token, {
    httpOnly: false,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax", // see note in issueTokenPair above
    maxAge:   15 * 60 * 1000, // ms — Express res.cookie() maxAge is milliseconds, NOT seconds
    path:     "/",
  });
  return res.json({ csrfToken: token });
});

// ─── POST /api/auth/check-password-strength ───────────────────────────────────
router.post("/check-password-strength", (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Password required" });
  }
  const result = checkPasswordStrength(password);
  return res.json(result);
});

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
// Public self-signup always creates a "patient" account. Privileged roles
// (admin/doctor/receptionist) can only be created by an authenticated admin
// via POST /api/auth/admin/create-user — see below.
router.post("/signup", signupLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password, fullName, phone } = signupSchema.parse(req.body);
    const role = "patient" as const;

    // Password strength check
    const strength = checkPasswordStrength(password);
    if (!strength.valid) {
      return res.status(400).json({ error: strength.feedback.join(". "), strength });
    }

    // Duplicate email — always return 409, but don't leak email status timing
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const emailVerifyToken   = generateSecureToken();
    const emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email,
        password:           await hashPassword(password),
        fullName,
        role,
        phone,
        tokenVersion:       0,
        isEmailVerified:    false,
        emailVerifyToken,
        emailVerifyExpires,
      },
    });

    // Auto-create patient record
    await prisma.patient.create({
      data: { fullName: user.fullName, email: user.email, phone: user.phone, createdBy: user.id },
    });

    // Send verification email (non-blocking)
    sendEmailVerification(email, fullName, emailVerifyToken).catch(console.error);

    await auditLog("SIGNUP", { userId: user.id, email, ipAddress: getIp(req), userAgent: getUserAgent(req) });

    // Issue tokens immediately (user can use app but some features require verified email)
    const payload = { userId: user.id, email: user.email, role: user.role, fullName: user.fullName, tokenVersion: 0 };
    await issueTokenPair(res, payload, req);

    return res.status(201).json({
      message:         "Account created! Please check your email to verify your address.",
      emailVerified:   false,
      user: {
        id:       user.id,
        email:    user.email,
        fullName: user.fullName,
        role:     user.role,
      },
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message || "Validation error", issues: e.issues });
    console.error("[SIGNUP ERROR]", e);
    return res.status(500).json({ error: "Server error during signup" });
  }
});

// ─── POST /api/auth/admin/create-user (admin only) ────────────────────────────
// The ONLY way to create admin/doctor/receptionist accounts. Requires an
// authenticated admin session — see requireRole("admin") below.
router.post(
  "/admin/create-user",
  authenticate,
  requireRole("admin"),
  signupLimiter,
  async (req: Request, res: Response) => {
    try {
      const { email, password, fullName, role, phone } = adminCreateUserSchema.parse(req.body);

      const strength = checkPasswordStrength(password);
      if (!strength.valid) {
        return res.status(400).json({ error: strength.feedback.join(". "), strength });
      }

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }

      const emailVerifyToken   = generateSecureToken();
      const emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const user = await prisma.user.create({
        data: {
          email,
          password:           await hashPassword(password),
          fullName,
          role:                role as any,
          phone,
          tokenVersion:        0,
          isEmailVerified:     false,
          emailVerifyToken,
          emailVerifyExpires,
        },
      });

      if (role === "patient") {
        await prisma.patient.create({
          data: { fullName: user.fullName, email: user.email, phone: user.phone, createdBy: user.id },
        });
      }

      sendEmailVerification(email, fullName, emailVerifyToken).catch(console.error);

      await auditLog("SIGNUP", {
        userId:    user.id,
        email,
        ipAddress: getIp(req),
        userAgent: getUserAgent(req),
        metadata:  { createdByAdmin: req.user!.userId, assignedRole: role },
      });

      return res.status(201).json({
        message: `${role} account created successfully.`,
        user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
      });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message || "Validation error", issues: e.issues });
      console.error("[ADMIN CREATE USER ERROR]", e);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post("/login", authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password, otpCode } = loginSchema.parse(req.body);
    const ip = getIp(req);
    const ua = getUserAgent(req);

    // Account lockout check (DB-persisted)
    const lockStatus = await isAccountLocked(email);
    if (lockStatus.locked) {
      const mins = Math.ceil((lockStatus.remainingMs || 0) / 60000);
      await auditLog("ACCOUNT_LOCKED", { email, ipAddress: ip, userAgent: ua });
      return res.status(429).json({ error: `Account temporarily locked. Try again in ${mins} minute(s).` });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // Constant-time comparison — always comparePassword even if user not found
    const dummyHash   = "$2a$12$dummy.hash.to.prevent.timing.attacks.xxxxxxxxxxxxxxxxxx";
    const passwordHash = user?.password || dummyHash;
    const passwordOk  = await comparePassword(password, passwordHash);

    if (!user || !passwordOk) {
      if (user) {
        const result = await recordFailedLogin(email);
        if (result.locked) {
          await auditLog("ACCOUNT_LOCKED", { userId: user.id, email, ipAddress: ip, userAgent: ua, metadata: { failedAttempts: 5 } });
          return res.status(429).json({ error: "Too many failed attempts. Account locked for 15 minutes." });
        }
      }
      await auditLog("LOGIN_FAILED", { email, ipAddress: ip, userAgent: ua });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // MFA check
    if (user.mfaEnabled) {
      if (!otpCode) {
        // Signal to client that MFA is required
        return res.status(200).json({ mfaRequired: true, message: "MFA code required" });
      }
      // Validate TOTP
      const { authenticator } = await import("otplib");
      const isValid = authenticator.verify({ token: otpCode, secret: user.mfaSecret! });
      if (!isValid) {
        await auditLog("OTP_FAILED", { userId: user.id, email, ipAddress: ip, userAgent: ua });
        return res.status(401).json({ error: "Invalid MFA code" });
      }
      await auditLog("OTP_VERIFIED", { userId: user.id, email, ipAddress: ip, userAgent: ua });
    }

    // Success — clear failed attempts, update last login
    await clearFailedAttempts(user.id);
    await prisma.user.update({
      where: { id: user.id },
      data:  { lastLoginAt: new Date(), lastLoginIp: ip },
    });

    const payload = {
      userId:       user.id,
      email:        user.email,
      role:         user.role,
      fullName:     user.fullName,
      tokenVersion: user.tokenVersion ?? 0,
    };
    await issueTokenPair(res, payload, req);

    await auditLog("LOGIN_SUCCESS", { userId: user.id, email, ipAddress: ip, userAgent: ua });

    return res.json({
      user: {
        id:              user.id,
        email:           user.email,
        fullName:        user.fullName,
        role:            user.role,
        phone:           user.phone,
        isEmailVerified: user.isEmailVerified,
        mfaEnabled:      user.mfaEnabled,
      },
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Invalid input", issues: e.issues });
    console.error("[LOGIN ERROR]", e);
    return res.status(500).json({ error: "Server error during login" });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post("/logout", async (req: Request, res: Response) => {
  const refreshToken = req.cookies[REFRESH_COOKIE];
  if (refreshToken) {
    const result = await verifyRefreshToken(refreshToken);
    if (result?.payload.jti) await revokeRefreshToken(result.payload.jti);
  }

  const ip = getIp(req);
  // Attempt to get userId from access token for audit
  const accessToken = req.cookies[ACCESS_COOKIE];
  if (accessToken) {
    const { verifyAccessToken } = await import("../lib/auth");
    const p = await verifyAccessToken(accessToken);
    if (p) await auditLog("LOGOUT", { userId: p.userId, email: p.email, ipAddress: ip });
  }

  res.clearCookie(ACCESS_COOKIE,  { path: "/" });
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
  res.clearCookie("cf_csrf",      { path: "/" });
  // Cleanup: clear a legacy cookie from a now-removed frontend auth system,
  // in case it's still sitting in some browsers from before that code was deleted.
  res.clearCookie("clinicflow_refresh", { path: "/" });
  return res.json({ message: "Logged out successfully" });
});

// ─── POST /api/auth/logout-all ────────────────────────────────────────────────
router.post("/logout-all", authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // Revoke all DB refresh tokens + bump token version
  await revokeAllUserTokens(userId);
  await prisma.user.update({
    where: { id: userId },
    data:  { tokenVersion: { increment: 1 } },
  });

  res.clearCookie(ACCESS_COOKIE,  { path: "/" });
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
  res.clearCookie("cf_csrf",      { path: "/" });
  res.clearCookie("clinicflow_refresh", { path: "/" });

  await auditLog("LOGOUT_ALL", { userId, email: req.user!.email, ipAddress: getIp(req) });
  return res.json({ message: "All sessions terminated successfully" });
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post("/refresh", async (req: Request, res: Response) => {
  const refreshToken = req.cookies[REFRESH_COOKIE];
  if (!refreshToken) return res.status(401).json({ error: "No refresh token" });

  const result = await verifyRefreshToken(refreshToken);
  if (!result) return res.status(401).json({ error: "Invalid or expired refresh token" });
  const { payload } = result;

  const user = await prisma.user.findUnique({
    where:  { id: payload.userId },
    select: { tokenVersion: true, role: true, fullName: true, email: true },
  });
  if (!user || user.tokenVersion !== (payload.tokenVersion ?? 0)) {
    return res.status(401).json({ error: "Session invalidated. Please sign in again." });
  }

  // Rotate (race-safe — link old -> new before revoking, see issueTokenPair/signRefreshToken)
  const { jti: _j, iat: _i, exp: _e, ...clean } = payload as any;
  const cleanPayload = { ...clean, tokenVersion: user.tokenVersion };

  const accessToken = await signAccessToken(cleanPayload);
  const { token: newRefreshToken, jti: newJti } = await signRefreshToken(cleanPayload, {
    userAgent: getUserAgent(req),
    ipAddress: getIp(req),
  });
  await revokeRefreshToken(payload.jti, newJti);

  res.cookie(ACCESS_COOKIE,  accessToken,     ACCESS_COOKIE_OPTIONS);
  res.cookie(REFRESH_COOKIE, newRefreshToken, REFRESH_COOKIE_OPTIONS);

  return res.json({ message: "Tokens refreshed" });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get("/me", authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where:  { id: req.user!.userId },
    select: {
      id: true, email: true, fullName: true, role: true, phone: true,
      avatarUrl: true, createdAt: true, isEmailVerified: true, mfaEnabled: true,
      lastLoginAt: true, lastLoginIp: true,
    },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json({ user });
});

// ─── POST /api/auth/verify-email ──────────────────────────────────────────────
router.post("/verify-email", async (req: Request, res: Response) => {
  try {
    const { token } = verifyEmailSchema.parse(req.body);

    const user = await prisma.user.findFirst({
      where: {
        emailVerifyToken:   token,
        isEmailVerified:    false,
        emailVerifyExpires: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired verification link" });
    }

    await prisma.user.update({
      where: { id: user.id },
      data:  {
        isEmailVerified:    true,
        emailVerifyToken:   null,
        emailVerifyExpires: null,
      },
    });

    await auditLog("EMAIL_VERIFIED", { userId: user.id, email: user.email, ipAddress: getIp(req) });
    return res.json({ message: "Email verified successfully! You now have full access." });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/auth/resend-verification ───────────────────────────────────────
router.post("/resend-verification", authLimiter, authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where:  { id: req.user!.userId },
    select: { id: true, email: true, fullName: true, isEmailVerified: true },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.isEmailVerified) return res.status(400).json({ error: "Email already verified" });

  const emailVerifyToken   = generateSecureToken();
  const emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data:  { emailVerifyToken, emailVerifyExpires },
  });

  sendEmailVerification(user.email, user.fullName, emailVerifyToken).catch(console.error);
  await auditLog("EMAIL_VERIFICATION_SENT", { userId: user.id, email: user.email, ipAddress: getIp(req) });

  return res.json({ message: "Verification email sent. Please check your inbox." });
});

// ─── POST /api/auth/send-otp ──────────────────────────────────────────────────
router.post("/send-otp", otpLimiter, authenticate, async (req: Request, res: Response) => {
  try {
    const { purpose } = sendOtpSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where:  { id: req.user!.userId },
      select: { id: true, email: true, fullName: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const otp = await generateOtp(user.id, purpose);
    sendOtpEmail(user.email, user.fullName, otp, purpose as any).catch(console.error);

    await auditLog("OTP_SENT", { userId: user.id, email: user.email, ipAddress: getIp(req), metadata: { purpose } });
    return res.json({ message: "OTP sent to your registered email address" });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/auth/verify-otp ───────────────────────────────────────────────
router.post("/verify-otp", otpLimiter, authenticate, async (req: Request, res: Response) => {
  try {
    const { code, purpose } = verifyOtpSchema.parse(req.body);
    const result = await verifyOtp(req.user!.userId, purpose, code);

    if (!result.valid) {
      await auditLog("OTP_FAILED", {
        userId:    req.user!.userId,
        email:     req.user!.email,
        ipAddress: getIp(req),
        metadata:  { purpose, reason: result.reason },
      });
      return res.status(400).json({ error: result.reason || "Invalid OTP" });
    }

    await auditLog("OTP_VERIFIED", {
      userId:    req.user!.userId,
      email:     req.user!.email,
      ipAddress: getIp(req),
      metadata:  { purpose },
    });
    return res.json({ message: "OTP verified successfully", verified: true });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
router.post("/forgot-password", passwordResetLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);

    // Always respond with the same message to prevent email enumeration
    const GENERIC_RESPONSE = { message: "If an account exists for that email, a reset link has been sent." };

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json(GENERIC_RESPONSE);

    const token   = generateSecureToken();
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data:  { passwordResetToken: token, passwordResetExpires: expires },
    });

    sendPasswordReset(email, user.fullName, token).catch(console.error);
    await auditLog("PASSWORD_RESET_REQUESTED", { userId: user.id, email, ipAddress: getIp(req) });

    return res.json(GENERIC_RESPONSE);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Invalid email" });
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
router.post("/reset-password", authLimiter, async (req: Request, res: Response) => {
  try {
    const { token, password } = resetPasswordSchema.parse(req.body);

    const strength = checkPasswordStrength(password);
    if (!strength.valid) {
      return res.status(400).json({ error: strength.feedback.join(". "), strength });
    }

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken:   token,
        passwordResetExpires: { gt: new Date() },
      },
    });

    if (!user) return res.status(400).json({ error: "Invalid or expired reset link" });

    // Don't allow reuse of current password
    const isSame = await comparePassword(password, user.password);
    if (isSame) return res.status(400).json({ error: "New password must differ from your current password" });

    // Reset password + invalidate all sessions + clear token
    await revokeAllUserTokens(user.id);
    await prisma.user.update({
      where: { id: user.id },
      data:  {
        password:             await hashPassword(password),
        tokenVersion:         { increment: 1 },
        passwordResetToken:   null,
        passwordResetExpires: null,
      },
    });

    res.clearCookie(ACCESS_COOKIE,  { path: "/" });
    res.clearCookie(REFRESH_COOKIE, { path: "/" });

    sendSecurityAlert(user.email, user.fullName, "Password Reset", "Your ClinicFlow password was successfully reset. If you did not do this, contact support immediately.").catch(console.error);
    await auditLog("PASSWORD_RESET_COMPLETED", { userId: user.id, email: user.email, ipAddress: getIp(req) });

    return res.json({ message: "Password reset successfully. Please sign in with your new password." });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message || "Invalid request" });
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/auth/change-password ──────────────────────────────────────────
router.post("/change-password", authLimiter, authenticate, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const strength = checkPasswordStrength(newPassword);
    if (!strength.valid) {
      return res.status(400).json({ error: strength.feedback.join(". "), strength });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!(await comparePassword(currentPassword, user.password))) {
      await auditLog("LOGIN_FAILED", { userId: user.id, email: user.email, ipAddress: getIp(req), metadata: { context: "change-password" } });
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "New password must differ from current password" });
    }

    // Revoke all other sessions, keep current alive by re-issuing
    await revokeAllUserTokens(user.id);
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data:  { password: await hashPassword(newPassword), tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });

    // Re-issue tokens for current session
    const payload = {
      userId:       user.id,
      email:        user.email,
      role:         user.role,
      fullName:     user.fullName,
      tokenVersion: updatedUser.tokenVersion,
    };
    await issueTokenPair(res, payload, req);

    sendSecurityAlert(user.email, user.fullName, "Password Changed", "Your ClinicFlow password was changed. All other devices have been signed out.").catch(console.error);
    await auditLog("PASSWORD_CHANGED", { userId: user.id, email: user.email, ipAddress: getIp(req) });

    return res.json({ message: "Password changed. All other sessions have been terminated." });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message || "Validation error" });
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/auth/mfa/setup ─────────────────────────────────────────────────
router.post("/mfa/setup", otpLimiter, authenticate, async (req: Request, res: Response) => {
  try {
    const { authenticator } = await import("otplib");
    const user = await prisma.user.findUnique({
      where:  { id: req.user!.userId },
      select: { id: true, email: true, mfaEnabled: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.mfaEnabled) return res.status(400).json({ error: "MFA is already enabled" });

    const secret  = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, "ClinicFlow", secret);

    // Store secret temporarily — only saved permanently after verification
    await prisma.user.update({ where: { id: user.id }, data: { mfaSecret: secret } });

    await auditLog("MFA_ENABLED", { userId: user.id, email: user.email, ipAddress: getIp(req), metadata: { step: "setup-initiated" } });

    return res.json({
      secret,
      otpauth,
      message: "Scan the QR code or enter the secret in your authenticator app, then verify with a code.",
    });
  } catch (e) {
    console.error("[MFA SETUP ERROR]", e);
    return res.status(500).json({ error: "Server error during MFA setup" });
  }
});

// ─── POST /api/auth/mfa/verify ────────────────────────────────────────────────
router.post("/mfa/verify", otpLimiter, authenticate, async (req: Request, res: Response) => {
  try {
    const { totpCode } = mfaVerifySchema.parse(req.body);
    const { authenticator } = await import("otplib");

    const user = await prisma.user.findUnique({
      where:  { id: req.user!.userId },
      select: { id: true, email: true, fullName: true, mfaSecret: true, mfaEnabled: true },
    });
    if (!user || !user.mfaSecret) return res.status(400).json({ error: "MFA setup not initiated" });
    if (user.mfaEnabled) return res.status(400).json({ error: "MFA already enabled" });

    const isValid = authenticator.verify({ token: totpCode, secret: user.mfaSecret });
    if (!isValid) return res.status(400).json({ error: "Invalid TOTP code. Please try again." });

    // Generate backup codes
    const backupCodes     = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString("hex"));
    const hashedBackups   = await Promise.all(backupCodes.map((c) => hashPassword(c)));

    await prisma.user.update({
      where: { id: user.id },
      data:  { mfaEnabled: true, mfaBackupCodes: hashedBackups },
    });

    sendSecurityAlert(user.email, user.fullName, "Two-Factor Authentication Enabled", "MFA has been enabled on your ClinicFlow account.").catch(console.error);
    await auditLog("MFA_ENABLED", { userId: user.id, email: user.email, ipAddress: getIp(req) });

    return res.json({
      message:     "MFA enabled successfully! Save your backup codes in a safe place.",
      backupCodes, // shown once — user must save these
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/auth/mfa/disable ───────────────────────────────────────────────
router.post("/mfa/disable", authLimiter, authenticate, async (req: Request, res: Response) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Password required to disable MFA" });

    const user = await prisma.user.findUnique({
      where:  { id: req.user!.userId },
      select: { id: true, email: true, fullName: true, password: true, mfaEnabled: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.mfaEnabled) return res.status(400).json({ error: "MFA is not enabled" });

    const ok = await comparePassword(password, user.password);
    if (!ok) return res.status(401).json({ error: "Incorrect password" });

    await prisma.user.update({
      where: { id: user.id },
      data:  { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] },
    });

    sendSecurityAlert(user.email, user.fullName, "Two-Factor Authentication Disabled", "MFA has been disabled on your account. If this wasn't you, change your password immediately.").catch(console.error);
    await auditLog("MFA_DISABLED", { userId: user.id, email: user.email, ipAddress: getIp(req) });

    return res.json({ message: "MFA disabled successfully" });
  } catch {
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/auth/sessions ───────────────────────────────────────────────────
router.get("/sessions", authenticate, async (req: Request, res: Response) => {
  const sessions = await prisma.refreshToken.findMany({
    where:   { userId: req.user!.userId, isRevoked: false, expiresAt: { gt: new Date() } },
    select:  { id: true, jti: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ sessions });
});

// ─── DELETE /api/auth/sessions/:jti ──────────────────────────────────────────
router.delete("/sessions/:jti", authenticate, async (req: Request, res: Response) => {
  const { jti } = req.params;
  const session = await prisma.refreshToken.findFirst({
    where: { jti, userId: req.user!.userId },
  });
  if (!session) return res.status(404).json({ error: "Session not found" });

  await revokeRefreshToken(jti);
  return res.json({ message: "Session revoked" });
});

// ─── GET /api/auth/audit-logs (admin only) ────────────────────────────────────
router.get(
  "/audit-logs",
  authenticate,
  requireRole("admin"),
  strictApiLimiter,
  async (req: Request, res: Response) => {
    const page   = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip   = (page - 1) * limit;
    const userId = req.query.userId as string | undefined;
    const event  = req.query.event as string | undefined;

    const where: any = {};
    if (userId) where.userId = userId;
    if (event)  where.event  = event;

    const [logs, total] = await Promise.all([
      prisma.authAuditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take:    limit,
        include: { user: { select: { email: true, fullName: true } } },
      }),
      prisma.authAuditLog.count({ where }),
    ]);

    return res.json({ logs, total, page, limit, pages: Math.ceil(total / limit) });
  }
);

export default router;