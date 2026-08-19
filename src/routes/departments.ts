import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

const schema = z.object({
  name: z.string().trim().min(1, "Name required").max(200),
  description: z.string().max(1000).optional(),
});
const patchSchema = schema.partial().strict();

router.get("/", async (_req: Request, res: Response) => {
  const departments = await prisma.department.findMany({
    include: { doctors: { include: { user: { select: { id: true, fullName: true } } } } },
    orderBy: { name: "asc" },
  });
  return res.json({ departments });
});

router.post("/", requireRole("admin"), async (req: Request, res: Response) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  const dept = await prisma.department.create({ data: parsed.data });
  return res.status(201).json({ department: dept });
});

router.patch("/:id", requireRole("admin"), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  try {
    const dept = await prisma.department.update({ where: { id: req.params.id }, data: parsed.data });
    return res.json({ department: dept });
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

router.delete("/:id", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    await prisma.department.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

export default router;
