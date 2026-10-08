import type { ErrorCode } from "@pos/contracts";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  IDEMPOTENCY_IN_PROGRESS: 409,
  VERSION_MISMATCH: 409,
  INSUFFICIENT_STOCK: 409,
  UNIT_NOT_AVAILABLE: 409,
  TENDER_INVALID: 422,
  REFUND_EXCEEDS_PAYMENT: 422,
  RETURN_EXCEEDS_SOLD: 422,
  PAYMENT_STATE_INVALID: 409,
  INVALID_TRANSITION: 409,
  RATE_LIMITED: 429,
  WEBHOOK_SIGNATURE_INVALID: 401,
  INTERNAL: 500,
};

/** The only error type whose message reaches the client. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`);
export const forbidden = (message = "You do not have permission to do that") => new AppError("FORBIDDEN", message);

export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  const requestId = String(request.id);
  if (error instanceof AppError) {
    if (error.status >= 500) request.log.error({ err: error }, "app error");
    return reply.status(error.status).send({
      error: { code: error.code, message: error.message, requestId, ...(error.details ? { details: error.details } : {}) },
    });
  }
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        requestId,
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  const pgCode = (error as { code?: unknown }).code;
  if (pgCode === "22P02") {
    return reply.status(400).send({ error: { code: "VALIDATION_FAILED", message: "An id in the request is not valid", requestId } });
  }
  if (pgCode === "40001" || pgCode === "40P01") {
    request.log.warn({ err: error }, "transaction conflict");
    return reply.status(409).send({ error: { code: "CONFLICT", message: "Another register changed this at the same moment. Try again.", requestId } });
  }
  const fastifyError = error as FastifyError;
  if (fastifyError.statusCode && fastifyError.statusCode < 500) {
    return reply.status(fastifyError.statusCode).send({
      error: { code: fastifyError.statusCode === 429 ? "RATE_LIMITED" : "VALIDATION_FAILED", message: "Bad request", requestId },
    });
  }
  // Unknown errors are logged with full detail and returned generically: no
  // SQL, stack traces or provider messages ever reach the browser.
  request.log.error({ err: error }, "unhandled error");
  return reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong", requestId } });
}
