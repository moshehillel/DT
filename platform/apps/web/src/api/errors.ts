import type { ErrorCode } from "@pos/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly requestId: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The request never got a usable answer (offline, DNS, proxy 502/503/504, aborted). */
export class NetworkError extends Error {
  constructor(message = "Can't reach the server. Check the connection.") {
    super(message);
    this.name = "NetworkError";
  }
}

const TRANSIENT_CODES = new Set<ErrorCode>(["UNAUTHENTICATED", "RATE_LIMITED", "IDEMPOTENCY_IN_PROGRESS", "INTERNAL"]);

/**
 * True when the server looked at the command and refused it: retrying the same
 * request will fail the same way, so a queued command must be shown to staff.
 */
export function isRejection(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && !TRANSIENT_CODES.has(error.code);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof NetworkError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
