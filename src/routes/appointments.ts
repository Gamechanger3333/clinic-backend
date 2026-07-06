import { Router, Request, Response } from "express";
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

// GET /api/appointments
router.get("/", requireRole(...ALL_ROLES), async (req: Request, res: Response) => {
  // Doctors → only their own. Patients → only their own. Admin/receptionist → all.
  let where: Record<string, any> = {};
  if (req.user!.role === "doctor") {
    where = { doctorId: req.user!.userId };
  } else if (req.user!.role === "patient") {
    const patientId = await ownPatientId(req.user!.userId);
    where = { patientId: patientId || "__none__" };
  }

  const appointments = await prisma.appointment.findMany({
    where,
    include: {
      patient: { select: { id: true, fullName: true, email: true } },
      doctor: { select: { id: true, fullName: true } },
    },
    orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "asc" }],
  });
  return res.json({ appointments });
});

// POST /api/appointments
router.post("/", requireRole(...ALL_ROLES), async (req: Request, res: Response) => {
  try {
    const body = req.body;

    // A patient can only ever book an appointment for THEMSELVES — the
    // patientId from the request body is ignored and replaced server-side.
    if (req.user!.role === "patient") {
      const patientId = await ownPatientId(req.user!.userId);
      if (!patientId) return res.status(400).json({ error: "No patient profile found for this account" });
      body.patientId = patientId;
    }

    const apt = await prisma.appointment.create({
      data: { ...body, durationMinutes: parseInt(body.durationMinutes || "30"), createdBy: req.user!.userId },
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
    const allowedStatuses = new Set(["cancelled"]);
    const requestedKeys = Object.keys(req.body);
    if (requestedKeys.some((k) => k !== "status") || !allowedStatuses.has(req.body.status)) {
      return res.status(403).json({ error: "Patients may only cancel their own appointment" });
    }
  }

  const apt = await prisma.appointment.update({
    where: { id: req.params.id },
    data: req.body,
    include: { patient: { select: { id: true, fullName: true } } },
  });
  return res.json({ appointment: apt });
});

export default router;
