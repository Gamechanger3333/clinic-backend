import { prisma } from "./prisma";

/**
 * Demo account — lets anyone (recruiters, reviewers) explore the app as a
 * real logged-in patient without going through signup/email verification.
 *
 * Password lives in an env var so it's never hardcoded in more than one
 * place; this file is the single source of truth both `prisma/seed.ts` and
 * the `/api/auth/demo-login` route import from.
 */
export const DEMO_USER_EMAIL = process.env.DEMO_USER_EMAIL || "demo@clinicflow.com";
export const DEMO_USER_PASSWORD = process.env.DEMO_USER_PASSWORD || "Demo@1234";
export const DEMO_PATIENT_ID = "pat-demo";

/** True for the shared demo account — used to fence off actions that would
 * either break the demo for the next visitor (changing the password,
 * enabling MFA) or let one visitor deface what another visitor sees. */
export function isDemoAccount(email: string | undefined | null): boolean {
  return !!email && email.toLowerCase() === DEMO_USER_EMAIL.toLowerCase();
}

/**
 * Wipes and reseeds every record that belongs to the demo patient, so each
 * "Try Demo" click hands out a clean, consistent, realistic-looking
 * workspace — never last visitor's half-finished edits or test junk.
 *
 * Deliberately scoped to ONLY the demo patient's own rows (by patientId /
 * doctor-facing rows that reference it) — never touches any other
 * patient, doctor, or admin data in the database.
 */
export async function reseedDemoPatientData(demoUserId: string) {
  const [doctors, admin] = await Promise.all([
    prisma.doctor.findMany({ include: { user: true }, take: 2 }),
    prisma.user.findFirst({ where: { role: "admin" } }),
  ]);
  if (doctors.length === 0) {
    // Fresh/empty DB with no doctors seeded yet — nothing meaningful to
    // attach demo data to. The demo login will still work, just with an
    // empty dashboard, rather than throwing.
    console.warn("[demo] No doctors found — skipping demo data reseed.");
    return;
  }
  const [doctorA, doctorB] = [doctors[0], doctors[1] || doctors[0]];
  const creatorId = admin?.id || demoUserId;

  // Wipe this patient's existing rows. Order matters here: Invoice and
  // MedicalRecord both have an OPTIONAL `appointmentId` FK with no
  // onDelete cascade in the schema (only Prescription cascades), so they
  // must be deleted BEFORE their parent Appointment or Postgres throws a
  // foreign-key-restrict error. LabReport/Notification have no such
  // dependency and can go in any order.
  await prisma.$transaction([
    prisma.notification.deleteMany({ where: { userId: demoUserId } }),
    prisma.labReport.deleteMany({ where: { patientId: DEMO_PATIENT_ID } }),
    prisma.invoice.deleteMany({ where: { patientId: DEMO_PATIENT_ID } }),
    prisma.medicalRecord.deleteMany({ where: { patientId: DEMO_PATIENT_ID } }),
    prisma.prescription.deleteMany({ where: { patientId: DEMO_PATIENT_ID } }),
    prisma.appointment.deleteMany({ where: { patientId: DEMO_PATIENT_ID } }),
  ]);

  const today = new Date();
  const iso = (offsetDays: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().split("T")[0];
  };

  const reasons = [
    "Annual physical checkup", "Persistent headaches", "Follow-up on blood pressure",
    "Seasonal allergy symptoms", "Routine bloodwork review", "Lower back pain",
    "Skin rash consultation", "Diabetes management review",
  ];

  // 8 appointments spread across past (completed/cancelled), today
  // (approved), and future (pending) — a realistic mixed workload.
  const appointmentPlans = [
    { offset: -30, status: "completed" as const }, { offset: -21, status: "completed" as const },
    { offset: -14, status: "completed" as const }, { offset: -7, status: "cancelled" as const },
    { offset: -2, status: "completed" as const }, { offset: 0, status: "approved" as const },
    { offset: 5, status: "pending" as const }, { offset: 12, status: "pending" as const },
  ];

  const createdAppointments = [];
  for (let i = 0; i < appointmentPlans.length; i++) {
    const plan = appointmentPlans[i];
    const doctor = i % 2 === 0 ? doctorA : doctorB;
    const apt = await prisma.appointment.create({
      data: {
        id: `apt-demo-${i + 1}`,
        patientId: DEMO_PATIENT_ID,
        doctorId: doctor.userId,
        appointmentDate: iso(plan.offset),
        appointmentTime: ["09:00", "10:30", "11:15", "14:00", "15:30"][i % 5],
        status: plan.status,
        reason: reasons[i % reasons.length],
        createdBy: demoUserId,
      },
    });
    createdAppointments.push({ apt, doctor });
  }

  // Prescriptions + invoices for the completed visits (realistic: you only
  // get a prescription/bill after the appointment actually happened).
  const completed = createdAppointments.filter((a) => a.apt.status === "completed");
  for (let i = 0; i < completed.length; i++) {
    const { apt, doctor } = completed[i];
    await prisma.prescription.create({
      data: {
        appointmentId: apt.id,
        patientId: DEMO_PATIENT_ID,
        doctorId: doctor.userId,
        medications: [
          { name: "Paracetamol 500mg", dosage: "1 tablet", frequency: "Twice daily", duration: "5 days" },
          { name: "Vitamin D3", dosage: "1 capsule", frequency: "Once daily", duration: "30 days" },
        ],
        diagnosis: "Stable, responding well to treatment",
        notes: "Continue current plan, review at next visit.",
        followUpDays: 30,
      },
    });

    await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-DEMO-${String(i + 1).padStart(3, "0")}`,
        patientId: DEMO_PATIENT_ID,
        appointmentId: apt.id,
        createdById: creatorId,
        items: [
          { name: "Consultation Fee", quantity: 1, unitPrice: doctor.consultationFee || 150 },
          { name: "Lab Test Fee", quantity: 1, unitPrice: 25 },
        ],
        subtotal: (doctor.consultationFee || 150) + 25,
        tax: 5,
        total: (doctor.consultationFee || 150) + 30,
        status: i === 0 ? "unpaid" : "paid",
        paidAmount: i === 0 ? 0 : (doctor.consultationFee || 150) + 30,
        paidAt: i === 0 ? null : new Date(),
      },
    });
  }

  // A few lab reports at different stages.
  const labPlans = [
    { testName: "Complete Blood Count (CBC)", status: "completed" as const, results: "All values within normal range." },
    { testName: "Lipid Profile", status: "completed" as const, results: "LDL slightly elevated; dietary advice given." },
    { testName: "HbA1c", status: "pending" as const, results: null },
  ];
  for (const [i, lab] of labPlans.entries()) {
    await prisma.labReport.create({
      data: {
        patientId: DEMO_PATIENT_ID,
        doctorId: (i % 2 === 0 ? doctorA : doctorB).id,
        orderedById: (i % 2 === 0 ? doctorA : doctorB).userId,
        testName: lab.testName,
        testDate: iso(-(i * 5 + 3)),
        status: lab.status,
        results: lab.results || undefined,
        normalRange: "See lab reference ranges",
      },
    });
  }

  // A handful of notifications so the bell icon isn't empty either.
  const notifPlans = [
    { type: "success", title: "Appointment Confirmed", message: "Your appointment has been approved." },
    { type: "info", title: "Lab Results Ready", message: "Your Complete Blood Count results are ready to view." },
    { type: "warning", title: "Invoice Due", message: "You have an unpaid invoice. Please settle at your earliest convenience." },
  ];
  for (const n of notifPlans) {
    await prisma.notification.create({ data: { userId: demoUserId, ...n } });
  }
}
