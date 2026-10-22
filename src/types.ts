/** Core domain types for Chase, the AI collections copilot. */

export interface Invoice {
  id: string;
  client_name: string;
  client_email: string;
  amount_due: string; // PayPal uses amount.value strings, keep the shape
  currency_code: string;
  issue_date?: string; // PayPal Invoicing: detail.issue_date
  due_date: string; // ISO date
  status: "DRAFT" | "SENT" | "PAID" | "PARTIALLY_PAID" | "CANCELLED" | "MARKED_AS_PAID";
  paid_amount?: string;
  paid_date?: string;
}

export interface AgingBucket {
  invoice: Invoice;
  days_overdue: number;
  bucket: "current" | "1-7" | "8-14" | "15-30" | "31-60" | "60+";
}

/** One step in the chase ladder. */
export type ChaseStage = "polite_reminder" | "firm_followup" | "final_notice";

export interface ChaseRecord {
  invoice_id: string;
  stage: ChaseStage;
  sent_at: string; // ISO datetime
  approved_by: string; // human approver - nothing sends without a name
  message_id?: string;
}

export interface ChaseDecision {
  chase_due: boolean;
  stage: ChaseStage;
  reason: string;
}

export interface EscalationConfig {
  /** minimum days between chases on the same invoice */
  min_gap_days: number;
  /** days overdue at which the ladder steps up from polite to firm, then firm to final */
  step_up_days: [number, number];
  /** never chase beyond this many days overdue; the debt is escalated to the human */
  handover_days: number;
}

export const DEFAULT_ESCALATION: EscalationConfig = {
  min_gap_days: 4,
  step_up_days: [7, 14],
  handover_days: 45,
};

export function amountToNumber(a: string): number {
  return Number(a);
}
