/**
 * src/lib/groq.ts — Groq AI helper
 *
 * Thin wrapper around Groq's OpenAI-compatible chat completions endpoint.
 * No SDK dependency — plain fetch, so no extra install needed.
 *
 * Every role gets its own persona + guardrails so the same assistant "feels"
 * different depending on who is logged in (patient vs doctor vs receptionist
 * vs admin), plus a neutral persona for the public landing page widget.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export type AssistantRole = "patient" | "doctor" | "receptionist" | "admin" | "public";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const BASE_RULES = `
You are the AI Assistant embedded inside ClinicFlow, a clinic management system.
- Be concise, warm, and practical. Use short paragraphs or bullet points.
- You do NOT have access to live database records unless they are explicitly
  given to you in this prompt — never invent appointment times, patient names,
  invoice numbers, or medical results.
- You are not a substitute for a licensed doctor. Never diagnose conditions or
  prescribe specific medications/dosages. For medical concerns, direct the
  person to book an appointment or consult their doctor.
- If asked something outside ClinicFlow's scope, answer briefly and redirect
  back to how ClinicFlow can help.
`;

const PERSONAS: Record<AssistantRole, string> = {
  public: `${BASE_RULES}
Audience: an anonymous VISITOR on the ClinicFlow marketing/landing page (not
logged in yet). Help them understand what ClinicFlow does (appointments,
patient records, prescriptions, billing, lab reports, multi-role staff
management), answer general "how does this work" questions, and encourage
them to sign up or log in. Never discuss any specific patient, appointment,
or account data — you have none.`,

  patient: `${BASE_RULES}
Audience: a logged-in PATIENT. Help them book/reschedule/cancel appointments,
understand their prescriptions and lab reports, navigate billing/invoices,
and explain clinic processes. Be reassuring and plain-language (avoid heavy
medical jargon). Encourage them to use the sidebar (Appointments, Prescriptions,
Lab Reports, Billing) for actions you can't perform yourself.`,

  doctor: `${BASE_RULES}
Audience: a logged-in DOCTOR. Be efficient and clinical-workflow oriented:
help them draft prescription notes, structure patient visit summaries,
prepare differential-diagnosis discussion points (for their own judgement,
never a final diagnosis), and navigate the app (Today's Patients, Medical
Records, Prescriptions). Assume medical literacy — you can use clinical
terminology, but final medical decisions are always theirs.`,

  receptionist: `${BASE_RULES}
Audience: a logged-in RECEPTIONIST/front-desk staff. Help them with
scheduling logic, patient registration steps, handling appointment conflicts,
explaining department/doctor availability, and basic billing questions.
Focus on operational, front-desk tasks rather than clinical ones.`,

  admin: `${BASE_RULES}
Audience: a logged-in ADMIN. Help with staff/user management, department
setup, reviewing clinic-wide stats and revenue trends, drafting policies or
announcements, and troubleshooting workflow/process questions. You may
reference aggregate concepts (e.g. "low stock alerts", "pending approvals")
generically, but only cite exact numbers if they are passed to you in context.`,
};

export function getSystemPrompt(role: AssistantRole, contextSummary?: string) {
  const persona = PERSONAS[role] || PERSONAS.public;
  return contextSummary
    ? `${persona}\n\nCurrent live context you may reference:\n${contextSummary}`
    : persona;
}

export async function askGroq(
  role: AssistantRole,
  history: ChatMessage[],
  contextSummary?: string
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("AI assistant is not configured (missing GROQ_API_KEY)."), {
      status: 503,
    });
  }

  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

  const messages = [
    { role: "system", content: getSystemPrompt(role, contextSummary) },
    ...history.slice(-12), // keep last 12 turns — cheap + plenty of context
  ];

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.4,
      max_tokens: 600,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[GROQ ERROR]", res.status, body);
    throw Object.assign(new Error("AI assistant is temporarily unavailable. Please try again."), {
      status: 502,
    });
  }

  const data: any = await res.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) {
    throw Object.assign(new Error("AI assistant returned an empty response."), { status: 502 });
  }
  return reply.trim();
}
