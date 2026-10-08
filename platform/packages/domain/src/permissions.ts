export const ROLES = ["owner", "manager", "cashier", "technician", "driver"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Every API command names one permission. Roles are tenant-wide or limited to
 * one store (membership.store_id); the store scope is checked separately.
 */
export const PERMISSIONS = [
  "sale.create",
  "sale.return",
  "sale.read",
  "payment.collect",
  "payment.verify",
  "payment.refund_over_limit",
  "work_order.create",
  "work_order.update",
  "work_order.read",
  "work_order.reopen",
  "stock.receive",
  "stock.transfer",
  "stock.count",
  "stock.adjust",
  "stock.read",
  "catalog.write",
  "customer.write",
  "customer.read",
  "customer.ledger_adjust",
  "rental.create",
  "rental.return",
  "rental.read",
  "phone_order.write",
  "phone_order.deliver",
  "shift.operate",
  "settings.write",
  "staff.manage",
  "audit.read",
  "report.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

const CASHIER: Permission[] = [
  "sale.create",
  "sale.return",
  "sale.read",
  "payment.collect",
  "payment.verify",
  "work_order.create",
  "work_order.update",
  "work_order.read",
  "stock.receive",
  "stock.read",
  "customer.write",
  "customer.read",
  "rental.create",
  "rental.return",
  "rental.read",
  "phone_order.write",
  "shift.operate",
];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: ALL,
  manager: new Set(PERMISSIONS.filter((p) => p !== "settings.write")),
  cashier: new Set(CASHIER),
  technician: new Set<Permission>([
    "work_order.create",
    "work_order.update",
    "work_order.read",
    "stock.read",
    "customer.read",
  ]),
  driver: new Set<Permission>(["phone_order.deliver", "customer.read"]),
};

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Refunds above this need a manager (payment.refund_over_limit) even when a cashier rings the return. */
export const CASHIER_REFUND_LIMIT_CENTS = 20_000;
