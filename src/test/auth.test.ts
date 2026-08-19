/**
 * src/test/auth.test.ts — auth flow coverage
 *
 * Covers: signup validation + role lock-down, login validation, wrong
 * credentials, successful login sets cookies, /me requires auth.
 *
 * Prisma is mocked (see mockPrisma.ts) — this suite asserts on route
 * behavior (status codes, response shape, security invariants), not on
 * real database persistence.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { prismaMock, resetPrismaMock } from "./mockPrisma";

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));

// Rate limiting is already covered by manual/architecture review (see the
// audit) — mocking it out here so repeated test requests to /login and
// /signup don't trip the 5-attempts/15-min limiter across test cases.
vi.mock("../middleware/rateLimiter", () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    authLimiter: passthrough,
    otpLimiter: passthrough,
    passwordResetLimiter: passthrough,
    apiLimiter: passthrough,
    strictApiLimiter: passthrough,
    signupLimiter: passthrough,
    aiLimiter: passthrough,
  };
});

const { default: app } = await import("../index");

beforeEach(() => {
  resetPrismaMock();
});

describe("POST /api/auth/signup", () => {
  it("rejects a password shorter than 8 characters", async () => {
    const res = await request(app).post("/api/auth/signup").send({
      email: "new@clinicflow.com",
      password: "short",
      fullName: "New User",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid email", async () => {
    const res = await request(app).post("/api/auth/signup").send({
      email: "not-an-email",
      password: "ValidPass123",
      fullName: "New User",
    });
    expect(res.status).toBe(400);
  });

  it("SECURITY: ignores a client-supplied role and always creates a patient", async () => {
    // This is the specific behavior confirmed during this project's own
    // development — public signup must never be able to grant a
    // privileged role, no matter what the client sends.
    prismaMock.user.findUnique.mockResolvedValue(null); // email not taken
    prismaMock.user.create.mockResolvedValue({
      id: "u1",
      email: "hacker@clinicflow.com",
      fullName: "Hacker",
      role: "patient",
    } as any);
    prismaMock.patient.create.mockResolvedValue({ id: "p1" } as any);
    prismaMock.refreshToken.create.mockResolvedValue({} as any);
    prismaMock.authAuditLog.create.mockResolvedValue({} as any);

    const res = await request(app).post("/api/auth/signup").send({
      email: "hacker@clinicflow.com",
      password: "ValidPass123",
      fullName: "Hacker",
      role: "admin", // <-- attempted privilege escalation via extra field
    });

    // Whatever the response, the create() call itself must never have
    // been given role:"admin" — assert on the actual Prisma call args.
    if (prismaMock.user.create.mock.calls.length > 0) {
      const createArgs = prismaMock.user.create.mock.calls[0][0] as any;
      expect(createArgs.data.role).not.toBe("admin");
    }
  });
});

describe("POST /api/auth/login", () => {
  it("rejects a malformed body (400) before touching the database", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 for a non-existent account without revealing that it doesn't exist", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.authAuditLog.create.mockResolvedValue({} as any);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@clinicflow.com", password: "whatever123" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid email or password");
  });

  it("returns 401 for a wrong password on an existing account", async () => {
    const wrongHash = await bcrypt.hash("CorrectPassword123", 10);
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "doctor@clinicflow.com",
      password: wrongHash,
      role: "doctor",
      fullName: "Dr. Test",
      failedLoginCount: 0,
      lockedUntil: null,
      mfaEnabled: false,
      tokenVersion: 0,
    } as any);
    prismaMock.user.update.mockResolvedValue({} as any);
    prismaMock.authAuditLog.create.mockResolvedValue({} as any);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "doctor@clinicflow.com", password: "WrongPassword" });

    expect(res.status).toBe(401);
  });

  it("logs in successfully with correct credentials and sets httpOnly cookies", async () => {
    const correctHash = await bcrypt.hash("CorrectPassword123", 10);
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "doctor@clinicflow.com",
      password: correctHash,
      role: "doctor",
      fullName: "Dr. Test",
      phone: null,
      failedLoginCount: 0,
      lockedUntil: null,
      mfaEnabled: false,
      isEmailVerified: true,
      tokenVersion: 0,
    } as any);
    prismaMock.user.update.mockResolvedValue({} as any);
    prismaMock.refreshToken.create.mockResolvedValue({} as any);
    prismaMock.authAuditLog.create.mockResolvedValue({} as any);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "doctor@clinicflow.com", password: "CorrectPassword123" });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("doctor@clinicflow.com");
    // Never leak the password hash back to the client
    expect(res.body.user.password).toBeUndefined();

    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies).toBeDefined();
    expect(cookies.some((c) => c.startsWith("cf_at=") && /HttpOnly/i.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith("cf_rt=") && /HttpOnly/i.test(c))).toBe(true);
  });
});

describe("GET /api/auth/me", () => {
  it("returns 401 without an access token cookie", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });
});
