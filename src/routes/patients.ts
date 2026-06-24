import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate } from "../middleware/auth";

const router = Router();
router.use(authenticate);

router.get("/", async (_req: Request, res: Response) => {
  const patients = await prisma.patient.findMany({ orderBy: { createdAt: "desc" } });
  return res.json({ patients });
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body.fullName?.trim()) return res.status(400).json({ error: "Full name required" });
    const patient = await prisma.patient.create({ data: { ...body, createdBy: req.user!.userId } });
    return res.status(201).json({ patient });
  } catch {
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
  if (!patient) return res.status(404).json({ error: "Not found" });
  return res.json({ patient });
});

router.patch("/:id", async (req: Request, res: Response) => {
  const patient = await prisma.patient.update({ where: { id: req.params.id }, data: req.body });
  return res.json({ patient });
});

router.delete("/:id", async (req: Request, res: Response) => {
  await prisma.patient.delete({ where: { id: req.params.id } });
  return res.json({ success: true });
});

export default router;
