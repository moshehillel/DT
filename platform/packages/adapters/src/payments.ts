/**
 * Card-present payments. The server owns every terminal call; the browser
 * only asks the API to confirm an intent. Outcomes are tri-state on purpose:
 * "unknown" (timeout, network error, terminal still busy) must never be
 * treated as declined and retried — the caller marks the payment
 * pending_verification and queries by externalRequestId.
 */
export type ChargeOutcome =
  | { status: "approved"; gatewayRef: string; cardSummary: string | null; authCode: string | null }
  | { status: "declined"; message: string }
  | { status: "unknown"; message: string };

export type RefundOutcome =
  | { status: "approved"; gatewayRef: string }
  | { status: "declined"; message: string }
  | { status: "unknown"; message: string };

export interface ChargeRequest {
  externalRequestId: string;
  amountCents: number;
  deviceId: string;
  manualEntry?: boolean;
}

export interface PaymentGateway {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeOutcome>;
  /** Look up a charge by the externalRequestId fixed before it started. */
  lookup(externalRequestId: string): Promise<ChargeOutcome>;
  refund(request: { externalRequestId: string; gatewayRef: string; amountCents: number }): Promise<RefundOutcome>;
}

export function centsToGatewayAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("amount must be positive integer cents");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Deterministic fake for tests and local dev. Behaviour is scripted per externalRequestId. */
export class FakePaymentGateway implements PaymentGateway {
  readonly name = "fake";
  readonly charges = new Map<string, ChargeOutcome>();
  readonly chargeCalls: ChargeRequest[] = [];
  readonly refundCalls: { externalRequestId: string; gatewayRef: string; amountCents: number }[] = [];
  /** Next outcome for charge(); defaults to approved. */
  nextCharge: "approved" | "declined" | "timeout" = "approved";
  /** What lookup() reveals for a timed-out charge. */
  settleTimeoutsAs: "approved" | "declined" | "unknown" = "approved";

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.chargeCalls.push(request);
    const ref = `fake_${request.externalRequestId}`;
    if (this.nextCharge === "approved") {
      const outcome: ChargeOutcome = { status: "approved", gatewayRef: ref, cardSummary: "VISA ****4242", authCode: "OK" };
      this.charges.set(request.externalRequestId, outcome);
      return outcome;
    }
    if (this.nextCharge === "declined") {
      const outcome: ChargeOutcome = { status: "declined", message: "Card declined" };
      this.charges.set(request.externalRequestId, outcome);
      return outcome;
    }
    const settled: ChargeOutcome =
      this.settleTimeoutsAs === "approved"
        ? { status: "approved", gatewayRef: ref, cardSummary: "VISA ****4242", authCode: "OK" }
        : this.settleTimeoutsAs === "declined"
          ? { status: "declined", message: "Card declined" }
          : { status: "unknown", message: "still processing" };
    this.charges.set(request.externalRequestId, settled);
    return { status: "unknown", message: "terminal timed out" };
  }

  async lookup(externalRequestId: string): Promise<ChargeOutcome> {
    return this.charges.get(externalRequestId) ?? { status: "unknown", message: "no such transaction" };
  }

  async refund(request: { externalRequestId: string; gatewayRef: string; amountCents: number }): Promise<RefundOutcome> {
    this.refundCalls.push(request);
    return { status: "approved", gatewayRef: `refund_${request.externalRequestId}` };
  }
}

const SOFTWARE_NAME = "POS Platform";
const SOFTWARE_VERSION = "0.1.0";

interface CardknoxConfig {
  apiKey: string;
  deviceApiBaseUrl?: string;
  gatewayBaseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Cardknox / Sola CloudIM, ported from functions/src/solaDevice.js and the
 * solaDeviceSale / solaDeviceResult / solaRefund handlers. Result codes:
 * A approved, D declined, E error, I in progress.
 */
export class CardknoxGateway implements PaymentGateway {
  readonly name = "cardknox";
  private readonly fetch: typeof fetch;

  constructor(private readonly config: CardknoxConfig) {
    this.fetch = config.fetchImpl ?? fetch;
  }

  private get deviceBase() {
    return this.config.deviceApiBaseUrl ?? "https://device.cardknox.com/v2";
  }

  private get gatewayBase() {
    return this.config.gatewayBaseUrl ?? "https://x1.cardknox.com";
  }

