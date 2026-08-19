import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

const medicationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  dosage: z.string().max(100).optional(),
  frequency: z.string().max(100).optional(),
  duration: z.string().max(100).optional(),
});

const createSchema = z.object({
  appointmentId: z.string().min(1),
  patientId: z.string().min(1),
  medications: z.array(medicationSchema).min(1, "At least one medication is required"),
  diagnosis: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
  followUpDays: z.coerce.number().int().min(0).max(365).optional(),
});

// Prescriptions are PHI — staff see all; patients may view only their own.
router.get("/", requireRole("admin", "doctor", "receptionist", "patient"), async (req: Request, res: Response) => {
  let where: Record<string, any> = {};
  if (req.user!.role === "patient") {
    const patient = await prisma.patient.findFirst({ where: { createdBy: req.user!.userId } });
    where = { patientId: patient?.id || "__none__" };
  }
  const prescriptions = await prisma.prescription.findMany({
    where,
    include: {
      patient: { select: { id: true, fullName: true, email: true } },
      appointment: { select: { appointmentDate: true } },
      doctor: { select: { id: true, fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ prescriptions });
});

router.post("/", requireRole("doctor"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  try {
    const rx = await prisma.prescription.create({
      data: { ...parsed.data, doctorId: req.user!.userId },
      include: {
        patient: { select: { id: true, fullName: true, email: true } },
        appointment: { select: { appointmentDate: true } },
      },
    });
    return res.status(201).json({ prescription: rx });
  } catch {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
