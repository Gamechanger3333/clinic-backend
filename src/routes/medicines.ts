import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  genericName: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  unit: z.string().max(30).default("tablets"),
  stockQuantity: z.coerce.number().int().min(0).default(0),
  reorderLevel: z.coerce.number().int().min(0).default(10),
  unitPrice: z.coerce.number().min(0).default(0),
  manufacturer: z.string().max(200).optional(),
  expiryDate: z.string().optional(),
  description: z.string().max(1000).optional(),
});

const patchSchema = createSchema.partial().strict();

router.get("/", async (req: Request, res: Response) => {
  const search = (req.query.search as string) || "";
  const lowStock = req.query.lowStock === "true";

  const medicines = await prisma.medicine.findMany({
    where: {
      isActive: true,
      ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { genericName: { contains: search, mode: "insensitive" } }] } : {}),
    },
    orderBy: { name: "asc" },
  });
  const result = lowStock ? medicines.filter((m: (typeof medicines)[number]) => m.stockQuantity <= m.reorderLevel) : medicines;
  return res.json({ medicines: result });
});

router.post("/", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });

  const medicine = await prisma.medicine.create({ data: parsed.data });
  return res.status(201).json({ medicine });
});

router.patch("/:id", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  try {
    const medicine = await prisma.medicine.update({ where: { id: req.params.id }, data: parsed.data });
    return res.json({ medicine });
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

router.delete("/:id", requireRole("admin"), async (req: Request, res: Response) => {
  await prisma.medicine.update({ where: { id: req.params.id }, data: { isActive: false } });
  return res.json({ success: true });
});

export default router;
