import type { Invoice, ChaseStage } from "./types.js";

export interface ChaseDraft {
  invoice_id: string;
  stage: ChaseStage;
  subject: string;
  body: string;
  /** how the message was produced; LLM drafts carry their model, templates say "template" */
  generator: string;
}

export interface DraftContext {
  freelancer_name: string;
  payment_url?: string;
  /** optional LLM rewriter: receives the template draft, returns the personalised one */
  rewriter?: (draft: ChaseDraft, invoice: Invoice) => Promise<ChaseDraft>;
}

const SUBJECTS: Record<ChaseStage, (inv: Invoice) => string> = {
  polite_reminder: (i) => `Friendly reminder: invoice ${i.id} is due`,
  firm_followup: (i) => `Second reminder: invoice ${i.id} is now overdue`,
  final_notice: (i) => `Final notice: invoice ${i.id} overdue - action needed`,
};

/** Plain, warm, escalating chase copy. No em dashes (house style). */
const BODIES: Record<ChaseStage, (c: DraftContext, i: Invoice) => string> = {
  polite_reminder: (c, i) =>
    `Hi there,\n\n` +
    `Just a quick note that invoice ${i.id} for ${i.currency_code} ${i.amount_due} was due on ${i.due_date}. ` +
    `If it has already been arranged, thank you and please ignore this note.\n\n` +
    paymentLine(c) +
    `Thank you,\n${c.freelancer_name}`,
  firm_followup: (c, i) =>
    `Hi there,\n\n` +
    `Invoice ${i.id} for ${i.currency_code} ${i.amount_due} is now overdue (due ${i.due_date}). ` +
    `I would appreciate it if you could settle it this week, or reply with a date that works and I will hold it open.\n\n` +
    paymentLine(c) +
    `Many thanks,\n${c.freelancer_name}`,
  final_notice: (c, i) =>
    `Hi there,\n\n` +
    `Despite previous reminders, invoice ${i.id} for ${i.currency_code} ${i.amount_due} (due ${i.due_date}) remains unpaid. ` +
    `This is a final request for payment within 7 days. After that I will pass the account to formal recovery, ` +
    `which I would rather avoid.\n\n` +
    paymentLine(c) +
    `Regards,\n${c.freelancer_name}`,
};

function paymentLine(c: DraftContext): string {
  return c.payment_url ? `Pay securely in one tap: ${c.payment_url}\n\n` : "";
}

/**
 * Produce the chase draft for a stage. If an LLM rewriter is configured it
 * personalises the template draft; the template itself is always the fallback
 * so the product never sends nothing.
 */
export async function draftChase(
  invoice: Invoice,
  stage: ChaseStage,
  context: DraftContext,
): Promise<ChaseDraft> {
  const base: ChaseDraft = {
    invoice_id: invoice.id,
    stage,
    subject: SUBJECTS[stage](invoice),
    body: BODIES[stage](context, invoice),
    generator: "template",
  };
  if (context.rewriter) {
    try {
      const personalised = await context.rewriter(base, invoice);
      return { ...personalised, invoice_id: invoice.id, stage };
    } catch {
      return base; // never block a send on rewriter failure
    }
  }
  return base;
}
