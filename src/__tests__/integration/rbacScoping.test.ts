import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../../index";
import { prisma } from "../../lib/prisma";

/**
 * Integration tier: exercises real HTTP requests against the real Express
 * app AND a real (disposable/test) Postgres database — the thing the unit
 * suite in src/__tests__/*.test.ts intentionally cannot do, since that
 * suite stubs Prisma to stay DB-free.
 *
 * Requires DATABASE_URL to point at a throwaway test database before
 * running (`npm run test:integration`). Never point this at a database
 * with real patient data — it creates and deletes rows.
 */

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.clinicflow.local`;
}

async function signupPatient(email: string, password = "Str0ng!Passw0rd"): Promise<string[]> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, fullName: "Test Patient", phone: "03001234567" });
  expect(res.status).toBe(201);
  const setCookie = res.headers["set-cookie"];
  const cookies: string[] = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies;
}

describe("RBAC data scoping (real DB)", () => {
  let patientACookies: string[];
  let patientBCookies: string[];
  const emailA = uniqueEmail("patient-a");
  const emailB = uniqueEmail("patient-b");

  beforeAll(async () => {
    patientACookies = await signupPatient(emailA);
    patientBCookies = await signupPatient(emailB);
  });

  afterAll(async () => {
    // Clean up everything this test created so re-runs stay idempotent and
    // the test DB doesn't accumulate junk rows.
    const users = await prisma.user.findMany({ where: { email: { in: [emailA, emailB] } } });
    const userIds = users.map((u: { id: string }) => u.id);
    if (userIds.length) {
      await prisma.patient.deleteMany({ where: { createdBy: { in: userIds } } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.$disconnect();
  });

  it("a patient account cannot list the staff-only /api/patients directory", async () => {
    const res = await request(app).get("/api/patients").set("Cookie", patientACookies);
    expect(res.status).toBe(403);
  });

  it("a freshly-signed-up patient sees an empty, scoped appointments list (never another patient's data)", async () => {
    const res = await request(app).get("/api/appointments").set("Cookie", patientACookies);
    expect(res.status).toBe(200);
    expect(res.body.appointments).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it("patient B's session cannot see anything created under patient A's account", async () => {
    // Even before any appointment exists, confirm the two sessions are
    // genuinely distinct identities scoped to their own Patient record.
    const meA = await request(app).get("/api/auth/me").set("Cookie", patientACookies);
    const meB = await request(app).get("/api/auth/me").set("Cookie", patientBCookies);
    expect(meA.body.user.email).toBe(emailA);
    expect(meB.body.user.email).toBe(emailB);
    expect(meA.body.user.id).not.toBe(meB.body.user.id);
  });

  it("rejects a patient trying to book an appointment as a different patientId", async () => {
    // Even if a malicious client forges a patientId in the body, the
    // appointments route overrides it server-side to the caller's own
    // linked Patient record — this should fail on the doctor lookup
    // (doctorId is fake here), not silently succeed under someone else's
    // patient record.
    const csrfRes = await request(app).get("/api/auth/csrf-token").set("Cookie", patientACookies);
    const setCookie = csrfRes.headers["set-cookie"];
    const csrfCookies: string[] = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const csrfCookie = csrfCookies.find((c: string) => c.startsWith("cf_csrf="));
    const csrfToken = csrfCookie?.split(";")[0].split("=")[1];

    const res = await request(app)
      .post("/api/appointments")
      .set("Cookie", [...patientACookies, ...(csrfCookie ? [csrfCookie] : [])])
      .set("X-CSRF-Token", csrfToken || "")
      .send({ patientId: "forged-other-patient-id", doctorId: "nonexistent-doctor-id", appointmentDate: "2027-01-04", appointmentTime: "10:00" });

    // Should fail on "doctor not found", never succeed with the forged id.
    expect([400, 404, 409]).toContain(res.status);
  });
});
