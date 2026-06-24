import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate } from "../middleware/auth";

const router = Router();
router.use(authenticate);

router.get("/", async (req: Request, res: Response) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return res.json({ notifications });
});

router.patch("/:id", async (req: Request, res: Response) => {
  const notification = await prisma.notification.update({
    where: { id: req.params.id, userId: req.user!.userId },
    data: { isRead: true },
  });
  return res.json({ notification });
});

router.delete("/:id", async (req: Request, res: Response) => {
  await prisma.notification.delete({ where: { id: req.params.id, userId: req.user!.userId } });
  return res.json({ success: true });
});

export default router;
