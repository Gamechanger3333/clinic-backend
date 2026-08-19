import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const createSchema = z.object({
  userId: z.string().min(1),
  departmentId: z.string().min(1).optional(),
  specialization: z.string().trim().min(1).max(200),
  licenseNumber: z.string().max(100).optional(),
  experience: z.coerce.number().int().min(0).max(80).default(0),
  consultationFee: z.coerce.number().min(0).default(0),
  bio: z.string().max(2000).optional(),
});

const patchSchema = z
  .object({
    departmentId: z.string().min(1).optional(),
    specialization: z.string().trim().min(1).max(200).optional(),
    licenseNumber: z.string().max(100).optional(),
    experience: z.coerce.number().int().min(0).max(80).optional(),
    consultationFee: z.coerce.number().min(0).optional(),
    bio: z.string().max(2000).optional(),
    isAvailable: z.boolean().optional(),
    workingDays: z.array(z.string()).optional(),
    startTime: z.string().regex(TIME_RE).optional(),
    endTime: z.string().regex(TIME_RE).optional(),
  })
  .strict();

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
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });

  const doctor = await prisma.doctor.create({
    data: parsed.data,
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
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  try {
    const doctor = await prisma.doctor.update({ where: { id: req.params.id }, data: parsed.data });
    return res.json({ doctor });
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

router.delete("/:id", requireRole("admin"), async (req: Request, res: Response) => {
  await prisma.doctor.delete({ where: { id: req.params.id } });
  return res.json({ success: true });
});

export default router;
