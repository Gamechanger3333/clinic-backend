import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";

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

const app = express();
app.set("trust proxy", 1); // NextJS proxy ke liye

// ─── Security & basics ────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,           // required for cookies
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Global rate limit ────────────────────────────────────────────────────────
app.use("/api", apiLimiter);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/appointments", appointmentsRouter);
app.use("/api/patients", patientsRouter);
app.use("/api/doctors", doctorsRouter);
app.use("/api/departments", departmentsRouter);
app.use("/api/billing/invoices", invoicesRouter);
app.use("/api/lab-reports", labReportsRouter);
app.use("/api/medicines", medicinesRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/prescriptions", prescriptionsRouter);
app.use("/api/medical-records", medicalRecordsRouter);
app.use("/api/profile", profileRouter);
app.use("/api/users", usersRouter);
app.use("/api/dashboard", dashboardRouter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const PORT = parseInt(process.env.PORT || "3001", 10);
app.listen(PORT, () => {
  console.log(`✅ ClinicFlow Express API running on http://localhost:${PORT}`);
});

export default app;
