import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

router.get("/", async (req: Request, res: Response) => {
  const search = (req.query.search as string) || "";
  const departmentId = (req.query.departmentId as string) || "";

  const doctors = await prisma.doctor.findMany({
    where: {
      ...(departmentId ? { departmentId } : {}),
      ...(search ? { user: { fullName: { contains: search, mode: "insensitive" } } } : {}),
    },
    include: {
      user: { select: { id: true, fullName: true, email: true, phone: true, avatarUrl: true } },
      department: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ doctors });
});

router.post("/", requireRole("admin"), async (req: Request, res: Response) => {
  const { userId, departmentId, specialization, licenseNumber, experience, consultationFee, bio } = req.body;
  if (!userId || !specialization) return res.status(400).json({ error: "userId and specialization required" });

  const doctor = await prisma.doctor.create({
    data: { userId, departmentId, specialization, licenseNumber, experience: experience || 0, consultationFee: consultationFee || 0, bio },
    include: {
      user: { select: { id: true, fullName: true, email: true } },
      department: { select: { id: true, name: true } },
    },
  });
  return res.status(201).json({ doctor });
});

router.get("/:id", async (req: Request, res: Response) => {
  const doctor = await prisma.doctor.findUnique({
    where: { id: req.params.id },
    include: { user: { select: { id: true, fullName: true, email: true, phone: true, avatarUrl: true } }, department: true },
  });
  if (!doctor) return res.status(404).json({ error: "Not found" });
  return res.json({ doctor });
});

router.patch("/:id", requireRole("admin"), async (req: Request, res: Response) => {
  const doctor = await prisma.doctor.update({ where: { id: req.params.id }, data: req.body });
  return res.json({ doctor });
});

router.delete("/:id", requireRole("admin"), async (req: Request, res: Response) => {
  await prisma.doctor.delete({ where: { id: req.params.id } });
  return res.json({ success: true });
});

export default router;
