import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

router.get("/", async (_req: Request, res: Response) => {
  const prescriptions = await prisma.prescription.findMany({
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
  try {
    const rx = await prisma.prescription.create({
      data: { ...req.body, doctorId: req.user!.userId },
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
