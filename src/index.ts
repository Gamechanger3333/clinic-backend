/**
 * src/index.ts — Enterprise Express Server
 *
 * Security hardening:
 *  - Helmet with strict CSP
 *  - CORS whitelist-only
 *  - HSTS, X-Frame-Options, X-Content-Type-Options
 *  - Global rate limiting
 *  - 1MB body limit (DoS mitigation)
 *  - Request ID tracing
 *  - Structured error handling (no stack leaks in prod)
 *  - Startup token pruning
 */

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import crypto from "crypto";

import authRouter from "./routes/auth";
import appointmentsRouter from "./routes/appointments";
import patientsRouter from "./routes/patients";
import doctorsRouter from "./routes/doctors";
import departmentsRouter from "./routes/departments";
import invoicesRouter from "./routes/invoices";
import labReportsRouter from "./routes/labReports";
import medicinesRouter from "./routes/medicines";
import notificationsRouter from "./routes/notifications";
import prescriptionsRouter from "./routes/prescriptions";
import medicalRecordsRouter from "./routes/medicalRecords";
import { profileRouter, usersRouter, dashboardRouter } from "./routes/misc";
import { apiLimiter } from "./middleware/rateLimiter";
import { pruneExpiredTokens } from "./lib/auth";

const app = express();

// ─── Trust proxy (Next.js/nginx fronts this server) ──────────────────────────
app.set("trust proxy", 1);

// ─── Request ID (aids log tracing) ───────────────────────────────────────────
app.use((req, _res, next) => {
  (req as any).requestId = crypto.randomUUID();
  next();
});

// ─── Helmet — Security Headers ────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'"],
        styleSrc:       ["'self'", "'unsafe-inline'"],
        imgSrc:         ["'self'", "data:", "https:"],
        connectSrc:     ["'self'"],
        fontSrc:        ["'self'"],
        objectSrc:      ["'none'"],
        mediaSrc:       ["'none'"],
        frameSrc:       ["'none'"],
        upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
      } as any,
    },
    hsts: {
      maxAge:            31536000,   // 1 year
      includeSubDomains: true,
      preload:           true,
    },
    referrerPolicy:        { policy: "strict-origin-when-cross-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
  })
);

// ─── CORS — Whitelist only ────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin(origin, callback) {
      // Allow no-origin (same-origin, Postman in dev)
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials:    true,
    methods:        ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
    exposedHeaders: ["X-Request-Id"],
  })
);

// ─── Body parsing — strict limits ─────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// ─── Logging ──────────────────────────────────────────────────────────────────
// In production, do NOT log cookie values or Authorization headers
const morganFormat = process.env.NODE_ENV === "production"
  ? ":remote-addr :method :url :status :res[content-length] - :response-time ms"
  : "dev";
app.use(morgan(morganFormat));

// ─── Global API Rate Limit ────────────────────────────────────────────────────
app.use("/api", apiLimiter);

// ─── X-Request-Id response header ────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Request-Id", (req as any).requestId);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth",            authRouter);
app.use("/api/appointments",    appointmentsRouter);
app.use("/api/patients",        patientsRouter);
app.use("/api/doctors",         doctorsRouter);
app.use("/api/departments",     departmentsRouter);
app.use("/api/billing/invoices",invoicesRouter);
app.use("/api/lab-reports",     labReportsRouter);
app.use("/api/medicines",       medicinesRouter);
app.use("/api/notifications",   notificationsRouter);
app.use("/api/prescriptions",   prescriptionsRouter);
app.use("/api/medical-records", medicalRecordsRouter);
app.use("/api/profile",         profileRouter);
app.use("/api/users",           usersRouter);
app.use("/api/dashboard",       dashboardRouter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Never leak stack traces in production
  const isDev    = process.env.NODE_ENV !== "production";
  const statusCode = err.status || err.statusCode || 500;
  console.error(`[ERROR ${statusCode}]`, err.message, isDev ? err.stack : "");

  return res.status(statusCode).json({
    error: statusCode < 500 ? err.message : "Internal server error",
    ...(isDev && { stack: err.stack }),
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3001", 10);
app.listen(PORT, async () => {
  console.log(`✅ ClinicFlow API running on http://localhost:${PORT}`);

  // Prune stale refresh tokens on startup
  pruneExpiredTokens()
    .then(() => console.log("🧹 Pruned expired refresh tokens"))
    .catch(console.error);

  // Schedule token pruning every 6 hours
  setInterval(() => pruneExpiredTokens().catch(console.error), 6 * 60 * 60 * 1000);
});

export default app;