import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// Clinic staff manage all appointments. Patients can view/book only their
// OWN appointments — scoped via Patient.createdBy -> User.id (the link that
// signup already creates), never another patient's data.
const STAFF_ROLES = ["admin", "doctor", "receptionist"];
const ALL_ROLES = [...STAFF_ROLES, "patient"];

async function ownPatientId(userId: string): Promise<string | null> {
  const patient = await prisma.patient.findFirst({ where: { createdBy: userId } });
  return patient?.id || null;
}

// ─── Validation ────────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const createSchema = z.object({
  patientId: z.string().min(1).optional(), // server-overridden for patients
  doctorId: z.string().min(1, "Doctor is required"),
  appointmentDate: z.string().regex(DATE_RE, "Date must be YYYY-MM-DD"),
  appointmentTime: z.string().regex(TIME_RE, "Time must be HH:MM"),
  durationMinutes: z.coerce.number().int().min(5).max(240).default(30),
  reason: z.string().max(1000).optional(),
  notes: z.string().max(2000).optional(),
});

const patchSchema = z
  .object({
    status: z.enum(["pending", "approved", "rejected", "completed", "cancelled"]).optional(),
    appointmentDate: z.string().regex(DATE_RE).optional(),
    appointmentTime: z.string().regex(TIME_RE).optional(),
    durationMinutes: z.coerce.number().int().min(5).max(240).optional(),
    reason: z.string().max(1000).optional(),
    notes: z.string().max(2000).optional(),
    followUpDate: z.string().regex(DATE_RE).optional(),
  })
  .strict(); // reject unknown fields outright, rather than silently persisting them

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["pending", "approved", "rejected", "completed", "cancelled"]).optional(),
  date: z.string().regex(DATE_RE).optional(),
});

// GET /api/appointments — paginated, filterable, role-scoped
router.get("/", requireRole(...ALL_ROLES), async (req: Request, res: Response) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid query params" });
  }
  const { page, limit, status, date } = parsed.data;

  // Doctors → only their own. Patients → only their own. Admin/receptionist → all.
  let where: Record<string, any> = {};
  if (req.user!.role === "doctor") {
    where = { doctorId: req.user!.userId };
  } else if (req.user!.role === "patient") {
    const patientId = await ownPatientId(req.user!.userId);
    where = { patientId: patientId || "__none__" };
  }
  if (status) where.status = status;
  if (date) where.appointmentDate = date;

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      include: {
        patient: { select: { id: true, fullName: true, email: true } },
        doctor: { select: { id: true, fullName: true } },
      },
      orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.appointment.count({ where }),
  ]);

  return res.json({
    appointments,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

// POST /api/appointments
router.post("/", requireRole(...ALL_ROLES), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  }
  const body = parsed.data;

  // A patient can only ever book an appointment for THEMSELVES — the
  // patientId from the request body is ignored and replaced server-side.
  if (req.user!.role === "patient") {
    const patientId = await ownPatientId(req.user!.userId);
    if (!patientId) return res.status(400).json({ error: "No patient profile found for this account" });
    body.patientId = patientId;
  } else if (!body.patientId) {
    return res.status(400).json({ error: "Patient is required" });
  }

  // Enforce the doctor's configured working days/hours (Doctor.workingDays,
  // startTime, endTime) — previously defined in the schema but never
  // actually read anywhere, so bookings outside a doctor's hours went
  // through silently.
  const doctor = await prisma.doctor.findUnique({ where: { id: body.doctorId } });
  if (!doctor) return res.status(404).json({ error: "Doctor not found" });
  if (!doctor.isAvailable) {
    return res.status(409).json({ error: "This doctor is not currently accepting appointments" });
  }

  const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  // appointmentDate is validated as YYYY-MM-DD; parse as UTC-noon to avoid
  // local-timezone day-shift when deriving the weekday name.
  const weekday = WEEKDAY_NAMES[new Date(`${body.appointmentDate}T12:00:00Z`).getUTCDay()];
  if (!doctor.workingDays.includes(weekday)) {
    return res.status(409).json({ error: `Dr. is not available on ${weekday}s. Working days: ${doctor.workingDays.join(", ")}` });
  }
  if (body.appointmentTime < doctor.startTime || body.appointmentTime >= doctor.endTime) {
    return res.status(409).json({ error: `Please pick a time between ${doctor.startTime} and ${doctor.endTime} for this doctor` });
  }

  // Double-booking guard: the same doctor can't hold two active
  // (pending/approved) appointments in the same date+time slot.
  const conflict = await prisma.appointment.findFirst({
    where: {
      doctorId: body.doctorId,
      appointmentDate: body.appointmentDate,
      appointmentTime: body.appointmentTime,
      status: { in: ["pending", "approved"] },
    },
  });
  if (conflict) {
    return res.status(409).json({ error: "This doctor already has an appointment at that date and time. Please choose another slot." });
  }

  try {
    const apt = await prisma.appointment.create({
      data: { ...body, createdBy: req.user!.userId } as any,
      include: {
        patient: { select: { id: true, fullName: true } },
        doctor: { select: { id: true, fullName: true } },
      },
    });
    return res.status(201).json({ appointment: apt });
  } catch {
    return res.status(500).json({ error: "Server error" });
  }
});

