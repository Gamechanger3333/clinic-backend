import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // BUG FIX 4: Passwords now meet backend policy (uppercase + number + special char)
  const adminPw = await bcrypt.hash("Admin@123", 12);
  const doctorPw = await bcrypt.hash("Doctor@123", 12);
  const receptPw = await bcrypt.hash("Recept@123", 12);

  const admin = await prisma.user.upsert({
    where: { email: "admin@clinicflow.com" },
    update: { password: adminPw },
    create: { email: "admin@clinicflow.com", password: adminPw, fullName: "Admin User", role: "admin", tokenVersion: 0 },
  });

  const doctorUser = await prisma.user.upsert({
    where: { email: "doctor@clinicflow.com" },
    update: { password: doctorPw },
    create: { email: "doctor@clinicflow.com", password: doctorPw, fullName: "Dr. Sarah Johnson", role: "doctor", phone: "+1-555-0101", tokenVersion: 0 },
  });

  const doctorUser2 = await prisma.user.upsert({
    where: { email: "doctor2@clinicflow.com" },
    update: { password: doctorPw },
    create: { email: "doctor2@clinicflow.com", password: doctorPw, fullName: "Dr. Ahmed Khan", role: "doctor", phone: "+1-555-0102", tokenVersion: 0 },
  });

  await prisma.user.upsert({
    where: { email: "receptionist@clinicflow.com" },
    update: { password: receptPw },
    create: { email: "receptionist@clinicflow.com", password: receptPw, fullName: "Jane Smith", role: "receptionist", tokenVersion: 0 },
  });

  // Departments
  const cardio = await prisma.department.upsert({
    where: { id: "dept-cardio" },
    update: {},
    create: { id: "dept-cardio", name: "Cardiology", description: "Heart and cardiovascular system" },
  });

  const neuro = await prisma.department.upsert({
    where: { id: "dept-neuro" },
    update: {},
    create: { id: "dept-neuro", name: "Neurology", description: "Brain and nervous system disorders" },
  });

  const general = await prisma.department.upsert({
    where: { id: "dept-general" },
    update: {},
    create: { id: "dept-general", name: "General Medicine", description: "Primary care and general health" },
  });

  // Doctors
  const doctor1 = await prisma.doctor.upsert({
    where: { userId: doctorUser.id },
    update: {},
    create: { userId: doctorUser.id, departmentId: cardio.id, specialization: "Cardiologist", licenseNumber: "LIC-001", experience: 10, consultationFee: 150, bio: "Experienced cardiologist." },
  });

  await prisma.doctor.upsert({
    where: { userId: doctorUser2.id },
    update: {},
    create: { userId: doctorUser2.id, departmentId: neuro.id, specialization: "Neurologist", licenseNumber: "LIC-002", experience: 8, consultationFee: 200, bio: "Expert neurologist." },
  });

  // Patients
  const patient1 = await prisma.patient.upsert({
    where: { id: "pat-001" },
    update: {},
    create: { id: "pat-001", fullName: "John Doe", email: "john@example.com", phone: "+1-555-1001", dateOfBirth: "1985-03-15", gender: "Male", address: "123 Main St, City", bloodGroup: "O+", createdBy: admin.id },
  });

  const patient2 = await prisma.patient.upsert({
    where: { id: "pat-002" },
    update: {},
    create: { id: "pat-002", fullName: "Maria Garcia", email: "maria@example.com", phone: "+1-555-1002", dateOfBirth: "1990-07-22", gender: "Female", address: "456 Oak Ave, Town", bloodGroup: "A+", createdBy: admin.id },
  });

  const patient3 = await prisma.patient.upsert({
    where: { id: "pat-003" },
    update: {},
    create: { id: "pat-003", fullName: "Ali Hassan", email: "ali@example.com", phone: "+1-555-1003", dateOfBirth: "1978-11-05", gender: "Male", bloodGroup: "B-", createdBy: admin.id },
  });

  // Appointments
  const today = new Date().toISOString().split("T")[0];
  const apt1 = await prisma.appointment.create({
    data: { patientId: patient1.id, doctorId: doctorUser.id, appointmentDate: today, appointmentTime: "09:00", status: "approved", reason: "Regular checkup", createdBy: admin.id },
  });

  await prisma.appointment.create({
    data: { patientId: patient2.id, doctorId: doctorUser.id, appointmentDate: today, appointmentTime: "10:30", status: "pending", reason: "Chest pain consultation", createdBy: admin.id },
  });

  await prisma.appointment.create({
    data: { patientId: patient3.id, doctorId: doctorUser2.id, appointmentDate: today, appointmentTime: "11:00", status: "completed", reason: "Headache evaluation", createdBy: admin.id },
  });

  // Medicines
  await prisma.medicine.createMany({
    skipDuplicates: true,
    data: [
      { name: "Amoxicillin", genericName: "Amoxicillin", category: "Antibiotic", unit: "capsules", stockQuantity: 200, reorderLevel: 50, unitPrice: 0.5, manufacturer: "PharmaCo" },
      { name: "Paracetamol 500mg", genericName: "Acetaminophen", category: "Analgesic", unit: "tablets", stockQuantity: 500, reorderLevel: 100, unitPrice: 0.1, manufacturer: "MediLab" },
      { name: "Ibuprofen 400mg", genericName: "Ibuprofen", category: "NSAID", unit: "tablets", stockQuantity: 8, reorderLevel: 50, unitPrice: 0.2, manufacturer: "GenPharm" },
      { name: "Metformin 500mg", genericName: "Metformin HCl", category: "Antidiabetic", unit: "tablets", stockQuantity: 150, reorderLevel: 40, unitPrice: 0.15, manufacturer: "DiabeCare" },
      { name: "Atorvastatin 20mg", genericName: "Atorvastatin", category: "Statin", unit: "tablets", stockQuantity: 5, reorderLevel: 30, unitPrice: 0.8, manufacturer: "HeartMed" },
    ],
  });

  // Invoice
  try {
    await prisma.invoice.create({
      data: {
        invoiceNumber: "INV-00001",
        patientId: patient1.id,
        appointmentId: apt1.id,
        createdById: admin.id,
        items: [{ description: "Consultation Fee", quantity: 1, unitPrice: 150 }, { description: "ECG Test", quantity: 1, unitPrice: 50 }],
        subtotal: 200,
        tax: 10,
        total: 210,
        status: "paid",
        paidAmount: 210,
        paidAt: new Date(),
      },
    });
  } catch {
    console.log("Invoice already exists, skipping...");
  }

  // Lab Report
  await prisma.labReport.create({
    data: {
      patientId: patient2.id,
      doctorId: doctor1.id,
      orderedById: doctorUser.id,
      testName: "CBC - Complete Blood Count",
      testDate: today,
      status: "pending",
      normalRange: "WBC: 4.5-11.0 k/uL",
    },
  });

  // Notification
  await prisma.notification.create({
    data: { userId: admin.id, type: "info", title: "Welcome to ClinicFlow!", message: "Your clinic management system is ready." },
  });

  console.log("✅ Seed complete!");
  console.log("\n📋 Login credentials (updated passwords):");
  console.log("  Admin:        admin@clinicflow.com        / Admin@123");
  console.log("  Doctor:       doctor@clinicflow.com       / Doctor@123");
  console.log("  Doctor 2:     doctor2@clinicflow.com      / Doctor@123");
  console.log("  Receptionist: receptionist@clinicflow.com / Recept@123");
}

main().catch(console.error).finally(() => prisma.$disconnect());
