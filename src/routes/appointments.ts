import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// Only clinic staff manage appointments. Patient self-service (viewing only
// their own appointments) requires a Patient->User link that does not yet
// exist in the schema — see review notes. Until then, patients are excluded
// here rather than given access to every patient's appointment data.
const STAFF_ROLES = ["admin", "doctor", "receptionist"];

// GET /api/appointments
router.get("/", requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  // Doctors only see their own appointments; admin/receptionist see all.
  const where = req.user!.role === "doctor" ? { doctorId: req.user!.userId } : {};

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
router.post("/", requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  try {
    const body = req.body;
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
router.patch("/:id", requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  // Doctors may only update appointments assigned to them.
  if (req.user!.role === "doctor") {
    const existing = await prisma.appointment.findUnique({ where: { id: req.params.id }, select: { doctorId: true } });
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (existing.doctorId !== req.user!.userId) {
      return res.status(403).json({ error: "You can only update your own appointments" });
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
