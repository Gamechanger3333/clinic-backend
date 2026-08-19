/**
 * src/lib/aiTools.ts — Tool-calling registry for the AI Assistant
 *
 * This is what actually gives the assistant access to "real system data" —
 * NOT vector-embedding RAG (this app's data is fully structured/relational,
 * so semantic chunk-retrieval is the wrong tool; exact filtered SQL via
 * Prisma is the right one).
 *
 * How it works: each tool is a JSON-schema function description (OpenAI/Groq
 * "function calling" format) paired with a server-side handler. The model
 * decides which tool(s) it needs based on the user's question; the backend
 * — not the model — executes the actual Prisma query and returns only the
 * data that specific handler is scoped to return.
 *
 * ── SECURITY MODEL — read this before adding a tool ─────────────────────
 * Every handler receives (userId, role) from the AUTHENTICATED SESSION, never
 * from the model's function-call arguments. A patient's tool set must be
 * PHYSICALLY INCAPABLE of returning another patient's data — this is not
 * enforced by prompting the model to "please only look at your own data",
 * it's enforced by the handler code itself always filtering by the caller's
 * own patientId/doctorId, the same way every REST route in this app does.
 * Tool args are only ever used for things like date ranges or status
 * filters, never for "which patient" or "which user".
 */

import { prisma } from "./prisma";
import { format } from "date-fns";
import type { AssistantRole } from "./groq";

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export type ToolHandler = (ctx: { userId: string; role: AssistantRole }, args: any) => Promise<any>;

interface ToolEntry {
  def: ToolDef;
  handler: ToolHandler;
}

// ─── Shared helper — same pattern used throughout the REST API ─────────────
async function ownPatientId(userId: string): Promise<string | null> {
  const patient = await prisma.patient.findFirst({ where: { createdBy: userId } });
  return patient?.id ?? null;
}

