import { formatMoney, type Cents } from "./money.js";
import { WORK_ORDER_STATUS_LABELS, type WorkOrderStatus } from "./repair.js";
import { ppmToPercentString } from "./tax.js";
import { formatReceiptPhone, staffInitials } from "./text.js";

/**
 * Receipts are built as plain data (pages of blocks) so the layout rules —
 * what goes on which copy, what must never be printed for the customer — are
 * unit-tested here, and the web app only turns blocks into thermal HTML.
 */
export type ReceiptBlock =
  | { type: "header"; company: string; storeName: string; address: string; phone: string; web: string }
  | { type: "eyebrow"; text: string }
  | { type: "big"; text: string }
  | { type: "meta"; text: string }
  | { type: "divider" }
  | { type: "rows"; rows: [string, string][] }
  | { type: "total"; label: string; value: string }
  | { type: "text"; text: string; emphasis?: boolean }
  | { type: "barcode"; value: string };

export interface ReceiptPage {
  name: "customer_copy" | "device_label" | "sale" | "return";
  blocks: ReceiptBlock[];
}

export interface ReceiptDoc {
  title: string;
  pages: ReceiptPage[];
}

export interface ReceiptBranding {
  companyName: string;
  phone: string;
  web: string;
  storeName: string;
  storeAddress: string;
  storePhone: string;
  storeHours: string;
  currency: string;
  /** Tenant-configurable standing instructions per receipt type. */
  notes: Partial<Record<"sale" | "repair" | "rental" | "phoneOrder", string>>;
}

function header(b: ReceiptBranding): ReceiptBlock {
  return {
    type: "header",
    company: b.companyName,
    storeName: b.storeName,
    address: b.storeAddress,
    phone: b.storePhone || b.phone,
    web: b.web,
  };
}

function footer(b: ReceiptBranding, kind: keyof ReceiptBranding["notes"]): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [];
  const note = b.notes[kind];
  if (note) blocks.push({ type: "divider" }, { type: "text", text: note });
  if (b.storeHours) blocks.push({ type: "meta", text: b.storeHours });
  return blocks;
}

export interface RepairReceiptInput {
  ticket: string;
  createdAt: Date;
  timeZone: string;
  customerName?: string | null;
  customerPhone?: string | null;
  model?: string | null;
  imei?: string | null;
  issue?: string | null;
  fixes: { description: string; priceCents: Cents }[];
  estimateCents?: Cents | null;
  finalPriceCents?: Cents | null;
  amountDueCents: Cents;
  paid: boolean;
  expectedReady?: string | null;
  servedByName?: string | null;
  notes?: string | null;
  hadSim?: boolean;
  hadSdCard?: boolean;
  loanerGiven?: boolean;
  status: WorkOrderStatus;
  /** Decrypted only for printing; appears on the device label page and nowhere else. */
  devicePasscode?: string | null;
}

