import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../index";

describe("GET /health", () => {
  it("returns 200 with an ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.time).toBeTruthy();
  });
});

describe("Security headers (Helmet)", () => {
  it("sets a Content-Security-Policy header", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["content-security-policy"]).toBeTruthy();
  });

  it("sets Strict-Transport-Security (HSTS)", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
  });

  it("does not advertise the framework via X-Powered-By", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("attaches a unique X-Request-Id per response", async () => {
    const [a, b] = await Promise.all([request(app).get("/health"), request(app).get("/health")]);
    expect(a.headers["x-request-id"]).toBeTruthy();
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });
});

describe("404 handler", () => {
  it("returns a JSON error for unknown routes", async () => {
    const res = await request(app).get("/api/this-route-does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Route not found");
  });
});

describe("Body size limit", () => {
  it("rejects an oversized JSON body (>1mb)", async () => {
    const bigPayload = { blob: "x".repeat(2 * 1024 * 1024) };
    const res = await request(app).post("/api/auth/signup").send(bigPayload);
    expect(res.status).toBe(413);
  });
});
