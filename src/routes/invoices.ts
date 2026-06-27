import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// Billing data — staff only (admin/receptionist handle billing; doctors can
// view to confirm a visit was billed). Patient self-service is out of scope
// until Patient<->User linkage exists — see review notes.
const STAFF_ROLES = ["admin", "doctor", "receptionist"];

router.get("/", requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  const patientId = (req.query.patientId as string) || undefined;
  const status = (req.query.status as string) || undefined;

  const invoices = await prisma.invoice.findMany({
    where: {
      ...(patientId ? { patientId } : {}),
      ...(status ? { status: status as any } : {}),
    },
    include: {
      patient: { select: { id: true, fullName: true, email: true, phone: true } },
      appointment: { select: { appointmentDate: true, appointmentTime: true } },
      createdBy: { select: { id: true, fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ invoices });
});

router.get("/:id", requireRole(...STAFF_ROLES), async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: {
      patient: { select: { id: true, fullName: true, email: true, phone: true, address: true } },
      appointment: { select: { appointmentDate: true, appointmentTime: true, reason: true } },
      createdBy: { select: { id: true, fullName: true } },
    },
  });
  if (!invoice) return res.status(404).json({ error: "Not found" });
  return res.json({ invoice });
});

router.post("/", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  const { patientId, appointmentId, items = [], discount = 0, tax = 0, notes, dueDate } = req.body;
  if (!patientId) return res.status(400).json({ error: "Patient required" });
  if (!items.length) return res.status(400).json({ error: "At least one item required" });

  const subtotal = items.reduce((s: number, i: any) => s + i.quantity * i.unitPrice, 0);
  const total = subtotal - discount + tax;
  const count = await prisma.invoice.count();
  const invoiceNumber = `INV-${String(count + 1).padStart(5, "0")}`;

  const invoice = await prisma.invoice.create({
    data: { invoiceNumber, patientId, appointmentId: appointmentId || null, createdById: req.user!.userId, items, subtotal, discount, tax, total, notes, dueDate },
    include: { patient: { select: { id: true, fullName: true, email: true } } },
  });
  return res.status(201).json({ invoice });
});

router.patch("/:id", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  const updateData: any = { ...req.body };
  if (req.body.status === "paid" && !req.body.paidAt) updateData.paidAt = new Date();
  const invoice = await prisma.invoice.update({
    where: { id: req.params.id },
    data: updateData,
    include: { patient: { select: { id: true, fullName: true } } },
  });
  return res.json({ invoice });
});

router.delete("/:id", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  await prisma.invoice.delete({ where: { id: req.params.id } });
  return res.json({ success: true });
});

export default router;
