import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// Billing data — staff handle billing; patients may view (read-only) only
// their own invoices, never anyone else's.
const STAFF_ROLES = ["admin", "doctor", "receptionist"];
const ALL_ROLES = [...STAFF_ROLES, "patient"];

const itemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  quantity: z.coerce.number().min(0.01),
  unitPrice: z.coerce.number().min(0),
});

const createSchema = z.object({
  patientId: z.string().min(1, "Patient required"),
  appointmentId: z.string().min(1).optional(),
  items: z.array(itemSchema).min(1, "At least one item required"),
  discount: z.coerce.number().min(0).default(0),
  tax: z.coerce.number().min(0).default(0),
  notes: z.string().max(1000).optional(),
  dueDate: z.string().optional(),
});

// Only status/paidAmount/notes/dueDate may be edited after creation —
// invoiceNumber, patientId, and createdById must never be client-writable.
const patchSchema = z
  .object({
    status: z.enum(["unpaid", "paid", "partial", "cancelled"]).optional(),
    paidAmount: z.coerce.number().min(0).optional(),
    notes: z.string().max(1000).optional(),
    dueDate: z.string().optional(),
  })
  .strict();

router.get("/", requireRole(...ALL_ROLES), async (req: Request, res: Response) => {
  let patientId = (req.query.patientId as string) || undefined;
  const status = (req.query.status as string) || undefined;

  if (req.user!.role === "patient") {
    const patient = await prisma.patient.findFirst({ where: { createdBy: req.user!.userId } });
    patientId = patient?.id || "__none__";
  }

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

router.get("/:id", requireRole(...ALL_ROLES), async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: {
      patient: { select: { id: true, fullName: true, email: true, phone: true, address: true } },
      appointment: { select: { appointmentDate: true, appointmentTime: true, reason: true } },
      createdBy: { select: { id: true, fullName: true } },
    },
  });
  if (!invoice) return res.status(404).json({ error: "Not found" });

  if (req.user!.role === "patient") {
    const patient = await prisma.patient.findFirst({ where: { createdBy: req.user!.userId } });
    if (!patient || invoice.patientId !== patient.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }
  return res.json({ invoice });
});

router.post("/", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  const { patientId, appointmentId, items, discount, tax, notes, dueDate } = parsed.data;

  const subtotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const total = subtotal - discount + tax;

  // Invoice numbering: count()+1 is only a *starting guess* — under
  // concurrent requests two callers could compute the same number. Rather
  // than trust that guess, we retry on the actual unique-constraint
  // violation so a collision can never silently corrupt data; it just
  // costs one extra query on the rare occasions two requests race.
  const MAX_ATTEMPTS = 5;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const count = await prisma.invoice.count();
    const invoiceNumber = `INV-${String(count + 1 + attempt).padStart(5, "0")}`;
    try {
      const invoice = await prisma.invoice.create({
        data: { invoiceNumber, patientId, appointmentId: appointmentId || null, createdById: req.user!.userId, items, subtotal, discount, tax, total, notes, dueDate },
        include: { patient: { select: { id: true, fullName: true, email: true } } },
      });
      return res.status(201).json({ invoice });
    } catch (err) {
      lastError = err;
      // P2002 = unique constraint violation on invoiceNumber; retry with a
      // bumped number. Any other error should fail fast, not retry.
      if ((err as any)?.code !== "P2002") break;
    }
  }
  console.error("[INVOICE CREATE ERROR]", lastError);
  return res.status(409).json({ error: "Could not generate a unique invoice number — please retry." });
});

router.patch("/:id", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation error" });
  const updateData: any = { ...parsed.data };
  if (parsed.data.status === "paid") updateData.paidAt = new Date();
  try {
    const invoice = await prisma.invoice.update({
      where: { id: req.params.id },
      data: updateData,
      include: { patient: { select: { id: true, fullName: true } } },
    });
    return res.json({ invoice });
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

router.delete("/:id", requireRole("admin", "receptionist"), async (req: Request, res: Response) => {
  await prisma.invoice.delete({ where: { id: req.params.id } });
  return res.json({ success: true });
});

export default router;
