import type { TenderMethod } from "@pos/domain";
import type { PaymentStatus } from "@pos/contracts";

export const TENDER_LABELS: Record<TenderMethod, string> = {
  cash: "Cash",
  card: "Card",
  check: "Check",
  zelle: "Zelle",
  cash_app: "Cash App",
  apple_pay: "Apple Pay",
  other: "Other",
  account: "On account",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  requires_action: "Waiting for terminal",
  processing: "Processing…",
  pending_verification: "Card result unknown — Verify",
  captured: "Approved",
  declined: "Declined",
  failed: "Failed",
  voided: "Voided",
};
