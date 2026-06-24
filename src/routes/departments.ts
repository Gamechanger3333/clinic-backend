import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

router.get("/", async (_req: Request, res: Response) => {
  const departments = await prisma.department.findMany({
    include: { doctors: { include: { user: { select: { id: true, fullName: true } } } } },
    orderBy: { name: "asc" },
  });
  return res.json({ departments });
});

router.post("/", requireRole("admin"), async (req: Request, res: Response) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Name required" });
  const dept = await prisma.department.create({ data: { name, description } });
  return res.status(201).json({ department: dept });
});

router.patch("/:id", requireRole("admin"), async (req: Request, res: Response) => {
  const dept = await prisma.department.update({ where: { id: req.params.id }, data: req.body });
  return res.json({ department: dept });
});

router.delete("/:id", requireRole("admin"), async (req: Request, res: Response) => {
  await prisma.department.delete({ where: { id: req.params.id } });
  return res.json({ success: true });
});

export default router;
