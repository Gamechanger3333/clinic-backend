/**
 * src/test/patients.test.ts — one full CRUD resource, covering:
 *  - RBAC enforcement (a "patient"-role caller cannot list all patients)
 *  - Input validation (the mass-assignment fix — invalid/extra fields
 *    are rejected or stripped before reaching Prisma)
 *  - Pagination response shape
 *  - Delete requires admin, not just any staff role
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { prismaMock, resetPrismaMock } from "./mockPrisma";
import { authCookieFor } from "./authHelper";

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../middleware/rateLimiter", () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough,
    apiLimiter: passthrough, strictApiLimiter: passthrough, signupLimiter: passthrough, aiLimiter: passthrough,
  };
});
// CSRF protection is reviewed/covered separately (see the audit) — these
// tests are about route validation/RBAC logic, so bypass it here rather
// than manufacturing a CSRF token dance for every mutating request. auth/
// requireRole stay REAL — that's exactly what's under test.
vi.mock("../middleware/auth", async (importActual) => {
  const actual = await importActual<typeof import("../middleware/auth")>();
  return { ...actual, csrfProtection: (_req: any, _res: any, next: any) => next() };
});

const { default: app } = await import("../index");

const admin = { userId: "admin1", email: "admin@clinicflow.com", role: "admin", fullName: "Admin User" };
const receptionist = { userId: "rec1", email: "rec@clinicflow.com", role: "receptionist", fullName: "Reception" };
const patientUser = { userId: "pat1", email: "patient@clinicflow.com", role: "patient", fullName: "Patient User" };

beforeEach(() => {
  resetPrismaMock();
  // Every protected request's auth check reads tokenVersion off the user
  // row — keep this stable across all four seeded test users.
  prismaMock.user.findUnique.mockResolvedValue({ tokenVersion: 0 } as any);
});

describe("GET /api/patients — RBAC", () => {
  it("rejects a patient-role caller (403) — patients cannot list all patients", async () => {
    const cookie = await authCookieFor(patientUser);
    const res = await request(app).get("/api/patients").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated caller (401)", async () => {
    const res = await request(app).get("/api/patients");
    expect(res.status).toBe(401);
  });

  it("allows a receptionist and returns a paginated envelope", async () => {
    const cookie = await authCookieFor(receptionist);
    prismaMock.patient.findMany.mockResolvedValue([
      { id: "p1", fullName: "Jane Doe", createdAt: new Date() } as any,
    ]);
    prismaMock.patient.count.mockResolvedValue(1);

    const res = await request(app).get("/api/patients").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20, total: 1 });
  });

  it("caps ?limit= at 100 even if a larger value is requested", async () => {
    const cookie = await authCookieFor(receptionist);
    prismaMock.patient.findMany.mockResolvedValue([]);
    prismaMock.patient.count.mockResolvedValue(0);

    const res = await request(app).get("/api/patients?limit=99999").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBeLessThanOrEqual(100);
  });
});

describe("POST /api/patients — validation (mass-assignment fix)", () => {
  it("rejects a request with no fullName (400), never reaching Prisma", async () => {
    const cookie = await authCookieFor(receptionist);
    const res = await request(app)
      .post("/api/patients")
      .set("Cookie", cookie)
      .send({ email: "noname@example.com" });

    expect(res.status).toBe(400);
    expect(prismaMock.patient.create).not.toHaveBeenCalled();
  });

  it("SECURITY: strips fields not in the schema instead of passing them through to Prisma", async () => {
    const cookie = await authCookieFor(receptionist);
    prismaMock.patient.create.mockResolvedValue({ id: "p1", fullName: "Real Name" } as any);

    await request(app)
      .post("/api/patients")
      .set("Cookie", cookie)
      .send({
        fullName: "Real Name",
        id: "attacker-controlled-id",       // not in the schema
        createdBy: "attacker-controlled-id", // not in the schema — set server-side only
      });

    expect(prismaMock.patient.create).toHaveBeenCalled();
    const createArgs = prismaMock.patient.create.mock.calls[0][0] as any;
    expect(createArgs.data.id).toBeUndefined();
    expect(createArgs.data.createdBy).toBe(receptionist.userId); // server-set, not client-set
  });

  it("rejects a patient-role caller creating a record (403)", async () => {
    const cookie = await authCookieFor(patientUser);
    const res = await request(app)
      .post("/api/patients")
      .set("Cookie", cookie)
      .send({ fullName: "Should Not Work" });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/patients/:id — RBAC", () => {
  it("rejects a receptionist (admin-only action)", async () => {
    const cookie = await authCookieFor(receptionist);
    const res = await request(app).delete("/api/patients/p1").set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(prismaMock.patient.delete).not.toHaveBeenCalled();
  });

  it("allows an admin", async () => {
    const cookie = await authCookieFor(admin);
    prismaMock.patient.delete.mockResolvedValue({ id: "p1" } as any);

    const res = await request(app).delete("/api/patients/p1").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 404 (not 500) when deleting a record that no longer exists", async () => {
    const cookie = await authCookieFor(admin);
    prismaMock.patient.delete.mockRejectedValue(Object.assign(new Error("Not found"), { code: "P2025" }));

    const res = await request(app).delete("/api/patients/does-not-exist").set("Cookie", cookie);

    expect(res.status).toBe(404);
  });
});
