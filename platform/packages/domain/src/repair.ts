import { parseMoney, type Cents } from "./money.js";

export const WORK_ORDER_STATUSES = [
  "received",
  "diagnosing",
  "waiting_for_parts",
  "in_repair",
  "ready",
  "picked_up",
  "cancelled",
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  received: "Received",
  diagnosing: "Diagnosing",
  waiting_for_parts: "Waiting for parts",
  in_repair: "In repair",
  ready: "Ready",
  picked_up: "Picked up",
  cancelled: "Cancelled",
};

const OPEN: readonly WorkOrderStatus[] = ["received", "diagnosing", "waiting_for_parts", "in_repair", "ready"];

export function isOpenStatus(status: WorkOrderStatus): boolean {
  return OPEN.includes(status);
}

/** Open repairs can move freely between open states; closing is one-way except a manager reopen. */
export function canTransition(from: WorkOrderStatus, to: WorkOrderStatus, opts: { allowReopen?: boolean } = {}): boolean {
  if (from === to) return false;
  if (isOpenStatus(from)) return true;
  return Boolean(opts.allowReopen) && isOpenStatus(to);
}

/** Map the old app's free-text statuses ("Completed" was an alias of picked up). */
export function legacyStatusToWorkOrderStatus(value: string): WorkOrderStatus {
  const text = value.trim().toLowerCase();
  if (text === "completed" || text === "picked up") return "picked_up";
  const found = (Object.entries(WORK_ORDER_STATUS_LABELS) as [WorkOrderStatus, string][]).find(
    ([, label]) => label.toLowerCase() === text,
  );
  return found ? found[0] : "received";
}

export interface RepairFix {
  description: string;
  priceCents: Cents;
}

/** `base` is the final price once set, else the estimate; extras are owed on top at pickup. */
export function repairTotals(input: { finalPriceCents?: Cents | null; estimateCents?: Cents | null; fixes: RepairFix[] }) {
  const base = input.finalPriceCents ?? input.estimateCents ?? 0;
  const fixesTotal = input.fixes.reduce((sum, fix) => sum + fix.priceCents, 0);
  return { baseCents: base, fixesCents: fixesTotal, totalCents: base + fixesTotal };
}

/**
 * The "ready" text goes out immediately unless staff scheduled it for later
 * (e.g. marked ready after hours, text at opening). A time within 15 seconds is
 * treated as now, as the old trigger did.
 */
export function readyNotificationPlan(now: Date, notifyAt: Date | null): { sendAt: Date; scheduled: boolean } {
  if (notifyAt && notifyAt.getTime() > now.getTime() + 15_000) return { sendAt: notifyAt, scheduled: true };
  return { sendAt: now, scheduled: false };
}

/** Sensitive intake fields (device passcode, account PIN) are wiped once the device leaves. */
export function shouldClearSecrets(status: WorkOrderStatus): boolean {
  return status === "picked_up" || status === "cancelled";
}

export type RepairPrice =
  | { kind: "fixed"; cents: Cents }
  | { kind: "range"; lowCents: Cents; highCents: Cents }
  | { kind: "na" }
  | { kind: "none" };

/** Price-sheet cells: "$350.00", "80/90" (range), "NA" (not offered). */
export function parseRepairPrice(raw: string | null | undefined): RepairPrice {
  const value = String(raw ?? "").trim();
  if (!value) return { kind: "none" };
  if (value.toUpperCase() === "NA") return { kind: "na" };
  if (value.includes("/")) {
    const [low, high] = value.split("/");
    const lowCents = parseMoney(low ?? "");
    const highCents = parseMoney(high ?? "");
    if (lowCents === null || highCents === null) return { kind: "none" };
    return { kind: "range", lowCents, highCents };
  }
  const cents = parseMoney(value);
  return cents === null ? { kind: "none" } : { kind: "fixed", cents };
}
