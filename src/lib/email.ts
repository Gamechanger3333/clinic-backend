/**
 * src/lib/email.ts — Email Service
 *
 * Sends transactional emails: OTP codes, email verification, password reset.
 * Uses Nodemailer with SMTP (configurable for SendGrid, SES, Resend, etc.)
 *
 * In development: logs to console if SMTP is not configured.
 * In production:  requires SMTP_HOST / SMTP_USER / SMTP_PASS env vars.
 */

import nodemailer from "nodemailer";

// ─── Transporter ─────────────────────────────────────────────────────────────
function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    // Dev mode: log emails to console instead of sending
    console.warn("[EMAIL] SMTP not configured — emails will be logged to console only.");
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: process.env.NODE_ENV === "production" },
  });
}

const transporter = createTransporter();
const FROM_NAME   = process.env.EMAIL_FROM_NAME || "ClinicFlow";
const FROM_EMAIL  = process.env.EMAIL_FROM      || "noreply@clinicflow.com";
const APP_URL     = process.env.FRONTEND_URL    || "http://localhost:3000";

// ─── Core send function ───────────────────────────────────────────────────────
async function sendEmail(opts: {
  to:      string;
  subject: string;
  html:    string;
  text:    string;
}): Promise<void> {
  if (!transporter) {
    // Dev fallback — print to console
    console.log("\n═══════════════════ [EMAIL] ═══════════════════");
    console.log(`TO:      ${opts.to}`);
    console.log(`SUBJECT: ${opts.subject}`);
    console.log(`TEXT:    ${opts.text}`);
    console.log("═══════════════════════════════════════════════\n");
    return;
  }

  await transporter.sendMail({
    from:    `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to:      opts.to,
    subject: opts.subject,
    html:    opts.html,
    text:    opts.text,
  });
}

// ─── Email Templates ─────────────────────────────────────────────────────────
function baseTemplate(title: string, body: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <tr><td style="background:#2563eb;padding:32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;">🏥 ClinicFlow</h1>
        </td></tr>
        <tr><td style="padding:40px 32px;">${body}</td></tr>
        <tr><td style="padding:24px 32px;background:#f4f6f9;text-align:center;font-size:12px;color:#6b7280;">
          © ${new Date().getFullYear()} ClinicFlow. This is an automated message — please do not reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Email Verification ───────────────────────────────────────────────────────
export async function sendEmailVerification(
  to:       string,
  fullName: string,
  token:    string
): Promise<void> {
  const link = `${APP_URL}/auth/verify-email?token=${token}`;

  const html = baseTemplate("Verify Your Email", `
    <h2 style="color:#111;margin-top:0;">Verify your email address</h2>
    <p style="color:#374151;">Hi <strong>${fullName}</strong>,</p>
    <p style="color:#374151;">Welcome to ClinicFlow! Please click the button below to verify your email address and activate your account.</p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-weight:600;font-size:16px;">
        Verify Email Address
      </a>
    </div>
    <p style="color:#6b7280;font-size:14px;">Or copy this link:<br><code style="background:#f3f4f6;padding:4px 8px;border-radius:4px;word-break:break-all;">${link}</code></p>
    <p style="color:#6b7280;font-size:14px;">This link expires in <strong>24 hours</strong>. If you didn't create an account, you can safely ignore this email.</p>
  `);

  await sendEmail({
    to,
    subject: "Verify your ClinicFlow account",
    html,
    text:    `Hi ${fullName},\n\nVerify your email: ${link}\n\nExpires in 24 hours.`,
  });
}

// ─── OTP Email ────────────────────────────────────────────────────────────────
export async function sendOtpEmail(
  to:       string,
  fullName: string,
  otp:      string,
  purpose:  "login" | "password_reset" | "mfa_setup"
): Promise<void> {
  const purposeLabels: Record<string, string> = {
    login:          "sign in",
    password_reset: "reset your password",
    mfa_setup:      "set up two-factor authentication",
  };
  const label = purposeLabels[purpose] || "verify your identity";

  const html = baseTemplate("Your One-Time Code", `
    <h2 style="color:#111;margin-top:0;">Your one-time code</h2>
    <p style="color:#374151;">Hi <strong>${fullName}</strong>,</p>
    <p style="color:#374151;">Use the code below to ${label}:</p>
    <div style="text-align:center;margin:32px 0;">
      <div style="display:inline-block;background:#f3f4f6;border:2px dashed #d1d5db;border-radius:8px;padding:20px 40px;">
        <span style="font-size:40px;font-weight:700;letter-spacing:8px;color:#111;">${otp}</span>
      </div>
    </div>
    <p style="color:#6b7280;font-size:14px;text-align:center;">This code expires in <strong>10 minutes</strong>.</p>
    <p style="color:#ef4444;font-size:14px;text-align:center;">⚠️ Never share this code with anyone — ClinicFlow staff will never ask for it.</p>
    <p style="color:#6b7280;font-size:14px;">If you didn't request this, please ignore this email and consider changing your password.</p>
  `);

  await sendEmail({
    to,
    subject: `Your ClinicFlow verification code: ${otp}`,
    html,
    text:    `Hi ${fullName},\n\nYour code: ${otp}\n\nExpires in 10 minutes. Do not share this code.`,
  });
}

// ─── Password Reset ───────────────────────────────────────────────────────────
export async function sendPasswordReset(
  to:       string,
  fullName: string,
  token:    string
): Promise<void> {
  const link = `${APP_URL}/auth/reset-password?token=${token}`;

  const html = baseTemplate("Reset Your Password", `
    <h2 style="color:#111;margin-top:0;">Reset your password</h2>
    <p style="color:#374151;">Hi <strong>${fullName}</strong>,</p>
    <p style="color:#374151;">We received a request to reset your ClinicFlow password. Click the button below to choose a new password.</p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${link}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-weight:600;font-size:16px;">
        Reset Password
      </a>
    </div>
    <p style="color:#6b7280;font-size:14px;">Or copy this link:<br><code style="background:#f3f4f6;padding:4px 8px;border-radius:4px;word-break:break-all;">${link}</code></p>
    <p style="color:#6b7280;font-size:14px;">This link expires in <strong>1 hour</strong> and can only be used once.</p>
    <p style="color:#ef4444;font-size:14px;">If you didn't request a password reset, please ignore this email and your password will remain unchanged. Consider enabling two-factor authentication for added security.</p>
  `);

  await sendEmail({
    to,
    subject: "Reset your ClinicFlow password",
    html,
    text:    `Hi ${fullName},\n\nReset your password: ${link}\n\nExpires in 1 hour.`,
  });
}

// ─── Security Alert ────────────────────────────────────────────────────────────
export async function sendSecurityAlert(
  to:       string,
  fullName: string,
  event:    string,
  details:  string
): Promise<void> {
  const html = baseTemplate("Security Alert", `
    <h2 style="color:#dc2626;margin-top:0;">⚠️ Security Alert</h2>
    <p style="color:#374151;">Hi <strong>${fullName}</strong>,</p>
    <p style="color:#374151;">We detected the following activity on your account:</p>
    <div style="background:#fef2f2;border-left:4px solid #dc2626;padding:16px;border-radius:4px;margin:16px 0;">
      <strong style="color:#dc2626;">${event}</strong>
      <p style="color:#374151;margin:8px 0 0;">${details}</p>
    </div>
    <p style="color:#374151;">If this was you, no action is needed. If you didn't do this, please <a href="${APP_URL}/auth" style="color:#2563eb;">sign in immediately</a> and change your password.</p>
  `);

  await sendEmail({
    to,
    subject: `ClinicFlow Security Alert: ${event}`,
    html,
    text:    `Hi ${fullName},\n\nSecurity alert: ${event}\n${details}\n\nIf this wasn't you, sign in and change your password immediately.`,
  });
}