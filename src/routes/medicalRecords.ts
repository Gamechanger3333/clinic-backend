import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  patientId: z.string().min(1),
  doctorId: z.string().min(1),
  appointmentId: z.string().min(1).optional(),
  visitDate: z.string().min(1),
  chiefComplaint: z.string().trim().min(1).max(1000),
  diagnosis: z.string().max(2000).optional(),
  treatment: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
  followUpDate: z.string().optional(),
});

// Diagnosis / treatment notes are the most sensitive PHI in the system.
// Reads: any clinical/admin staff, plus the patient themself (scoped via
// Patient.createdBy -> User.id, same linkage used across appointments,
// prescriptions, invoices, and lab reports).
// Writes: doctors and admin only — receptionists should not be able to
// author clinical notes.
router.get("/", requireRole("admin", "doctor", "receptionist", "patient"), async (req: Request, res: Response) => {
  let patientId = (req.query.patientId as string) || undefined;
  if (req.user!.role === "patient") {
    const patient = await prisma.patient.findFirst({ where: { createdBy: req.user!.userId } });
    patientId = patient?.id || "__none__";
  }
  const records = await prisma.medicalRecord.findMany({
    where: { ...(patientId ? { patientId } : {}) },
    include: {
      patient: { select: { id: true, fullName: true } },
      doctor: { include: { user: { select: { id: true, fullName: true } } } },
    },
    orderBy: { visitDate: "desc" },
  });
  return res.json({ records });
});

router.post("/", requireRole("admin", "doctor"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });

  const record = await prisma.medicalRecord.create({
    data: parsed.data,
    include: {
      patient: { select: { id: true, fullName: true } },
      doctor: { include: { user: { select: { id: true, fullName: true } } } },
    },
  });
  return res.status(201).json({ record });
});

export default router;