// ─── Tool definitions ───────────────────────────────────────────────────────
const registry: Record<string, ToolEntry> = {
  // === PUBLIC tools — for the anonymous landing-page assistant, before
  // sign-in. ONLY ever return aggregate counts / directory-style info that's
  // already publicly visible on the marketing site or the doctor directory
  // (which itself requires no auth — see routes/doctors.ts). No patient
  // names, no PHI, no per-user data of any kind, ever, for this role. ========
  get_clinic_overview: {
    def: {
      type: "function",
      function: {
        name: "get_clinic_overview",
        description:
          "Get high-level public stats about ClinicFlow: how many doctors are registered, how many departments/specializations are available. Use this for questions like 'how many doctors do you have' or 'what departments exist'.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async () => {
      const [doctorCount, departments] = await Promise.all([
        prisma.doctor.count(),
        prisma.department.findMany({ select: { name: true } }),
      ]);
      const specializations = await prisma.doctor.findMany({
        select: { specialization: true },
        distinct: ["specialization"],
      });
      return {
        registeredDoctors: doctorCount,
        departments: departments.map((d: any) => d.name),
        specializations: specializations.map((s: any) => s.specialization),
      };
    },
  },

  find_doctors_public: {
    def: {
      type: "function",
      function: {
        name: "find_doctors_public",
        description:
          "Search the public doctor directory by specialization or department name — for a visitor asking 'do you have a cardiologist' etc. Returns names and specializations only, nothing private.",
        parameters: {
          type: "object",
          properties: { specialization: { type: "string" }, department: { type: "string" } },
        },
      },
    },
    handler: async (_ctx, args) => {
      const doctors = await prisma.doctor.findMany({
        where: {
          ...(args?.specialization ? { specialization: { contains: args.specialization, mode: "insensitive" } } : {}),
          ...(args?.department ? { department: { name: { contains: args.department, mode: "insensitive" } } } : {}),
        },
        include: { user: { select: { fullName: true } }, department: { select: { name: true } } },
        take: 8,
      });
      return doctors.map((d: any) => ({
        name: d.user.fullName,
        specialization: d.specialization,
        department: d.department?.name,
      }));
    },
  },

  // === PATIENT tools — every handler below filters by the CALLER's own
  // patient record. There is no `patientId` argument anywhere in this
  // group; the model cannot ask for someone else's data because the
  // capability doesn't exist. ================================================
  get_my_appointments: {
    def: {
      type: "function",
      function: {
        name: "get_my_appointments",
        description: "Get the logged-in patient's own appointments (past and/or upcoming).",
        parameters: {
          type: "object",
          properties: {
            upcoming_only: { type: "boolean", description: "If true, only appointments from today onward." },
            limit: { type: "number", description: "Max results, default 10, max 20." },
          },
        },
      },
    },
    handler: async ({ userId }, args) => {
      const patientId = await ownPatientId(userId);
      if (!patientId) return { error: "No patient profile found." };
      const today = format(new Date(), "yyyy-MM-dd");
      const appointments = await prisma.appointment.findMany({
        where: { patientId, ...(args?.upcoming_only ? { appointmentDate: { gte: today } } : {}) },
        include: { doctor: { select: { fullName: true } } },
        orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "asc" }],
        take: Math.min(args?.limit ?? 10, 20),
      });
      return appointments.map((a: any) => ({
        date: a.appointmentDate,
        time: a.appointmentTime,
        doctor: a.doctor.fullName,
        status: a.status,
        reason: a.reason,
      }));
    },
  },

  get_my_prescriptions: {
    def: {
      type: "function",
      function: {
        name: "get_my_prescriptions",
        description: "Get the logged-in patient's own prescriptions, including medications.",
        parameters: { type: "object", properties: { limit: { type: "number" } } },
      },
    },
    handler: async ({ userId }, args) => {
      const patientId = await ownPatientId(userId);
      if (!patientId) return { error: "No patient profile found." };
      const rx = await prisma.prescription.findMany({
        where: { patientId },
        include: { doctor: { select: { fullName: true } } },
        orderBy: { createdAt: "desc" },
        take: Math.min(args?.limit ?? 10, 20),
      });
      return rx.map((r: any) => ({
        date: r.createdAt,
        doctor: r.doctor.fullName,
        diagnosis: r.diagnosis,
        medications: r.medications,
      }));
    },
  },

  get_my_lab_reports: {
    def: {
      type: "function",
      function: {
        name: "get_my_lab_reports",
        description: "Get the logged-in patient's own lab test reports and results.",
        parameters: { type: "object", properties: { limit: { type: "number" } } },
      },
    },
    handler: async ({ userId }, args) => {
      const patientId = await ownPatientId(userId);
      if (!patientId) return { error: "No patient profile found." };
      const reports = await prisma.labReport.findMany({
        where: { patientId },
        orderBy: { createdAt: "desc" },
        take: Math.min(args?.limit ?? 10, 20),
      });
      return reports.map((r: any) => ({
        testName: r.testName,
        testDate: r.testDate,
        status: r.status,
        results: r.results,
        normalRange: r.normalRange,
      }));
    },
  },

  get_my_invoices: {
    def: {
      type: "function",
      function: {
        name: "get_my_invoices",
        description: "Get the logged-in patient's own billing invoices.",
        parameters: {
          type: "object",
          properties: { status: { type: "string", enum: ["unpaid", "paid", "partial", "cancelled"] } },
        },
      },
    },
    handler: async ({ userId }, args) => {
      const patientId = await ownPatientId(userId);
      if (!patientId) return { error: "No patient profile found." };
      const invoices = await prisma.invoice.findMany({
        where: { patientId, ...(args?.status ? { status: args.status } : {}) },
        orderBy: { createdAt: "desc" },
        take: 15,
      });
      return invoices.map((i: any) => ({
        invoiceNumber: i.invoiceNumber,
        total: i.total,
        paidAmount: i.paidAmount,
        status: i.status,
        dueDate: i.dueDate,
      }));
    },
  },

  find_available_doctors: {
    def: {
      type: "function",
      function: {
        name: "find_available_doctors",
        description: "Search for doctors by specialization or department — useful when a patient wants to book.",
        parameters: {
          type: "object",
          properties: { specialization: { type: "string" }, department: { type: "string" } },
        },
      },
    },
    // Not PHI — same directory data every logged-in user can already browse
    // under /doctors, so no extra scoping needed here.
    handler: async (_ctx, args) => {
      const doctors = await prisma.doctor.findMany({
        where: {
          ...(args?.specialization ? { specialization: { contains: args.specialization, mode: "insensitive" } } : {}),
          ...(args?.department ? { department: { name: { contains: args.department, mode: "insensitive" } } } : {}),
        },
        include: { user: { select: { fullName: true } }, department: { select: { name: true } } },
        take: 10,
      });
      return doctors.map((d: any) => ({
        name: d.user.fullName,
        specialization: d.specialization,
        department: d.department?.name,
        consultationFee: d.consultationFee,
        workingDays: d.workingDays,
      }));
    },
  },

  // === DOCTOR tools — every handler filters by the CALLER's own doctorId.
  // get_patient_summary is the one exception that takes a patientId arg,
  // and it is explicitly scoped: it only returns data for a patient who has
  // an actual appointment/record with THIS doctor — a doctor cannot pull up
  // a stranger's chart just by guessing an ID. ================================
  get_my_today_schedule: {
    def: {
      type: "function",
      function: {
        name: "get_my_today_schedule",
        description: "Get the logged-in doctor's appointments for today.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async ({ userId }) => {
      const today = format(new Date(), "yyyy-MM-dd");
      const appointments = await prisma.appointment.findMany({
        where: { doctorId: userId, appointmentDate: today },
        include: { patient: { select: { fullName: true } } },
        orderBy: { appointmentTime: "asc" },
      });
      return appointments.map((a: any) => ({
        time: a.appointmentTime,
        patient: a.patient.fullName,
        status: a.status,
        reason: a.reason,
      }));
    },
  },

  get_my_pending_appointments: {
    def: {
      type: "function",
      function: {
        name: "get_my_pending_appointments",
        description: "Get the logged-in doctor's appointments still awaiting approval.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async ({ userId }) => {
      const appointments = await prisma.appointment.findMany({
        where: { doctorId: userId, status: "pending" },
        include: { patient: { select: { fullName: true } } },
        orderBy: [{ appointmentDate: "asc" }, { appointmentTime: "asc" }],
        take: 15,
      });
      return appointments.map((a: any) => ({
        date: a.appointmentDate,
        time: a.appointmentTime,
        patient: a.patient.fullName,
        reason: a.reason,
      }));
    },
  },

  get_patient_summary: {
    def: {
      type: "function",
      function: {
        name: "get_patient_summary",
        description:
          "Get a clinical summary for a specific patient BY NAME — only works if that patient has an existing appointment with the logged-in doctor.",
        parameters: {
          type: "object",
          properties: { patient_name: { type: "string", description: "The patient's full name, as the doctor typed it." } },
          required: ["patient_name"],
        },
      },
    },
    handler: async ({ userId }, args) => {
      if (!args?.patient_name) return { error: "patient_name is required." };

      // The doctor can only ever reach a patient they actually have a
      // relationship with — enforced via a join on Appointment.doctorId,
      // never a free lookup by patient ID/name alone.
      const link = await prisma.appointment.findFirst({
        where: { doctorId: userId, patient: { fullName: { contains: args.patient_name, mode: "insensitive" } } },
        include: { patient: true },
      });
      if (!link) return { error: "No patient by that name found among your appointments." };

      const [prescriptions, labReports, records] = await Promise.all([
        prisma.prescription.findMany({ where: { patientId: link.patientId, doctorId: userId }, orderBy: { createdAt: "desc" }, take: 5 }),
        prisma.labReport.findMany({ where: { patientId: link.patientId }, orderBy: { createdAt: "desc" }, take: 5 }),
        prisma.medicalRecord.findMany({ where: { patientId: link.patientId, doctorId: userId }, orderBy: { visitDate: "desc" }, take: 5 }),
      ]);

      return {
        patient: link.patient.fullName,
        allergies: link.patient.allergies,
        bloodGroup: link.patient.bloodGroup,
        recentPrescriptions: prescriptions.map((p: any) => ({ date: p.createdAt, diagnosis: p.diagnosis, medications: p.medications })),
        recentLabReports: labReports.map((r: any) => ({ testName: r.testName, date: r.testDate, status: r.status })),
        recentVisits: records.map((r: any) => ({ date: r.visitDate, chiefComplaint: r.chiefComplaint, diagnosis: r.diagnosis })),
      };
    },
  },

  // === RECEPTIONIST / ADMIN tools — clinic-wide, no per-patient PHI unless
  // explicitly searched by name (same scoping principle as above). ============
  get_clinic_today_overview: {
    def: {
      type: "function",
      function: {
        name: "get_clinic_today_overview",
        description: "Get clinic-wide counts for today: appointments, pending approvals, low-stock medicines.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async () => {
      const today = format(new Date(), "yyyy-MM-dd");
      const [todayCount, pending, lowStockMeds, revenue] = await Promise.all([
        prisma.appointment.count({ where: { appointmentDate: today } }),
        prisma.appointment.count({ where: { status: "pending" } }),
        prisma.medicine.findMany({ where: { isActive: true }, select: { stockQuantity: true, reorderLevel: true } }),
        prisma.invoice.aggregate({ where: { status: "paid" }, _sum: { total: true } }),
      ]);
      return {
        appointmentsToday: todayCount,
        pendingApprovals: pending,
        lowStockMedicineCount: lowStockMeds.filter((m: any) => m.stockQuantity <= m.reorderLevel).length,
        totalPaidRevenue: revenue._sum.total ?? 0,
      };
    },
  },

  search_patients: {
    def: {
      type: "function",
      function: {
        name: "search_patients",
        description: "Search the patient directory by name, email, or phone — front-desk lookup.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
    handler: async (_ctx, args) => {
      if (!args?.query) return { error: "query is required." };
      const patients = await prisma.patient.findMany({
        where: {
          OR: [
            { fullName: { contains: args.query, mode: "insensitive" } },
            { email: { contains: args.query, mode: "insensitive" } },
            { phone: { contains: args.query, mode: "insensitive" } },
          ],
        },
        select: { fullName: true, phone: true, email: true, createdAt: true },
        take: 10,
      });
      return patients;
    },
  },

  get_low_stock_medicines: {
    def: {
      type: "function",
      function: {
        name: "get_low_stock_medicines",
        description: "List medicines currently at or below their reorder level.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async () => {
      const meds = await prisma.medicine.findMany({ where: { isActive: true }, take: 500 });
      return meds
        .filter((m: any) => m.stockQuantity <= m.reorderLevel)
        .map((m: any) => ({ name: m.name, stock: m.stockQuantity, reorderLevel: m.reorderLevel }))
        .slice(0, 20);
    },
  },
};

// ─── Which tools each role is allowed to see/call ───────────────────────────
const ROLE_TOOLS: Record<AssistantRole, string[]> = {
  public: ["get_clinic_overview", "find_doctors_public"],
  patient: ["get_my_appointments", "get_my_prescriptions", "get_my_lab_reports", "get_my_invoices", "find_available_doctors"],
  doctor: ["get_my_today_schedule", "get_my_pending_appointments", "get_patient_summary"],
  receptionist: ["get_clinic_today_overview", "search_patients", "get_low_stock_medicines", "find_available_doctors"],
  admin: ["get_clinic_today_overview", "search_patients", "get_low_stock_medicines", "find_available_doctors"],
};

export function getToolsForRole(role: AssistantRole): ToolDef[] {
  return (ROLE_TOOLS[role] || []).map((name) => registry[name].def);
}

export async function executeTool(
  name: string,
  ctx: { userId: string; role: AssistantRole },
  args: any
): Promise<any> {
  // Defense in depth: even if the model somehow requests a tool name that
  // isn't in its allowed list (it shouldn't be able to — we only ever send
  // it the role-filtered tool list), refuse anything not explicitly granted
  // to this role.
  const allowed = ROLE_TOOLS[ctx.role] || [];
  if (!allowed.includes(name) || !registry[name]) {
    return { error: "Tool not available for this role." };
  }
  try {
    return await registry[name].handler(ctx, args);
  } catch (err) {
    console.error(`[AI TOOL ERROR] ${name}`, err);
    return { error: "This lookup failed. Please try again or check the relevant page directly." };
  }
}
