import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  blacklistToken,
  hashPassword,
  comparePassword,
  recordFailedLogin,
  isAccountLocked,
  clearFailedAttempts,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
} from "../lib/auth";
import { authenticate } from "../middleware/auth";
import { authLimiter } from "../middleware/rateLimiter";

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────
const signupSchema = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(8, "Min 8 characters")
    .regex(/[A-Z]/, "Must contain uppercase")
    .regex(/[0-9]/, "Must contain number")
    .regex(/[^A-Za-z0-9]/, "Must contain special character"),
  fullName: z.string().min(2),
  role: z.enum(["admin", "doctor", "receptionist", "patient"]).default("receptionist"),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, "Min 8 characters")
    .regex(/[A-Z]/, "Must contain uppercase")
    .regex(/[0-9]/, "Must contain number")
    .regex(/[^A-Za-z0-9]/, "Must contain special character"),
});

// ─── Helper: set both cookies ─────────────────────────────────────────────
async function issueTokens(res: Response, payload: { userId: string; email: string; role: string; fullName: string; tokenVersion: number }) {
  const accessToken = await signAccessToken(payload);
  const refreshToken = await signRefreshToken(payload);
  res.cookie(ACCESS_COOKIE, accessToken, ACCESS_COOKIE_OPTIONS);
  res.cookie(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTIONS);
  return { accessToken, refreshToken };
}

// ─── POST /api/auth/signup ────────────────────────────────────────────────
router.post("/signup", authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password, fullName, role, phone } = signupSchema.parse(req.body);

    if (await prisma.user.findUnique({ where: { email } })) {
      return res.status(409).json({ error: "Email already in use" });
    }

    const user = await prisma.user.create({
      data: {
        email,
        password: await hashPassword(password),
        fullName,
        role: role as any,
        phone,
        tokenVersion: 0,
      },
    });

    // Auto-create patient record if role is patient
    if (role === "patient") {
      await prisma.patient.create({
        data: { fullName: user.fullName, email: user.email, phone: user.phone, createdBy: user.id },
      });
    }

    const payload = { userId: user.id, email: user.email, role: user.role, fullName: user.fullName, tokenVersion: 0 };
    await issueTokens(res, payload);

    return res.status(201).json({
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message || "Validation error" });
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────
router.post("/login", authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    // Account lockout check
    const lockStatus = isAccountLocked(email);
    if (lockStatus.locked) {
      const mins = Math.ceil((lockStatus.remainingMs || 0) / 60000);
      return res.status(429).json({ error: `Account locked. Try again in ${mins} minute(s).` });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await comparePassword(password, user.password))) {
      const result = recordFailedLogin(email);
      if (result.locked) {
        return res.status(429).json({ error: "Too many failed attempts. Account locked for 15 minutes." });
      }
      return res.status(401).json({ error: "Invalid email or password" });
    }

    clearFailedAttempts(email);

    const payload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      tokenVersion: user.tokenVersion ?? 0,
    };
    await issueTokens(res, payload);

    return res.json({
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role, phone: user.phone },
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Invalid input" });
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────
router.post("/logout", async (req: Request, res: Response) => {
  const refreshToken = req.cookies[REFRESH_COOKIE];
  if (refreshToken) {
    const payload = await verifyRefreshToken(refreshToken);
    if (payload?.jti) blacklistToken(payload.jti);
  }

  res.clearCookie(ACCESS_COOKIE, { path: "/" });
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
  return res.json({ message: "Logged out successfully" });
});

// ─── POST /api/auth/logout-all (invalidate all sessions) ─────────────────
router.post("/logout-all", authenticate, async (req: Request, res: Response) => {
  // Increment tokenVersion → all existing tokens become invalid
  await prisma.user.update({
    where: { id: req.user!.userId },
    data: { tokenVersion: { increment: 1 } },
  });

  res.clearCookie(ACCESS_COOKIE, { path: "/" });
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
  return res.json({ message: "All sessions terminated" });
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────
// Explicit refresh (useful for non-cookie clients like mobile)
router.post("/refresh", async (req: Request, res: Response) => {
  const refreshToken = req.cookies[REFRESH_COOKIE];
  if (!refreshToken) return res.status(401).json({ error: "No refresh token" });

  const payload = await verifyRefreshToken(refreshToken);
  if (!payload) return res.status(401).json({ error: "Invalid or expired refresh token" });

  // Validate token version
  const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { tokenVersion: true, role: true, fullName: true, email: true } });
  if (!user || user.tokenVersion !== (payload.tokenVersion ?? 0)) {
    return res.status(401).json({ error: "Session invalidated. Please log in again." });
  }

  // Rotate: blacklist old, issue new pair
  blacklistToken(payload.jti);
  const { jti: _jti, ...cleanPayload } = payload as any;
  await issueTokens(res, { ...cleanPayload, tokenVersion: user.tokenVersion });

  return res.json({ message: "Tokens refreshed" });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────
router.get("/me", authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { id: true, email: true, fullName: true, role: true, phone: true, avatarUrl: true, createdAt: true },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json({ user });
});

// ─── POST /api/auth/change-password ──────────────────────────────────────
router.post("/change-password", authenticate, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!(await comparePassword(currentPassword, user.password))) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "New password must differ from current password" });
    }

    // Update password + increment tokenVersion (log out all other sessions)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await hashPassword(newPassword),
        tokenVersion: { increment: 1 },
      },
    });

    // Re-issue tokens with new tokenVersion so current session stays alive
    const updatedUser = await prisma.user.findUnique({ where: { id: user.id }, select: { tokenVersion: true } });
    const payload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      tokenVersion: updatedUser!.tokenVersion ?? 0,
    };
    await issueTokens(res, payload);

    return res.json({ message: "Password changed successfully. All other sessions have been terminated." });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message || "Validation error" });
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
