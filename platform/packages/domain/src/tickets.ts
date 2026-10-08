/**
 * Repair ticket numbers. Customers key them into the phone IVR, so they stay
 * plain 6-digit numbers starting at 100001. The server issues them from a
 * per-tenant counter (never the browser), so two registers can no longer pick
 * the same number and nothing is ever renumbered. A register that may go
 * offline reserves a block in advance and spends it locally.
 */
export const TICKET_FIRST = 100_001;
export const TICKET_LAST = 999_999;

export function isValidTicketNumber(value: number): boolean {
  return Number.isInteger(value) && value >= TICKET_FIRST && value <= TICKET_LAST;
}

export function formatTicket(value: number): string {
  if (!isValidTicketNumber(value)) throw new Error(`ticket number out of range: ${value}`);
  return String(value);
}

/** Pull the ticket digits out of whatever a customer or IVR typed ("#100234", "100 234"). */
export function parseTicketInput(input: string): number | null {
  const digits = String(input).replace(/\D/g, "");
  if (digits.length !== 6) return null;
  const value = Number(digits);
  return isValidTicketNumber(value) ? value : null;
}

export interface TicketBlock {
  start: number;
  /** Inclusive. */
  end: number;
  /** Next number to hand out; end + 1 when exhausted. */
  next: number;
}

/** Plan a counter increment of `size`, given the counter's current next value. */
export function planBlock(counterNext: number, size: number): { block: TicketBlock; counterNext: number } {
  if (!Number.isInteger(size) || size <= 0) throw new Error("block size must be a positive integer");
  const start = Math.max(counterNext, TICKET_FIRST);
  const end = start + size - 1;
  if (end > TICKET_LAST) throw new Error("ticket number space exhausted — widen the ticket format");
  return { block: { start, end, next: start }, counterNext: end + 1 };
}

export function takeFromBlock(block: TicketBlock): { ticket: number; block: TicketBlock } | null {
  if (block.next > block.end) return null;
  return { ticket: block.next, block: { ...block, next: block.next + 1 } };
}

export function blockRemaining(block: TicketBlock): number {
  return Math.max(0, block.end - block.next + 1);
}

/**
 * Every number a legacy repair answered to: its current ticket plus any it was
 * renumbered away from. These become ticket aliases so an old label still
 * finds the right repair after migration.
 */
export function legacyTicketAliases(record: {
  ticketDigits?: unknown;
  ticketDigitsAll?: unknown;
  details?: { ticketDigits?: unknown; ticketNumber?: unknown; ticketNumberWas?: unknown; ticketDigitsAll?: unknown };
}): string[] {
  const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
  const list = (value: unknown) => (Array.isArray(value) ? value.map(digits) : []);
  return [
    ...new Set(
      [
        digits(record.ticketDigits),
        ...list(record.ticketDigitsAll),
        digits(record.details?.ticketDigits),
        digits(record.details?.ticketNumber),
        digits(record.details?.ticketNumberWas),
        ...list(record.details?.ticketDigitsAll),
      ].filter(Boolean),
    ),
  ];
}