// PATCH /api/appointments/:id
router.patch("/:id", requireRole(...ALL_ROLES), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  }
  const patch = parsed.data;

  const existing = await prisma.appointment.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  // Doctors may only update appointments assigned to them.
  if (req.user!.role === "doctor" && existing.doctorId !== req.user!.userId) {
    return res.status(403).json({ error: "You can only update your own appointments" });
  }

  // Patients may only cancel their OWN appointment — nothing else (no
  // approving/rejecting/completing, no editing date/doctor/etc).
  if (req.user!.role === "patient") {
    const patientId = await ownPatientId(req.user!.userId);
    if (!patientId || existing.patientId !== patientId) {
      return res.status(403).json({ error: "You can only update your own appointments" });
    }
    const keys = Object.keys(patch);
    if (keys.length !== 1 || patch.status !== "cancelled") {
      return res.status(403).json({ error: "Patients may only cancel their own appointment" });
    }
  }

  // If the slot is being moved, re-validate working hours and re-check for
  // a conflict at the new slot.
  if (patch.appointmentDate || patch.appointmentTime) {
    const newDate = patch.appointmentDate || existing.appointmentDate;
    const newTime = patch.appointmentTime || existing.appointmentTime;

    const doctor = await prisma.doctor.findUnique({ where: { id: existing.doctorId } });
    if (doctor) {
      const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const weekday = WEEKDAY_NAMES[new Date(`${newDate}T12:00:00Z`).getUTCDay()];
      if (!doctor.workingDays.includes(weekday)) {
        return res.status(409).json({ error: `Dr. is not available on ${weekday}s. Working days: ${doctor.workingDays.join(", ")}` });
      }
      if (newTime < doctor.startTime || newTime >= doctor.endTime) {
        return res.status(409).json({ error: `Please pick a time between ${doctor.startTime} and ${doctor.endTime} for this doctor` });
      }
    }

    const conflict = await prisma.appointment.findFirst({
      where: {
        id: { not: existing.id },
        doctorId: existing.doctorId,
        appointmentDate: newDate,
        appointmentTime: newTime,
        status: { in: ["pending", "approved"] },
      },
    });
    if (conflict) {
      return res.status(409).json({ error: "This doctor already has an appointment at that date and time." });
    }
  }

  const apt = await prisma.appointment.update({
    where: { id: req.params.id },
    data: patch,
    include: { patient: { select: { id: true, fullName: true } } },
  });
  return res.json({ appointment: apt });
});

export default router;
