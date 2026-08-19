import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// Patient PII (address, allergies, medical history) — staff only.
const STAFF_ROLES = ["admin", "doctor", "receptionist"];

const patientSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required").max(200),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(30).optional().or(z.literal("")),
  dateOfBirth: z.string().max(20).optional().or(z.literal("")),
  gender: z.string().max(30).optional().or(z.literal("")),
  address: z.string().max(500).optional().or(z.literal("")),
  medicalHistory: z.string().max(4000).optional().or(z.literal("")),
  bloodGroup: z.string().max(10).optional().or(z.literal("")),
  emergencyContact: z.string().max(100).optional().or(z.literal("")),
  allergies: z.string().max(1000).optional().or(z.literal("")),
});

const patientPatchSchema = patientSchema.partial();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
});

// GET /api/patients — paginated + searchable (name/email/phone)
router.get("/", requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid query params" });
  }
  const { page, limit, search } = parsed.data;

  const where = search
    ? {
        OR: [
          { fullName: { contains: search, mode: "insensitive" as const } },
          { email: { contains: search, mode: "insensitive" as const } },
          { phone: { contains: search, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [patients, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.patient.count({ where }),
  ]);

  return res.json({
    patients,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

router.post("/", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  const parsed = patientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  }
  try {
    const patient = await prisma.patient.create({ data: { ...parsed.data, createdBy: req.user!.userId } });
    return res.status(201).json({ patient });
  } catch {
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/:id", requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
  if (!patient) return res.status(404).json({ error: "Not found" });
  return res.json({ patient });
});

router.patch("/:id", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  const parsed = patientPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  }
  try {
    const patient = await prisma.patient.update({ where: { id: req.params.id }, data: parsed.data });
    return res.json({ patient });
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

router.delete("/:id", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    await prisma.patient.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

export default router;
