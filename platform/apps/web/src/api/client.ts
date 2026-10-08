import { ERROR_CODES, type ErrorCode } from "@pos/contracts";
import { getIdToken, handleUnauthenticated, session } from "../auth/session";
import { API_BASE } from "../env";
import { newId } from "../lib/ids";
import { createStore } from "../lib/store";
import { ApiError, NetworkError } from "./errors";

export { ApiError, NetworkError } from "./errors";

export type Query = Record<string, string | number | null | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** POST only. Generated when absent; pass one to make retries replay-safe. */
  idempotencyKey?: string;
  /** Header context captured when a command was queued (replayed later under the same register). */
  context?: { tenantId?: string | null; registerId?: string | null };
  /** For calls where a 401 means "wrong PIN", not "signed out". */
  skipAuthRedirect?: boolean;
  signal?: AbortSignal;
}

export interface ApiResult<T> {
  data: T;
  status: number;
  replayed: boolean;
}

/** Last observed reachability of the API, for the status indicator. */
export const serverReachable = createStore(true);

const KNOWN_CODES = new Set<string>(ERROR_CODES);

function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
}

export async function request<T>(method: "GET" | "POST", path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const state = session.get();
  const token = await getIdToken();
  if (!token) {
    if (!opts.skipAuthRedirect) handleUnauthenticated("Sign in required", false);
    throw new ApiError(401, "UNAUTHENTICATED", "Sign in required", "");
  }
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  const tenantId = opts.context?.tenantId ?? state.tenantId;
  const registerId = opts.context?.registerId ?? state.registerId;
  if (tenantId) headers["X-Tenant-Id"] = tenantId;
  if (registerId) headers["X-Register-Id"] = registerId;
  const operatorToken = state.operator?.token;
  if (operatorToken) headers["X-Operator-Token"] = operatorToken;
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = opts.idempotencyKey ?? newId();
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: opts.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    serverReachable.set(false);
    throw new NetworkError();
  }

  const text = await response.text().catch(() => "");
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const err = (json as { error?: { code?: string; message?: string; requestId?: string; details?: unknown } } | null)?.error;
    if (!err?.code) {
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        serverReachable.set(false);
        throw new NetworkError();
      }
      serverReachable.set(true);
      throw new ApiError(response.status, "INTERNAL", `Unexpected server response (${response.status})`, response.headers.get("x-request-id") ?? "");
    }
    serverReachable.set(true);
    const code = (KNOWN_CODES.has(err.code) ? err.code : "INTERNAL") as ErrorCode;
    const apiError = new ApiError(response.status, code, err.message ?? "Request failed", err.requestId ?? "", err.details);
    if (response.status === 401 && !opts.skipAuthRedirect) handleUnauthenticated(apiError.message, Boolean(operatorToken));
    throw apiError;
  }

  serverReachable.set(true);
  return { data: json as T, status: response.status, replayed: response.headers.get("idempotent-replayed") === "true" };
}

export async function get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
  return (await request<T>("GET", path, { ...(query ? { query } : {}), ...(signal ? { signal } : {}) })).data;
}

export async function post<T>(path: string, body: unknown, idempotencyKey?: string, opts: Omit<RequestOptions, "body" | "idempotencyKey"> = {}): Promise<T> {
  return (await request<T>("POST", path, { ...opts, body, ...(idempotencyKey ? { idempotencyKey } : {}) })).data;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
