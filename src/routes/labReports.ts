import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// Lab results are PHI — staff see all; patients may view only their own.
const STAFF_ROLES = ["admin", "doctor", "receptionist"];
const ALL_ROLES = [...STAFF_ROLES, "patient"];

const createSchema = z.object({
  patientId: z.string().min(1),
  doctorId: z.string().min(1),
  testName: z.string().trim().min(1).max(200),
  testDate: z.string().min(1),
  results: z.string().max(4000).optional(),
  normalRange: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

const patchSchema = z
  .object({
    testName: z.string().trim().min(1).max(200).optional(),
    testDate: z.string().min(1).optional(),
    results: z.string().max(4000).optional(),
    normalRange: z.string().max(200).optional(),
    status: z.enum(["pending", "completed", "cancelled"]).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

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
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });

  const report = await prisma.labReport.create({
    data: { ...parsed.data, orderedById: req.user!.userId },
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
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  try {
    const report = await prisma.labReport.update({ where: { id: req.params.id }, data: parsed.data });
    return res.json({ report });
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

export default router;
