import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";
import { isDemoAccount } from "../lib/demo";
import { format } from "date-fns";

// ─── Profile ─────────────────────────────────────────────────────────────────
export const profileRouter = Router();
profileRouter.use(authenticate);

profileRouter.patch("/", async (req: Request, res: Response) => {
  if (isDemoAccount(req.user!.email)) {
    return res.status(403).json({ error: "This is a shared demo account — profile edits are disabled so every visitor sees the same clean profile." });
  }
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

// Stats are scoped to WHO is asking:
//  - patient      → only their own appointments (never another patient's data)
//  - doctor       → only appointments assigned to them
//  - receptionist / admin → clinic-wide, front-desk operational view
dashboardRouter.get("/stats", async (req: Request, res: Response) => {
  const today = format(new Date(), "yyyy-MM-dd");
  const role = req.user!.role;
  const userId = req.user!.userId;

  // Build a role-scoped appointment filter up front so every count below
  // stays consistent with what the person is actually allowed to see.
  let appointmentScope: Record<string, any> = {};
  if (role === "patient") {
    const patient = await prisma.patient.findFirst({ where: { createdBy: userId } });
    appointmentScope = { patientId: patient?.id || "__none__" };
  } else if (role === "doctor") {
    // Appointment.doctorId references the doctor's User.id directly.
    appointmentScope = { doctorId: userId };
  }
  // receptionist/admin → no extra scope, i.e. clinic-wide.

  const [todayCount, totalPatients, pendingCount, completedCount, totalDoctors, totalDepartments, lowStockMeds, recentAppointments, revenueResult] =
    await Promise.all([
      prisma.appointment.count({ where: { ...appointmentScope, appointmentDate: today } }),
      role === "patient" ? Promise.resolve(1) : prisma.patient.count(),
      prisma.appointment.count({ where: { ...appointmentScope, status: "pending" } }),
      prisma.appointment.count({ where: { ...appointmentScope, appointmentDate: today, status: "completed" } }),
      prisma.doctor.count(),
      prisma.department.count(),
      prisma.medicine.count({ where: { isActive: true, stockQuantity: { lte: 10 } } }),
      prisma.appointment.findMany({
        where: appointmentScope,
        include: {
          patient: { select: { fullName: true } },
          doctor: { select: { fullName: true } },
        },
        orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "desc" }],
        take: 5,
      }),
      role === "admin"
        ? prisma.invoice.aggregate({ where: { status: "paid" }, _sum: { paidAmount: true } })
        : Promise.resolve({ _sum: { paidAmount: 0 } }),
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
    role,
  });
});
