import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// GET /api/appointments
router.get("/", async (req: Request, res: Response) => {
  const appointments = await prisma.appointment.findMany({
    include: {
      patient: { select: { id: true, fullName: true, email: true } },
      doctor: { select: { id: true, fullName: true } },
    },
    orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "asc" }],
  });
  return res.json({ appointments });
});

// POST /api/appointments
router.post("/", async (req: Request, res: Response) => {
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
router.patch("/:id", async (req: Request, res: Response) => {
  const apt = await prisma.appointment.update({
    where: { id: req.params.id },
    data: req.body,
    include: { patient: { select: { id: true, fullName: true } } },
  });
  return res.json({ appointment: apt });
});

export default router;