  private async post(url: string, body: unknown, auth?: string): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data: Record<string, unknown> = {};
      try {
        data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        data = { xError: text };
      }
      return { ok: response.ok, data };
    } finally {
      clearTimeout(timer);
    }
  }

  static interpret(data: Record<string, unknown>): ChargeOutcome | { status: "pending" } {
    const result = String(data.xResult ?? "").toUpperCase();
    const status = String(data.xStatus ?? "").trim().toLowerCase();
    if (result === "A" || status === "approved") {
      const masked = String(data.xMaskedCardNumber ?? "");
      const type = String(data.xCardType ?? "");
      return {
        status: "approved",
        gatewayRef: String(data.xRefnum ?? data.xRefNum ?? ""),
        cardSummary: masked ? `${type || "card"} ${masked}`.trim() : null,
        authCode: data.xAuthCode ? String(data.xAuthCode) : null,
      };
    }
    if (result === "D" || status === "declined") return { status: "declined", message: String(data.xError ?? "Declined") };
    if (result === "I" || status === "inprogress" || status === "in progress") return { status: "pending" };
    return { status: "unknown", message: String(data.xError ?? (status || "unknown")) };
  }

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    try {
      const start = await this.post(
        `${this.deviceBase}/session/async`,
        {
          xKey: this.config.apiKey,
          xDeviceId: request.deviceId,
          xCommand: "cc:sale",
          xAmount: centsToGatewayAmount(request.amountCents),
          xExternalRequestId: request.externalRequestId.slice(0, 32),
          xSoftwareName: SOFTWARE_NAME,
          xSoftwareVersion: SOFTWARE_VERSION,
          ...(request.manualEntry ? { xManualEntry: true } : {}),
        },
        this.config.apiKey,
      );
      if (!start.ok) {
        // A rejected *start* (bad device id, bad key) never reached the card, but
        // we still verify rather than assume, so the caller treats it as unknown.
        return { status: "unknown", message: String(start.data.xError ?? "terminal session could not start") };
      }
    } catch (error) {
      return { status: "unknown", message: `terminal unreachable: ${(error as Error).message}` };
    }
    return this.poll(request.externalRequestId);
  }

  private async poll(externalRequestId: string): Promise<ChargeOutcome> {
    const deadline = Date.now() + (this.config.pollTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      const outcome = await this.lookupOnce(externalRequestId);
      if (outcome.status !== "pending") return outcome;
      await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs ?? 2_000));
    }
    return { status: "unknown", message: "terminal did not finish in time" };
  }

  private async lookupOnce(externalRequestId: string): Promise<ChargeOutcome | { status: "pending" }> {
    try {
      const result = await this.post(
        `${this.deviceBase}/session/result`,
        { xKey: this.config.apiKey, xExternalRequestId: externalRequestId.slice(0, 32) },
        this.config.apiKey,
      );
      if (!result.ok) return { status: "unknown", message: String(result.data.xError ?? "lookup failed") };
      return CardknoxGateway.interpret(result.data);
    } catch (error) {
      return { status: "unknown", message: (error as Error).message };
    }
  }

  async lookup(externalRequestId: string): Promise<ChargeOutcome> {
    const outcome = await this.lookupOnce(externalRequestId);
    return outcome.status === "pending" ? { status: "unknown", message: "still in progress" } : outcome;
  }

  async refund(request: { externalRequestId: string; gatewayRef: string; amountCents: number }): Promise<RefundOutcome> {
    try {
      const result = await this.post(`${this.gatewayBase}/gatewayjson`, {
        xKey: this.config.apiKey,
        xVersion: "5.0.0",
        xSoftwareName: SOFTWARE_NAME,
        xSoftwareVersion: SOFTWARE_VERSION,
        xCommand: "cc:refund",
        xAmount: centsToGatewayAmount(request.amountCents),
        xRefNum: request.gatewayRef,
        xInvoice: request.externalRequestId.slice(0, 32),
      });
      const status = String(result.data.xResult ?? result.data.xStatus ?? "").toLowerCase();
      if (result.ok && (status === "a" || status === "approved")) {
        return { status: "approved", gatewayRef: String(result.data.xRefNum ?? "") };
      }
      if (status === "d" || status === "declined" || status === "e" || status === "error") {
        return { status: "declined", message: String(result.data.xError ?? "refund declined") };
      }
      return { status: "unknown", message: String(result.data.xError ?? "refund outcome unknown") };
    } catch (error) {
      return { status: "unknown", message: (error as Error).message };
    }
  }
}
