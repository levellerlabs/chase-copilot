import type { Invoice, ChaseRecord, ChaseDecision, ChaseStage, EscalationConfig } from "./types.js";
import { DEFAULT_ESCALATION } from "./types.js";
import { daysOverdue } from "./aging.js";

/**
 * The escalation ladder. Rules:
 * - chase at most once per min_gap_days
 * - stage steps polite -> firm -> final as overdue crosses step_up_days
 * - past handover_days: never auto-chase again, a human must take the debt over
 * - nothing sends without human approval (ChaseRecord.approved_by is mandatory)
 */
export function nextChase(
  invoice: Invoice,
  history: ChaseRecord[],
  today: Date,
  config: EscalationConfig = DEFAULT_ESCALATION,
): ChaseDecision {
  const days = daysOverdue(invoice, today);

  if (days <= 0) {
    return { chase_due: false, stage: "polite_reminder", reason: "not yet due" };
  }
  if (days > config.handover_days) {
    return {
      chase_due: false,
      stage: "final_notice",
      reason: `overdue ${days}d exceeds handover limit ${config.handover_days}d - human takes over`,
    };
  }

  const last = history
    .filter((h) => h.invoice_id === invoice.id)
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at))[0];

  if (last) {
    const sinceDays =
      (Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) -
        Date.parse(last.sent_at)) /
      86400000;
    if (sinceDays < config.min_gap_days) {
      return {
        chase_due: false,
        stage: last.stage,
        reason: `last chase ${Math.floor(sinceDays)}d ago, minimum gap is ${config.min_gap_days}d`,
      };
    }
  }

  const chaseCount = history.filter((h) => h.invoice_id === invoice.id).length;
  let stage: ChaseStage;
  if (days >= config.step_up_days[1] || chaseCount >= 2) {
    stage = "final_notice";
  } else if (days >= config.step_up_days[0] || chaseCount >= 1) {
    stage = "firm_followup";
  } else {
    stage = "polite_reminder";
  }

  const reason = last
    ? `due for stage ${stage} after ${config.min_gap_days}d gap`
    : `first chase, invoice is ${days}d overdue`;
  return { chase_due: true, stage, reason };
}
