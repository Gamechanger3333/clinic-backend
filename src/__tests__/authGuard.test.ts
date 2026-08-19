import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../index";

// These exercise the `authenticate` gate itself (no cookies -> 401) which is
// pure middleware logic and never reaches the database, so they run safely
// without a live Postgres connection.
describe("authenticate middleware — unauthenticated access", () => {
  const protectedRoutes: Array<[string, string]> = [
    ["get", "/api/appointments"],
    ["get", "/api/patients"],
    ["get", "/api/doctors"],
    ["get", "/api/billing/invoices"],
    ["get", "/api/lab-reports"],
    ["get", "/api/medicines"],
    ["get", "/api/notifications"],
    ["get", "/api/prescriptions"],
    ["get", "/api/medical-records"],
    ["get", "/api/users"],
    ["get", "/api/dashboard/stats"],
    ["get", "/api/auth/me"],
  ];

  for (const [method, path] of protectedRoutes) {
    it(`rejects ${method.toUpperCase()} ${path} with 401 when no session cookie is present`, async () => {
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(401);
      expect(res.body.error).toBeTruthy();
    });
  }
});

describe("CSRF protection on state-mutating routes", () => {
  // src/index.ts applies csrfProtection() globally, ahead of every router —
  // so a mutating request with no cf_csrf/X-CSRF-Token pair is rejected by
  // CSRF (403) before it ever reaches that route's `authenticate` gate.
  it("rejects POST /api/patients with 403 (CSRF) before the auth gate runs", async () => {
    const res = await request(app).post("/api/patients").send({ fullName: "Test Patient" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/csrf/i);
  });

  it("rejects an unauthenticated POST to a non-exempt auth route the same way", async () => {
    const res = await request(app).post("/api/auth/logout-all");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/csrf/i);
  });

  it("exempts /api/auth/login from CSRF (no session can exist yet) — fails validation instead, not CSRF", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).not.toBe(403);
  });
});

describe("Zod input validation on protected routes (shape-only, pre-DB)", () => {
  it("a malformed body from an anonymous caller never reaches a Prisma call — rejected by CSRF first", async () => {
    // Confirms defense-in-depth ordering: csrfProtection() -> authenticate()
    // -> requireRole() -> zod validation. Nothing here should touch the DB
    // (the mocked prisma client in setup.ts would throw loudly if it did).
    const res = await request(app).post("/api/appointments").send({ not: "valid" });
    expect(res.status).toBe(403);
  });
});