/** Intake prints one job, two pages: the customer's ticket and the sticker for the phone. */
export function buildRepairIntakeReceipt(input: RepairReceiptInput, b: ReceiptBranding): ReceiptDoc {
  const money = (cents: Cents) => formatMoney(cents, b.currency);
  const who = [input.customerName, input.customerPhone ? formatReceiptPhone(input.customerPhone) : null]
    .filter(Boolean)
    .join(" · ");
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(input.createdAt);
  const dueLabel = input.paid ? "Paid" : "Amount due";

  const rows: [string, string][] = (
    [
      ["Phone", input.customerPhone ? formatReceiptPhone(input.customerPhone) : ""],
      ["Model", input.model ?? ""],
      ["IMEI", input.imei ?? ""],
      ["Issue", input.issue ?? ""],
      ...input.fixes.map(
        (fix): [string, string] => ["Also fixing", `${fix.description}${fix.priceCents ? ` - ${money(fix.priceCents)}` : ""}`],
      ),
      ["Estimated price", input.estimateCents ? money(input.estimateCents) : ""],
      ["Final price", input.finalPriceCents ? money(input.finalPriceCents) : ""],
      ["SIM in phone", input.hadSim ? "Yes" : ""],
      ["SD card in phone", input.hadSdCard ? "Yes" : ""],
      ["Loaner phone given", input.loanerGiven ? "Yes" : ""],
      ["Status", WORK_ORDER_STATUS_LABELS[input.status]],
      ["Expected ready", input.expectedReady ?? ""],
      ["Served by", staffInitials(input.servedByName)],
    ] as [string, string][]
  ).filter(([, value]) => value);

  const customerCopy: ReceiptPage = {
    name: "customer_copy",
    blocks: [
      header(b),
      { type: "divider" },
      { type: "eyebrow", text: "Customer copy" },
      { type: "big", text: input.ticket },
      { type: "meta", text: created },
      ...(who ? [{ type: "text", text: who } as ReceiptBlock] : []),
      { type: "divider" },
      { type: "rows", rows },
      { type: "total", label: dueLabel, value: money(input.amountDueCents) },
      ...(input.notes ? [{ type: "text", text: input.notes } as ReceiptBlock] : []),
      { type: "divider" },
      { type: "text", text: "Keep this ticket for pickup.", emphasis: true },
      ...footer(b, "repair"),
    ],
  };

  const labelRows: [string, string][] = (
    [
      ["Model", input.model ?? ""],
      ["IMEI", input.imei ?? ""],
    ] as [string, string][]
  ).filter(([, value]) => value);

  const deviceLabel: ReceiptPage = {
    name: "device_label",
    blocks: [
      { type: "eyebrow", text: "Stick on phone" },
      { type: "big", text: input.ticket },
      ...(who ? [{ type: "text", text: who, emphasis: true } as ReceiptBlock] : []),
      { type: "divider" },
      ...(labelRows.length ? [{ type: "rows", rows: labelRows } as ReceiptBlock] : []),
      ...(input.issue ? [{ type: "text", text: `Issue: ${input.issue}`, emphasis: true } as ReceiptBlock] : []),
      ...input.fixes.map((fix) => ({ type: "text", text: `Also: ${fix.description}`, emphasis: true }) as ReceiptBlock),
      { type: "total", label: dueLabel, value: money(input.amountDueCents) },
      ...(input.devicePasscode ? [{ type: "big", text: `PIN: ${input.devicePasscode}` } as ReceiptBlock] : []),
      ...(input.notes ? [{ type: "text", text: input.notes } as ReceiptBlock] : []),
    ],
  };

  return { title: `Repair ${input.ticket}`, pages: [customerCopy, deviceLabel] };
}

export interface SaleReceiptInput {
  receiptCode: string;
  createdAt: Date;
  timeZone: string;
  kind: "sale" | "return";
  lines: { name: string; qty: number; netCents: Cents; imei?: string | null }[];
  subtotalCents: Cents;
  taxCents: Cents;
  taxRatePpm: number;
  totalCents: Cents;
  tenders: { label: string; amountCents: Cents }[];
  balanceDueCents: Cents;
  balanceDueDate?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  servedByName?: string | null;
}

export function buildSaleReceipt(input: SaleReceiptInput, b: ReceiptBranding): ReceiptDoc {
  const money = (cents: Cents) => formatMoney(cents, b.currency);
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(input.createdAt);
  const lineRows: [string, string][] = input.lines.map((line) => [
    `${line.qty} x ${line.name}${line.imei ? ` (IMEI ${line.imei})` : ""}`,
    money(line.netCents),
  ]);
  const taxLabel = input.taxRatePpm ? `Tax (${ppmToPercentString(input.taxRatePpm)}%)` : "Tax";
  const blocks: ReceiptBlock[] = [
    header(b),
    { type: "divider" },
    { type: "eyebrow", text: input.kind === "return" ? "Return / refund" : "Sales receipt" },
    { type: "meta", text: created },
    ...(input.customerName || input.customerPhone
      ? [
          {
            type: "text",
            text: [input.customerName, input.customerPhone ? formatReceiptPhone(input.customerPhone) : null]
              .filter(Boolean)
              .join(" · "),
          } as ReceiptBlock,
        ]
      : []),
    { type: "divider" },
    { type: "rows", rows: lineRows },
    { type: "divider" },
    {
      type: "rows",
      rows: [
        ["Subtotal", money(input.subtotalCents)],
        [taxLabel, money(input.taxCents)],
      ],
    },
    { type: "total", label: input.kind === "return" ? "Refund total" : "Total", value: money(input.totalCents) },
    ...(input.tenders.length
      ? [{ type: "rows", rows: input.tenders.map((t): [string, string] => [t.label, money(t.amountCents)]) } as ReceiptBlock]
      : []),
    ...(input.balanceDueCents > 0
      ? [
          {
            type: "total",
            label: input.balanceDueDate ? `Balance due ${input.balanceDueDate}` : "Balance due",
            value: money(input.balanceDueCents),
          } as ReceiptBlock,
        ]
      : []),
    ...(input.servedByName ? [{ type: "meta", text: `Served by ${staffInitials(input.servedByName)}` } as ReceiptBlock] : []),
    { type: "barcode", value: input.receiptCode },
    { type: "text", text: `Thank you for shopping at ${b.companyName}.`, emphasis: true },
    ...footer(b, "sale"),
  ];
  return { title: `Receipt ${input.receiptCode}`, pages: [{ name: input.kind, blocks }] };
}
