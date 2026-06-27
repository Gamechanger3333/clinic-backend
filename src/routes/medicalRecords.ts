import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// Diagnosis / treatment notes are the most sensitive PHI in the system.
// Reads: any clinical/admin staff. Writes: doctors and admin only —
// receptionists should not be able to author clinical notes.
// Patient self-service is out of scope until Patient<->User linkage exists.
router.get("/", requireRole("admin", "doctor", "receptionist"), async (req: Request, res: Response) => {
  const patientId = (req.query.patientId as string) || undefined;
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
  const { patientId, doctorId, appointmentId, visitDate, chiefComplaint, diagnosis, treatment, notes, followUpDate } = req.body;
  if (!patientId || !doctorId || !visitDate || !chiefComplaint)
    return res.status(400).json({ error: "patientId, doctorId, visitDate, chiefComplaint required" });

  const record = await prisma.medicalRecord.create({
    data: { patientId, doctorId, appointmentId, visitDate, chiefComplaint, diagnosis, treatment, notes, followUpDate },
    include: {
      patient: { select: { id: true, fullName: true } },
      doctor: { include: { user: { select: { id: true, fullName: true } } } },
    },
  });
  return res.status(201).json({ record });
});

export default router;
