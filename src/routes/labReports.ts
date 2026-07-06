import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// Lab results are PHI — staff see all; patients may view only their own.
const STAFF_ROLES = ["admin", "doctor", "receptionist"];
const ALL_ROLES = [...STAFF_ROLES, "patient"];

router.get("/", requireRole(...ALL_ROLES), async (req: Request, res: Response) => {
  let patientId = (req.query.patientId as string) || undefined;
  if (req.user!.role === "patient") {
    const patient = await prisma.patient.findFirst({ where: { createdBy: req.user!.userId } });
    patientId = patient?.id || "__none__";
  }
  const reports = await prisma.labReport.findMany({
    where: { ...(patientId ? { patientId } : {}) },
    include: {
      patient: { select: { id: true, fullName: true, email: true } },
      doctor: { include: { user: { select: { id: true, fullName: true } } } },
      orderedBy: { select: { id: true, fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ reports });
});

router.post("/", requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  const { patientId, doctorId, testName, testDate, results, normalRange, notes } = req.body;
  if (!patientId || !doctorId || !testName || !testDate)
    return res.status(400).json({ error: "patientId, doctorId, testName, testDate required" });

  const report = await prisma.labReport.create({
    data: { patientId, doctorId, testName, testDate, results, normalRange, notes, orderedById: req.user!.userId },
    include: {
      patient: { select: { id: true, fullName: true } },
      doctor: { include: { user: { select: { id: true, fullName: true } } } },
    },
  });
  return res.status(201).json({ report });
});

router.get("/:id", requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  const report = await prisma.labReport.findUnique({ where: { id: req.params.id }, include: { patient: true, doctor: { include: { user: true } } } });
  if (!report) return res.status(404).json({ error: "Not found" });
  return res.json({ report });
});

router.patch("/:id", requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  const report = await prisma.labReport.update({ where: { id: req.params.id }, data: req.body });
  return res.json({ report });
});

export default router;
