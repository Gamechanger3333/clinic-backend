import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

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
  const result = lowStock ? medicines.filter((m) => m.stockQuantity <= m.reorderLevel) : medicines;
  return res.json({ medicines: result });
});

router.post("/", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  const { name, genericName, category, unit, stockQuantity, reorderLevel, unitPrice, manufacturer, expiryDate, description } = req.body;
  if (!name || !genericName || !category) return res.status(400).json({ error: "name, genericName, category required" });

  const medicine = await prisma.medicine.create({
    data: { name, genericName, category, unit: unit || "tablets", stockQuantity: stockQuantity || 0, reorderLevel: reorderLevel || 10, unitPrice: unitPrice || 0, manufacturer, expiryDate, description },
  });
  return res.status(201).json({ medicine });
});

router.patch("/:id", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  const medicine = await prisma.medicine.update({ where: { id: req.params.id }, data: req.body });
  return res.json({ medicine });
});

router.delete("/:id", requireRole("admin"), async (req: Request, res: Response) => {
  await prisma.medicine.update({ where: { id: req.params.id }, data: { isActive: false } });
  return res.json({ success: true });
});

export default router;
