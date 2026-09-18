/**
 * src/routes/ai.ts — AI Assistant (Groq)
 *
 * Two endpoints:
 *  - POST /api/ai/chat          (auth required) — role-aware assistant for
 *                                  patient / doctor / receptionist / admin
 *  - POST /api/ai/public-chat   (no auth)        — general assistant for the
 *                                  public landing page
 *
 * Both are IP rate-limited (aiLimiter) since every call costs Groq tokens.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { aiLimiter } from "../middleware/rateLimiter";
import { askGroq, AssistantRole, ChatMessage } from "../lib/groq";
import { prisma } from "../lib/prisma";
import { format } from "date-fns";

const router = Router();

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(2000),
      })
    )
    .max(20)
    .optional()
    .default([]),
});

// ─── Small, safe, per-role context so the assistant can reference real
// numbers without ever being handed raw PHI/full record dumps ────────────────
async function buildContextSummary(role: AssistantRole, userId: string): Promise<string | undefined> {
  const today = format(new Date(), "yyyy-MM-dd");

  try {
    if (role === "patient") {
      const patient = await prisma.patient.findFirst({ where: { createdBy: userId } });
      if (!patient) return undefined;
      const upcoming = await prisma.appointment.count({
        where: { patientId: patient.id, appointmentDate: { gte: today }, status: { in: ["pending", "approved"] } },
      });
      return `- The patient has ${upcoming} upcoming appointment(s).`;
    }

    if (role === "doctor") {
      // NOTE: Appointment.doctorId references User.id directly (not Doctor.id),
      // so we filter with the logged-in doctor's own userId.
      const todayCount = await prisma.appointment.count({
        where: { doctorId: userId, appointmentDate: today },
      });
      const pending = await prisma.appointment.count({
        where: { doctorId: userId, status: "pending" },
      });
      return `- Dr. has ${todayCount} appointment(s) today and ${pending} pending approval(s).`;
    }

    if (role === "receptionist" || role === "admin") {
      const [todayCount, pending, lowStock, totalDoctors, totalPatients, totalDepartments] = await Promise.all([
        prisma.appointment.count({ where: { appointmentDate: today } }),
        prisma.appointment.count({ where: { status: "pending" } }),
        prisma.medicine.count({ where: { isActive: true, stockQuantity: { lte: 10 } } }),
        prisma.doctor.count(),
        prisma.patient.count(),
        prisma.department.count(),
      ]);
      return `- Staffing: ${totalDoctors} doctor(s) across ${totalDepartments} department(s). Patients: ${totalPatients} registered in total.\n- Clinic-wide today: ${todayCount} appointment(s), ${pending} pending approval(s), ${lowStock} medicine(s) low on stock.`;
    }
  } catch (e) {
    console.error("[AI CONTEXT ERROR]", e);
  }
  return undefined;
}

// ─── POST /api/ai/chat (authenticated, role-aware) ────────────────────────────
router.post("/chat", aiLimiter, authenticate, async (req: Request, res: Response) => {
  try {
    const { message, history } = chatSchema.parse(req.body);
    const role = (req.user!.role as AssistantRole) || "patient";

    const context = await buildContextSummary(role, req.user!.userId);
    const fullHistory: ChatMessage[] = [...history, { role: "user", content: message }];

    const reply = await askGroq(role, fullHistory, context);
    return res.json({ reply, role });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.issues[0]?.message || "Validation error" });
    }
    console.error("[AI CHAT ERROR]", e);
    return res.status(e.status || 500).json({ error: e.message || "AI assistant error" });
  }
});

// ─── Aggregate, non-PHI stats for anonymous visitors — counts only, never
// names/dates/records for any specific patient ─────────────────────────────
async function buildPublicContextSummary(): Promise<string | undefined> {
  try {
    const [totalDoctors, totalDepartments, availableDoctors] = await Promise.all([
      prisma.doctor.count(),
      prisma.department.count(),
      prisma.doctor.count({ where: { isAvailable: true } }),
    ]);
    return `- ClinicFlow currently has ${totalDoctors} doctor(s) across ${totalDepartments} department(s), ${availableDoctors} currently accepting appointments.`;
  } catch (e) {
    console.error("[AI PUBLIC CONTEXT ERROR]", e);
    return undefined;
  }
}

// ─── POST /api/ai/public-chat (no auth — landing page widget) ────────────────
router.post("/public-chat", aiLimiter, async (req: Request, res: Response) => {
  try {
    const { message, history } = chatSchema.parse(req.body);
    const fullHistory: ChatMessage[] = [...history, { role: "user", content: message }];
    const context = await buildPublicContextSummary();
    const reply = await askGroq("public", fullHistory, context);
    return res.json({ reply, role: "public" });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.issues[0]?.message || "Validation error" });
    }
    console.error("[AI PUBLIC CHAT ERROR]", e);
    return res.status(e.status || 500).json({ error: e.message || "AI assistant error" });
  }
});

export default router;
