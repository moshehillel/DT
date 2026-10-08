import { AppError } from "./errors.js";

/** Keyset cursor over (created_at desc, id desc). Opaque to clients. */
export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(row: { created_at: Date | string; id: string }): string {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return Buffer.from(JSON.stringify([createdAt, row.id])).toString("base64url");
}

export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as [string, string];
    if (typeof createdAt !== "string" || typeof id !== "string") throw new Error("bad");
    return { createdAt, id };
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid cursor");
  }
}

export function pageLimit(value: unknown, fallback = 50): number {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, 200);
}

/** Fetch limit+1 rows, return a page and the next cursor. */
export function toPage<R extends { created_at: Date | string; id: string }, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return { items: slice.map(map), nextCursor: hasMore && last ? encodeCursor(last) : null };
}
