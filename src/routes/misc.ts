import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";
import { format } from "date-fns";

// ─── Profile ─────────────────────────────────────────────────────────────────
export const profileRouter = Router();
profileRouter.use(authenticate);

profileRouter.patch("/", async (req: Request, res: Response) => {
  const { fullName, phone } = req.body;
  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: { fullName, phone },
    select: { id: true, email: true, fullName: true, role: true, phone: true },
  });
  return res.json({ user });
});

// ─── Users ────────────────────────────────────────────────────────────────────
export const usersRouter = Router();
usersRouter.use(authenticate);

// Full user directory (names, emails, roles) — staff only. A patient account
// has no legitimate reason to enumerate every other account in the system.
usersRouter.get("/", requireRole("admin", "doctor", "receptionist"), async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    select: { id: true, fullName: true, email: true, role: true, createdAt: true },
  });
  return res.json({ users });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

dashboardRouter.get("/stats", async (_req: Request, res: Response) => {
  const today = format(new Date(), "yyyy-MM-dd");

  const [todayCount, totalPatients, pendingCount, completedCount, totalDoctors, totalDepartments, lowStockMeds, recentAppointments, revenueResult] =
    await Promise.all([
      prisma.appointment.count({ where: { appointmentDate: today } }),
      prisma.patient.count(),
      prisma.appointment.count({ where: { status: "pending" } }),
      prisma.appointment.count({ where: { appointmentDate: today, status: "completed" } }),
      prisma.doctor.count(),
      prisma.department.count(),
      prisma.medicine.count({ where: { isActive: true, stockQuantity: { lte: 10 } } }),
      prisma.appointment.findMany({
        include: {
          patient: { select: { fullName: true } },
          doctor: { select: { fullName: true } },
        },
        orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "desc" }],
        take: 5,
      }),
      prisma.invoice.aggregate({ where: { status: "paid" }, _sum: { paidAmount: true } }),
    ]);

  return res.json({
    todayAppointments: todayCount,
    totalPatients,
    pendingApprovals: pendingCount,
    completedToday: completedCount,
    totalDoctors,
    totalDepartments,
    lowStockMedicines: lowStockMeds,
    totalRevenue: revenueResult._sum.paidAmount || 0,
    recentAppointments,
  });
});
